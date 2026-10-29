import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export type MetricsAcquisitionCode =
  | "installation_identity" | "invalid_credentials" | "invalid_response"
  | "report_gap" | "incomplete_download" | "request_failed" | "request_timeout";

export class MetricsAcquisitionError extends Error {
  constructor(readonly code: MetricsAcquisitionCode, readonly retryable: boolean) {
    super(`Metrics acquisition failed: ${code}`);
    this.name = "MetricsAcquisitionError";
  }
}

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const installationSchema = z.object({
  id: positiveId,
  account: z.object({ id: positiveId, login: z.string(), type: z.literal("Organization") }),
  target_type: z.literal("Organization"),
  suspended_at: z.string().nullable().optional(),
});
const tokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });
const reportSchema = z.object({
  report_day: z.iso.date(),
  download_links: z.array(z.string().url()).min(1).max(1000),
});
const MAX_PART_BYTES = 128 * 1024 * 1024;
const MAX_DAY_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

interface ProviderOptions {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  correlationId?: string;
}

function safeOrganization(value: string): string {
  if (value.length > 39 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) {
    throw new MetricsAcquisitionError("installation_identity", false);
  }
  return value.toLowerCase();
}

function downloadUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  // Signed report URLs are data-plane requests, never authenticated API requests.
  const allowed = host.endsWith(".github.com") ||
    host.endsWith(".blob.core.windows.net") || host.endsWith(".githubusercontent.com");
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new MetricsAcquisitionError("invalid_response", false);
  }
  return url;
}

async function readBytes(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new MetricsAcquisitionError("incomplete_download", false);
      chunks.push(next.value);
    }
    if (signal.aborted) throw new MetricsAcquisitionError("request_timeout", true);
    // Fetch transparently decodes HTTP content-encoding; its Content-Length is then the wire size.
    if (!response.headers.has("content-encoding")) {
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) {
        throw new MetricsAcquisitionError("incomplete_download", true);
      }
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class GitHubMetricsProvider {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly correlationId: string;
  private readonly installations = new Map<string, z.infer<typeof installationSchema>>();

  constructor(private readonly options: ProviderOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? (() => new Date());
    this.correlationId = z.uuid().parse(options.correlationId ?? randomUUID());
  }

  private jwt(): string {
    try {
      if (!/^[0-9]*[1-9][0-9]*$/.test(this.options.appId)) throw new Error("Invalid App ID");
      const key = createPrivateKey(this.options.privateKey);
      if (key.asymmetricKeyType !== "rsa") throw new Error("App key must be RSA");
      const now = Math.floor(this.now().valueOf() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.options.appId })).toString("base64url");
      const unsigned = `${header}.${payload}`;
      return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
    } catch {
      throw new MetricsAcquisitionError("invalid_credentials", false);
    }
  }

  private async request(
    url: string, init: RequestInit, limit: number,
    validate: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
  ): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const response = await this.fetcher(url, { ...init, redirect: "error", signal: controller.signal });
            if (response.status === 204 || response.status === 404) {
              await response.body?.cancel();
              throw new MetricsAcquisitionError("report_gap", true);
            }
            if (!response.ok) {
              await response.body?.cancel();
              const retryable = response.status === 429 || response.status >= 500 ||
                (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
              throw new MetricsAcquisitionError("request_failed", retryable);
            }
            return validate(await readBytes(response, controller.signal, limit));
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new MetricsAcquisitionError("request_timeout", true));
              controller.abort();
            }, REQUEST_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        const failure = error instanceof MetricsAcquisitionError
          ? error : new MetricsAcquisitionError("request_failed", true);
        // Missing/not-ready reports retry on a later run, never as a successful empty day.
        if (!failure.retryable || failure.code === "report_gap" || attempt === 2) {
          throw failure;
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
      await this.sleep(250 * 2 ** attempt);
    }
    throw new MetricsAcquisitionError("request_failed", true);
  }

  private async api(path: string, token: string, method = "GET"): Promise<unknown> {
    const bytes = await this.request(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2026-03-10", "user-agent": "copilot-metrics-ingestion",
        "x-correlation-id": this.correlationId,
      },
    }, 1024 * 1024);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new MetricsAcquisitionError("invalid_response", false);
    }
  }

  async resolveOrganization(organization: string): Promise<number> {
    const org = safeOrganization(organization);
    const cached = this.installations.get(org);
    if (cached) return cached.account.id;
    const result = installationSchema.safeParse(await this.api(`/orgs/${org}/installation`, this.jwt()));
    if (!result.success || result.data.account.login.toLowerCase() !== org || result.data.suspended_at) {
      throw new MetricsAcquisitionError("installation_identity", false);
    }
    this.installations.set(org, result.data);
    return result.data.account.id;
  }

  async acquire(organization: string, reportDay: string): Promise<{ organizationId: number; content: Uint8Array }> {
    if (!z.iso.date().safeParse(reportDay).success) throw new MetricsAcquisitionError("invalid_response", false);
    const org = safeOrganization(organization);
    const organizationId = await this.resolveOrganization(org);
    const installation = this.installations.get(org)!;
    const token = tokenSchema.safeParse(await this.api(`/app/installations/${installation.id}/access_tokens`, this.jwt(), "POST"));
    if (!token.success || Date.parse(token.data.expires_at) <= this.now().valueOf()) {
      throw new MetricsAcquisitionError("invalid_credentials", false);
    }
    const report = reportSchema.safeParse(await this.api(
      `/orgs/${org}/copilot/metrics/reports/users-1-day?day=${reportDay}`, token.data.token,
    ));
    if (!report.success || report.data.report_day !== reportDay) {
      throw new MetricsAcquisitionError("invalid_response", true);
    }
    const urls = report.data.download_links.map(downloadUrl);
    if (new Set(urls.map(String)).size !== urls.length) throw new MetricsAcquisitionError("invalid_response", false);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const url of urls) {
      const bytes = await this.request(
        url.toString(), { headers: { accept: "application/x-ndjson" } }, MAX_PART_BYTES, (part) => {
          if (part[0] === 0x1f && part[1] === 0x8b) {
            try {
              part = new Uint8Array(gunzipSync(part, { maxOutputLength: MAX_PART_BYTES }));
            } catch (error) {
              const exceedsLimit = error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
              throw new MetricsAcquisitionError("incomplete_download", !exceedsLimit);
            }
          }
          if (part.byteLength === 0 || part.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte === 32)) {
            throw new MetricsAcquisitionError("incomplete_download", true);
          }
          return part;
        },
      );
      total += bytes.byteLength + (bytes.at(-1) === 10 ? 0 : 1);
      if (total > MAX_DAY_BYTES) throw new MetricsAcquisitionError("incomplete_download", false);
      parts.push(bytes);
      if (bytes.at(-1) !== 10) parts.push(new Uint8Array([10]));
    }
    return { organizationId, content: new Uint8Array(Buffer.concat(parts, total)) };
  }
}
