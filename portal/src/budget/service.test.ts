import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetLookupRequest } from "../../../shared/src/api";
import { resolveBudgetLookupRequestAccess } from "./request-access";
import { createBudgetLookupClient } from "./client";
import { lookupBudget } from "./service";

vi.mock("./request-access", () => ({ resolveBudgetLookupRequestAccess: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({
  BudgetLookupSourceError: class BudgetLookupSourceError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
  createBudgetLookupClient: vi.fn(),
}));

const request: BudgetLookupRequest = { target: "self" };

describe("Budget Lookup service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BUDGET_LOOKUP_KEY", "synthetic-token");
    vi.stubEnv("ENTERPRISE_SLUG", "example-enterprise");
  });

  it("does not construct a source client until authorization succeeds", async () => {
    vi.mocked(resolveBudgetLookupRequestAccess).mockResolvedValue({ state: "forbidden" });

    await expect(lookupBudget("correlation", request)).resolves.toEqual({ state: "forbidden" });
    expect(createBudgetLookupClient).not.toHaveBeenCalled();
  });

  it("reads uncached source data only for the authorized resolved login", async () => {
    vi.mocked(resolveBudgetLookupRequestAccess).mockResolvedValue({
      state: "authorized",
      login: "octo-user",
      userId: 123,
    });
    const read = vi.fn().mockResolvedValue({
      individualBudgets: [],
      defaultPerUserBudgets: [],
      effectiveBudget: null,
    });
    vi.mocked(createBudgetLookupClient).mockReturnValue({ read } as ReturnType<typeof createBudgetLookupClient>);

    const first = await lookupBudget("correlation-1", request);
    const second = await lookupBudget("correlation-2", request);

    expect(first).toEqual(second);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, "octo-user", undefined);
    expect(createBudgetLookupClient).toHaveBeenCalledWith({
      token: "synthetic-token",
      enterprise: "example-enterprise",
      onPermissionObservation: expect.any(Function),
    });
  });

  it("reports missing source credentials instead of constructing an empty result", async () => {
    vi.mocked(resolveBudgetLookupRequestAccess).mockResolvedValue({
      state: "authorized",
      login: "octo-user",
      userId: 123,
    });
    vi.stubEnv("BUDGET_LOOKUP_KEY", "");

    await expect(lookupBudget("correlation", request)).rejects.toMatchObject({
      code: "budget_source_unavailable",
    });
    expect(createBudgetLookupClient).not.toHaveBeenCalled();
  });
});
