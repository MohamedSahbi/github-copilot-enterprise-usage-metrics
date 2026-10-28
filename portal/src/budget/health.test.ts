import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./request-access", () => ({ resolveBudgetLookupRequestAccess: mocks.access }));

describe("Budget Lookup historical instance-local health", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.access.mockReset();
    mocks.access.mockResolvedValue({ state: "authorized", login: "octo-user", userId: 123 });
    vi.stubEnv("BUDGET_LOOKUP_KEY", "synthetic-secret-never-returned");
    vi.stubEnv("ENTERPRISE_SLUG", "example-enterprise");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts unknown and serializes only secret presence, never credentials", async () => {
    const { readBudgetLookupHealth } = await import("./health");
    expect(readBudgetLookupHealth()).toEqual({
      credentialConfigured: true,
      permission: { state: "unobserved", observedAt: null },
    });
    expect(JSON.stringify(readBudgetLookupHealth())).not.toContain("synthetic-secret");
    vi.stubEnv("BUDGET_LOOKUP_KEY", "");
    expect(readBudgetLookupHealth().credentialConfigured).toBe(false);
  });

  it("does not read credentials, call the source or record observations when authorization fails", async () => {
    mocks.access.mockResolvedValue({ state: "forbidden" });
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const health = await import("./health");
    const observe = vi.spyOn(health, "recordBudgetLookupPermission");
    const { lookupBudget } = await import("./service");
    const env = process.env;
    const credentialReads = vi.fn();
    const observedEnv = new Proxy(env, {
      get(target, property) {
        if (property === "BUDGET_LOOKUP_KEY") credentialReads();
        return Reflect.get(target, property);
      },
    });
    vi.stubGlobal("process", new Proxy(process, {
      get(target, property) {
        return property === "env" ? observedEnv : Reflect.get(target, property);
      },
    }));

    await expect(lookupBudget("synthetic-correlation", { target: "self" }))
      .resolves.toEqual({ state: "forbidden" });
    expect(credentialReads).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([200, 401, 403] as const)("records only actual authorized GET %s observations", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      status === 200
        ? JSON.stringify({ budgets: [], has_next_page: false, total_count: 0, user: "octo-user" })
        : null,
      { status },
    ));
    vi.stubGlobal("fetch", fetchImpl);
    const { lookupBudget } = await import("./service");
    const { readBudgetLookupHealth } = await import("./health");
    if (status === 200) {
      await lookupBudget("synthetic-correlation", { target: "self" });
    } else {
      await expect(lookupBudget("synthetic-correlation", { target: "self" }))
        .rejects.toMatchObject({ code: "budget_source_unavailable" });
    }
    const result = readBudgetLookupHealth();
    expect(result.permission.state).toBe(status === 200 ? "allowed" : "denied");
    expect(result.permission.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(fetchImpl).toHaveBeenCalled();
    for (const [, init] of fetchImpl.mock.calls) expect(init?.method).toBe("GET");
  });

  it.each([429, 500, "transport"] as const)("retains historical evidence on unrelated failure %s", async (failure) => {
    const health = await import("./health");
    health.recordBudgetLookupPermission(200);
    const historical = health.readBudgetLookupHealth();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (failure === "transport") throw new TypeError("synthetic transport failure");
      return new Response(null, { status: failure });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const { lookupBudget } = await import("./service");
    await expect(lookupBudget("synthetic-correlation", { target: "self" })).rejects.toThrow();
    expect(health.readBudgetLookupHealth()).toEqual(historical);
  });
});
