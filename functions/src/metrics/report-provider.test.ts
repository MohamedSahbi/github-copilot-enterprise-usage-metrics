import { generateKeyPairSync, verify } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { GitHubMetricsProvider, MetricsAcquisitionError } from "./report-provider.js";
import dailyReport from "./fixtures/users-1-day-response.json";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const day = "2026-10-25";
const link = "https://reports.blob.core.windows.net/reports/part?sig=SECRET_MARKER";
const installation = { id: 42, account: { id: 123, login: "fixture-org", type: "Organization" }, target_type: "Organization" };
const manifest = dailyReport;

function harness(responses: (Response | Error)[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
  const provider = new GitHubMetricsProvider({
    appId: "17", privateKey: pem, fetch: fetcher, sleep,
    now: () => new Date("2026-10-26T01:00:00Z"),
  });
  return { provider, fetcher, sleep };
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const auth = () => [json(installation), json({ token: "INSTALLATION_SECRET", expires_at: "2026-10-26T02:00:00Z" })];

describe("GitHub App daily report acquisition", () => {
  it("discovers installation, signs RS256 JWT, and downloads every manifest part without credentials", async () => {
    const h = harness([...auth(), json({ ...manifest, download_links: [link, `${link}&part=2`] }),
      new Response('{"one":1}'), new Response('{"two":2}\n')]);
    const result = await h.provider.acquire("fixture-org", day);
    expect(result.organizationId).toBe(123);
    expect(Buffer.from(result.content).toString()).toBe('{"one":1}\n{"two":2}\n');
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/orgs/fixture-org/installation",
      "https://api.github.com/app/installations/42/access_tokens",
      `https://api.github.com/orgs/fixture-org/copilot/metrics/reports/users-1-day?day=${day}`,
      link, `${link}&part=2`,
    ]);
    const jwt = new Headers(h.fetcher.mock.calls[0]?.[1]?.headers).get("authorization")!.slice(7);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "17" });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    for (const [, init] of h.fetcher.mock.calls.slice(3)) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
    }
  });

  it.each([
    { ...installation, account: { ...installation.account, login: "other-org" } },
    { ...installation, account: { ...installation.account, type: "User" } },
    { ...installation, target_type: "User" },
    { ...installation, account: { ...installation.account, id: 0 } },
  ])("rejects an installation identity mismatch before token minting", async (value) => {
    const h = harness([json(value)]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "installation_identity" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    json(manifest, 404), new Response(null, { status: 204 }),
    json({ ...manifest, download_links: [] }), json({ ...manifest, report_day: "2026-10-24" }),
    json({ download_urls: [link], date: day }),
  ])("rejects missing, empty, wrong-day, or speculative response shapes", async (response) => {
    const h = harness([...auth(), response]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toBeInstanceOf(MetricsAcquisitionError);
  });

  it.each(["", " \n", null])("rejects empty or partial downloaded bytes", async (body) => {
    const h = harness([...auth(), json(manifest), body === null
      ? new Response("short", { headers: { "content-length": "999" } }) : new Response(body)]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "incomplete_download" });
  });

  it("does not return the first part when a later part fails", async () => {
    const h = harness([...auth(), json({ ...manifest, download_links: [link, `${link}&part=2`] }),
      new Response("{}"), new Response(null, { status: 404 })]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "report_gap" });
  });

  it("handles a complete gzip file and rejects a truncated gzip trailer", async () => {
    const bytes = gzipSync(Buffer.from('{"fixture":1}\n'));
    const complete = harness([...auth(), json(manifest), new Response(bytes)]);
    await expect(complete.provider.acquire("fixture-org", day)).resolves.toMatchObject({
      content: new Uint8Array(Buffer.from('{"fixture":1}\n')),
    });
    const partial = harness([...auth(), json(manifest), new Response(bytes.subarray(0, bytes.length - 4))]);
    await expect(partial.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "incomplete_download" });
  });

  it("does not equate compressed HTTP content-length with automatically decoded bytes", async () => {
    const h = harness([...auth(), json(manifest), new Response('{"fixture":1}\n', {
      headers: { "content-encoding": "gzip", "content-length": "123" },
    })]);
    await expect(h.provider.acquire("fixture-org", day)).resolves.toMatchObject({ organizationId: 123 });
  });

  it("bounds transient retries and strips sensitive upstream error content", async () => {
    const h = harness([...auth(), json(manifest),
      new Error(`SECRET_MARKER ${link}`), new Error("INSTALLATION_SECRET"), new Error("PERSONAL_MARKER")]);
    let failure: unknown;
    try { await h.provider.acquire("fixture-org", day); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "request_failed", retryable: true });
    expect(String(failure)).not.toMatch(/SECRET_MARKER|INSTALLATION_SECRET|PERSONAL_MARKER/);
    expect(h.sleep.mock.calls).toEqual([[250], [500]]);
  });

  it("retries a 503 then succeeds", async () => {
    const h = harness([...auth(), new Response(null, { status: 503 }), json(manifest), new Response("{}")]);
    await expect(h.provider.acquire("FIXTURE-org", day)).resolves.toMatchObject({ organizationId: 123 });
    expect(h.sleep).toHaveBeenCalledOnce();
  });

  it("times out a stalled body and exhausts only the bounded attempts", async () => {
    vi.useFakeTimers();
    try {
      const stalled = () => new Response(new ReadableStream({ start() { /* Intentionally never completes. */ } }));
      const h = harness([...auth(), json(manifest), stalled(), stalled(), stalled()]);
      const result = expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "request_timeout" });
      await vi.runAllTimersAsync();
      await result;
      expect(h.sleep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a body stream interrupted after some bytes", async () => {
    const broken = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"part":'));
        controller.error(new Error("SOURCE_PERSONAL_MARKER"));
      },
    }));
    const h = harness([...auth(), json(manifest), broken(), broken(), broken()]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "request_failed" });
  });

  it("does not follow redirects or retry permanent permission failures", async () => {
    const h = harness([...auth(), new Response(null, { status: 403 })]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ retryable: false });
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it.each(["http://reports.blob.core.windows.net/a", "https://localhost/a", "https://reports.blob.core.windows.net.evil.invalid/a",
    "https://user:password@reports.blob.core.windows.net/a"])("rejects unsafe signed links: %s", async (url) => {
    const h = harness([...auth(), json({ ...manifest, download_links: [url] })]);
    await expect(h.provider.acquire("fixture-org", day)).rejects.toMatchObject({ code: "invalid_response" });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
});
