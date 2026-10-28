export const SIGN_IN_READINESS_TIMEOUT_MS = 45_000;

export const E2E_LOCAL_HOST = "127.0.0.1";
const SIGN_IN_PATH = "/sign-in";

type ReadinessResponse = {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

type ReadinessFetch = (
  input: URL,
  init: RequestInit,
) => Promise<ReadinessResponse>;

export function getLocalE2EPort(value = "3100"): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("E2E_PORT must be an integer port number");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_PORT must be between 1 and 65535");
  }
  return port;
}

export function buildLocalSignInUrl(host: string, port: string | number): URL {
  if (host !== E2E_LOCAL_HOST) {
    throw new Error("E2E sign-in readiness only permits the 127.0.0.1 loopback host");
  }
  const validatedPort = getLocalE2EPort(String(port));
  return new URL(`${SIGN_IN_PATH}`, `http://${E2E_LOCAL_HOST}:${validatedPort}`);
}

export async function waitForLocalSignInRoute(
  host: string,
  port: string | number,
  fetcher: ReadinessFetch = fetch,
): Promise<void> {
  const url = buildLocalSignInUrl(host, port);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const controller = new AbortController();
  let status: number | undefined;
  let headerLatencyMs: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  console.info(JSON.stringify({
    event: "e2e.sign-in-readiness.start",
    at: startedAt,
    method: "GET",
    host: E2E_LOCAL_HOST,
    port: url.port,
    path: SIGN_IN_PATH,
    timeoutMs: SIGN_IN_READINESS_TIMEOUT_MS,
  }));

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error(`Local sign-in readiness timed out after ${SIGN_IN_READINESS_TIMEOUT_MS}ms`);
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, SIGN_IN_READINESS_TIMEOUT_MS);
  });

  const request = (async () => {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    status = response.status;
    headerLatencyMs = Math.round(performance.now() - started);
    if (response.status !== 200) {
      throw new Error(`Local sign-in readiness expected HTTP 200; received HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  })();

  try {
    await Promise.race([request, timeout]);
    const bodyCompletionMs = Math.round(performance.now() - started);
    console.info(JSON.stringify({
      event: "e2e.sign-in-readiness.complete",
      at: new Date().toISOString(),
      method: "GET",
      host: E2E_LOCAL_HOST,
      port: url.port,
      path: SIGN_IN_PATH,
      status,
      headerLatencyMs,
      totalMs: bodyCompletionMs,
      bodyCompletionMs,
    }));
  } catch (error) {
    console.info(JSON.stringify({
      event: "e2e.sign-in-readiness.failure",
      at: new Date().toISOString(),
      method: "GET",
      host: E2E_LOCAL_HOST,
      port: url.port,
      path: SIGN_IN_PATH,
      status,
      headerLatencyMs,
      totalMs: Math.round(performance.now() - started),
      errorName: error instanceof Error ? error.name : typeof error,
    }));
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
