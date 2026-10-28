import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalSignInUrl,
  getLocalE2EPort,
  SIGN_IN_READINESS_TIMEOUT_MS,
  waitForLocalSignInRoute,
} from "./route-readiness";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("local sign-in route readiness", () => {
  it("builds only the fixed local sign-in URL and validates its port", () => {
    expect(buildLocalSignInUrl("127.0.0.1", "3107").href).toBe("http://127.0.0.1:3107/sign-in");
    expect(getLocalE2EPort()).toBe(3100);
    expect(getLocalE2EPort("3107")).toBe(3107);
    expect(() => buildLocalSignInUrl("example.invalid", "3107")).toThrow("loopback");
    expect(() => buildLocalSignInUrl("127.0.0.1", "65536")).toThrow("E2E_PORT");
    expect(() => getLocalE2EPort("3100/path")).toThrow("E2E_PORT");
  });

  it("makes one manual-redirect GET and consumes the complete 200 body", async () => {
    let bodyPulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyPulled = true;
        controller.enqueue(new TextEncoder().encode("private response body"));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(waitForLocalSignInRoute("127.0.0.1", 3107, fetcher)).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3107/sign-in"),
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(bodyPulled).toBe(true);

    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>);
    expect(events.map((event) => event.event)).toEqual(["e2e.sign-in-readiness.start", "e2e.sign-in-readiness.complete"]);
    expect(events[1]).toMatchObject({
      status: 200,
      headerLatencyMs: expect.any(Number),
      totalMs: expect.any(Number),
      bodyCompletionMs: expect.any(Number),
    });
    expect(log.mock.calls.flat().join(" ")).not.toContain("private response body");
  });

  it.each([
    ["same-origin redirect", "http://127.0.0.1:3107/no-access"],
    ["off-loopback redirect", "https://example.invalid/"],
  ])("rejects a %s without following it", async (_label, location) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 302, headers: { location } }),
    );

    await expect(waitForLocalSignInRoute("127.0.0.1", 3107, fetcher)).rejects.toThrow("HTTP 302");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects non-200 responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(waitForLocalSignInRoute("127.0.0.1", 3107, fetcher)).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("propagates a truncated or aborted body failure", async () => {
    const bodyFailure = new TypeError("synthetic response stream terminated");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(bodyFailure);
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(waitForLocalSignInRoute("127.0.0.1", 3107, fetcher)).rejects.toBe(bodyFailure);
  });

  it("bounds the single request by the separate startup deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    );
    const readiness = waitForLocalSignInRoute("127.0.0.1", 3107, fetcher);

    const rejection = expect(readiness).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(SIGN_IN_READINESS_TIMEOUT_MS);
    await rejection;
    expect(SIGN_IN_READINESS_TIMEOUT_MS).toBe(45_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("applies the same deadline while consuming the response body", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
    }), { status: 200 }));
    const readiness = waitForLocalSignInRoute("127.0.0.1", 3107, fetcher);

    const rejection = expect(readiness).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(SIGN_IN_READINESS_TIMEOUT_MS);
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves connection-refused and interrupted request errors", async () => {
    const connectionFailure = new TypeError("fetch failed: ECONNREFUSED");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(connectionFailure);

    await expect(waitForLocalSignInRoute("127.0.0.1", 3107, fetcher)).rejects.toBe(connectionFailure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
