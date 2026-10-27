import { afterEach, describe, expect, it, vi } from "vitest";

const { timer, runtime, createRuntime } = vi.hoisted(() => {
  const runtime = vi.fn(async () => undefined);
  return { timer: vi.fn(), runtime, createRuntime: vi.fn(() => runtime) };
});
vi.mock("@azure/functions", () => ({ app: { timer } }));
vi.mock("./runtime.js", () => ({ createMetricsRuntimeHandler: createRuntime }));

describe("metrics Functions v4 registration", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("registers only the real metrics component with the operator-required schedule and delegates invocation", async () => {
    await import("./function.js");
    expect(createRuntime).toHaveBeenCalledWith(process.env);
    expect(timer).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledWith("metricsSync", expect.objectContaining({
      schedule: "%METRICS_SYNC_SCHEDULE%", runOnStartup: false, handler: expect.any(Function),
    }));
    const registered = timer.mock.calls[0]?.[1] as {
      handler(timer: unknown, context: unknown): Promise<void>;
    };
    const context = {
      invocationId: "00000000-0000-4000-8000-000000000001",
      info: vi.fn(), error: vi.fn(),
    };
    await registered.handler({ isPastDue: false }, context);
    expect(runtime).toHaveBeenCalledWith({ isPastDue: false }, expect.objectContaining({ invocationId: context.invocationId }));
  });
});
