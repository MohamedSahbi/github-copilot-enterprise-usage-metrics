import { describe, expect, it } from "vitest";
import {
  BUDGET_SOURCE_ERROR_STATUS,
  parseBudgetLookupRequest,
  validateBudgetLookupRequest,
} from "./api";
import type {
  BudgetLookupErrorResponse,
  BudgetLookupResponse,
  BudgetLookupSourceErrorCode,
} from "./api";
import { exactDecimal18_9 } from "./decimal";
import {
  BUDGET_LOOKUP_TIMEOUT_MS,
  budgetLookupDataSchema,
  budgetLookupSourceClassificationSchema,
  validateBudgetLookupPage,
  validateBudgetLookupTarget,
} from "./budget";

describe("Budget MVP request boundary", () => {
  it("normalizes an omitted query to authenticated self, never a caller identity", () => {
    expect(parseBudgetLookupRequest(new URLSearchParams())).toEqual({
      ok: true, request: { target: "self" },
    });
    expect(validateBudgetLookupRequest({ target: "self" })).toEqual({
      ok: true, request: { target: "self" },
    });
  });

  it("normalizes only a positive safe numeric target", () => {
    expect(parseBudgetLookupRequest(new URLSearchParams("userId=123"))).toEqual({
      ok: true, request: { target: "user", userId: 123 },
    });
    expect(validateBudgetLookupRequest({ target: "user", userId: 123 })).toEqual({
      ok: true, request: { target: "user", userId: 123 },
    });
  });

  it.each([
    "userId=0", "userId=-1", "userId=1.5", "userId=9007199254740992",
    "userId=1e2", "userId=0x10", "userId=+123", "userId=%20123", "userId=",
    "userId=123&userId=123", "userId=123&scope=company",
    "target=self", "root=123", "login=%7Blogin%7D", "email=%7Bemail%7D",
    "costCenterName=%7Bcenter%7D", "unknown=value",
  ])("rejects invalid, ambiguous or authority-bearing URL input: %s", (query) => {
    expect(parseBudgetLookupRequest(new URLSearchParams(query))).toEqual({
      ok: false, code: "invalid_request",
    });
  });

  it.each([
    null, [], {}, { userId: 123 }, { target: "user" }, { target: "self", userId: 123 },
    { target: "user", userId: "123" }, { target: "user", userId: 0 },
    { target: "user", userId: Number.NaN }, { target: "user", userId: Infinity },
    { target: "user", userId: Number.MAX_SAFE_INTEGER + 1 },
    { target: "self", login: "{login}" }, { target: "cost_center", costCenterName: "{center}" },
    Object.assign(Object.create({ target: "self" }), { extra: true }),
  ])("rejects invalid normalized input: %o", (request) => {
    expect(validateBudgetLookupRequest(request)).toEqual({ ok: false, code: "invalid_request" });
  });
});

describe("Budget MVP response contract", () => {
  it("keeps separate exact USD records and source effective allocation without conversion", () => {
    const response: BudgetLookupResponse = {
      meta: { correlationId: "test", generatedAt: "2026-10-26T00:00:00Z", minGroupSize: 5, metricVersion: 1 },
      data: {
        userId: 123,
        amountUnit: "USD",
        cycle: "calendar_month_utc",
        budgets: [
          {
            id: "individual", kind: "individual", amount: "999999999.999999999",
            consumedAmount: { status: "reported", amount: "42.500000009", unit: "USD" },
            expiresAt: "2026-10-31",
          },
          {
            id: "default", kind: "default_per_user", amount: "100",
            consumedAmount: { status: "not_reported" }, expiresAt: null,
          },
        ],
        effectiveBudget: {
          status: "reported", budgetId: "individual", amount: "999999999.999999999",
          consumedAmount: { status: "reported", amount: "42.500000009", unit: "USD" },
        },
      },
    };
    expect(response.data.budgets.map((budget) => exactDecimal18_9(budget.amount)))
      .toEqual(["999999999.999999999", "100"]);
    expect(response.data.budgets[0]!.consumedAmount)
      .toEqual({ status: "reported", amount: "42.500000009", unit: "USD" });
    expect(response.data.budgets[1]!.consumedAmount).toEqual({ status: "not_reported" });
    expect(response.data.effectiveBudget.status).toBe("reported");
  });

  it("distinguishes absent effective metadata, out-of-MVP allocation and reported zero", () => {
    const cases: BudgetLookupResponse["data"]["effectiveBudget"][] = [
      { status: "not_reported" },
      { status: "outside_mvp" },
      {
        status: "reported", budgetId: "individual", amount: "0",
        consumedAmount: { status: "reported", amount: "0", unit: "USD" },
      },
    ];
    expect(cases.map((value) => value.status)).toEqual(["not_reported", "outside_mvp", "reported"]);
    expect(cases[1]).toEqual({ status: "outside_mvp" });
  });

  it.each([
    "budget_source_unavailable", "budget_source_timeout", "budget_source_invalid",
    "budget_source_incomplete",
  ] satisfies BudgetLookupSourceErrorCode[])("represents %s as an error, not no-budget success", (code) => {
    const response: BudgetLookupErrorResponse = {
      error: { code, message: "Budget source failed.", correlationId: "test" },
    };
    expect(response).not.toHaveProperty("data");
    expect(response.error.code).toBe(code);
    expect(response.error.correlationId).toBe("test");
    expect(BUDGET_SOURCE_ERROR_STATUS[code]).toBe(
      code === "budget_source_unavailable" ? 503 : code === "budget_source_timeout" ? 504 : 502,
    );
  });

  it("validates canonical exact USD amounts and rejects deferred or identity-ambiguous success", () => {
    const data = {
      userId: 123, amountUnit: "USD", cycle: "calendar_month_utc",
      budgets: [{
        id: "individual", kind: "individual", amount: "1.2500",
        consumedAmount: { status: "reported", amount: "0.000000009", unit: "USD" },
        expiresAt: null,
      }],
      effectiveBudget: {
        status: "reported", budgetId: "individual", amount: "1.2500",
        consumedAmount: { status: "reported", amount: "0.000000009", unit: "USD" },
      },
    };
    expect(budgetLookupDataSchema.parse(data).budgets[0]!.amount).toBe("1.25");
    for (const invalid of [
      { ...data, userId: null },
      { ...data, amountUnit: "AI_CREDITS" },
      { ...data, costCenterName: "{center}" },
      { ...data, effectiveBudget: { status: "outside_mvp", budgetId: "hidden" } },
      { ...data, effectiveBudget: { ...data.effectiveBudget, budgetId: "other" } },
      { ...data, budgets: [data.budgets[0], data.budgets[0]] },
      { ...data, budgets: [{ ...data.budgets[0], amount: "1000000000" }] },
      { ...data, budgets: [{ ...data.budgets[0], amount: 1.25 }] },
      { ...data, budgets: [{ ...data.budgets[0], amount: "0.0000000001" }] },
      { ...data, budgets: [{ ...data.budgets[0], kind: "cost_center" }] },
      { ...data, budgets: [{ ...data.budgets[0], kind: "default_per_user", expiresAt: "2026-10-31" }] },
      { ...data, budgets: [{ ...data.budgets[0], expiresAt: "2026-02-30" }] },
    ]) {
      expect(budgetLookupDataSchema.safeParse(invalid).success).toBe(false);
    }
  });

  describe("Budget source classification contract", () => {
    it.each(["user", "multi_user_customer"])("supports only the exact AI-credit bundle in %s scope", (scope) => {
      expect(budgetLookupSourceClassificationSchema.safeParse({
        budget_scope: scope, budget_type: "BundlePricing", budget_product_sku: "ai_credits",
      }).success).toBe(true);
    });

    it.each([
      { budget_scope: "cost_center", budget_type: "BundlePricing", budget_product_sku: "ai_credits" },
      { budget_scope: "multi_user_cost_center", budget_type: "BundlePricing", budget_product_sku: "ai_credits" },
      { budget_scope: "enterprise", budget_type: "BundlePricing", budget_product_sku: "ai_credits" },
      { budget_scope: "user", budget_type: "SkuPricing", budget_product_sku: "ai_credits" },
      { budget_scope: "user", budget_type: "ProductPricing", budget_product_sku: "copilot" },
      { budget_scope: "user", budget_type: "BundlePricing", budget_product_sku: "premium_requests" },
      { budget_scope: "user", budget_type: "BundlePricing", budget_product_skus: ["ai_credits"] },
    ])("does not guess classification from an unsupported source: %o", (source) => {
      expect(budgetLookupSourceClassificationSchema.safeParse(source).success).toBe(false);
    });
  });
});

describe("Budget target contract over trusted server-resolved access", () => {
  const access = { state: "authorized" as const, selfUserId: 123, authorizedUserIds: [201, 202] };
  const context = { moduleEnabled: true, perUserDetailEnabled: false, access };

  it("permits only uniquely resolved self with the Budget-only detail exception", () => {
    expect(validateBudgetLookupTarget({ target: "self" }, context)).toEqual({ ok: true, userId: 123 });
    expect(validateBudgetLookupTarget({ target: "user", userId: 123 }, context))
      .toEqual({ ok: true, userId: 123 });
  });

  it("requires both population membership and detail opt-in for other targets", () => {
    for (const userId of [201, 202]) {
      expect(validateBudgetLookupTarget({ target: "user", userId }, context))
        .toEqual({ ok: false, code: "per_user_detail_disabled" });
      expect(validateBudgetLookupTarget({ target: "user", userId }, { ...context, perUserDetailEnabled: true }))
        .toEqual({ ok: true, userId });
    }
    expect(validateBudgetLookupTarget({ target: "user", userId: 999 }, { ...context, perUserDetailEnabled: true }))
      .toEqual({ ok: false, code: "forbidden" });
  });

  it("has no role-based bypass of actual server populations", () => {
    for (const population of [[201, 202], [301], [401, 402]]) {
      const scoped = { ...context, perUserDetailEnabled: true, access: { ...access, authorizedUserIds: population } };
      expect(validateBudgetLookupTarget({ target: "user", userId: population[0]! }, scoped).ok).toBe(true);
      expect(validateBudgetLookupTarget({ target: "user", userId: 999 }, scoped))
        .toEqual({ ok: false, code: "forbidden" });
    }
  });

  it("never lets self or a module flag replace missing grant/link/freshness evidence", () => {
    for (const state of ["unauthenticated", "forbidden", "permissions_unavailable"] as const) {
      expect(validateBudgetLookupTarget({ target: "self" }, { ...context, access: { state } }))
        .toEqual({ ok: false, code: state });
    }
    expect(validateBudgetLookupTarget({ target: "self" }, { ...context, moduleEnabled: false }))
      .toEqual({ ok: false, code: "module_disabled" });
    expect(validateBudgetLookupTarget({ target: "self" }, { ...context, access: { ...access, selfUserId: 0 } }))
      .toEqual({ ok: false, code: "permissions_unavailable" });
  });
});

describe("Budget complete-page contract (raw IDs before filtering)", () => {
  it("bounds the entire provider sequence to ten seconds, not ten seconds per page", () => {
    expect(BUDGET_LOOKUP_TIMEOUT_MS).toBe(10_000);
  });

  it("requires all raw records and stable totals, not filtered record counts", () => {
    const first = validateBudgetLookupPage({ ids: ["supported", "other-product"], hasNextPage: true, totalCount: 3 }, null);
    expect(first).toEqual({ ok: true, progress: { ids: ["supported", "other-product"], totalCount: 3, pages: 1, complete: false } });
    if (!first.ok) throw new Error("Expected first page");
    expect(validateBudgetLookupPage({ ids: ["third"], hasNextPage: false, totalCount: 3 }, first.progress))
      .toEqual({ ok: true, progress: { ids: ["supported", "other-product", "third"], totalCount: 3, pages: 2, complete: true } });
    expect(validateBudgetLookupPage({ ids: [], hasNextPage: false, totalCount: 0 }, null).ok).toBe(true);
  });

  it.each([
    { ids: [], totalCount: 0 },
    { ids: [], hasNextPage: false },
    { ids: ["a"], hasNextPage: false, totalCount: 2 },
    { ids: ["a"], hasNextPage: true, totalCount: 1 },
    { ids: [], hasNextPage: true, totalCount: 1 },
    { ids: ["a", "a"], hasNextPage: false, totalCount: 2 },
    { ids: ["a"], hasNextPage: false, totalCount: -1 },
    { ids: ["a"], hasNextPage: false, totalCount: Number.MAX_SAFE_INTEGER + 1 },
  ])("fails rather than returns partial or ambiguous success: %o", (page) => {
    expect(validateBudgetLookupPage(page, null)).toEqual({ ok: false, code: "budget_source_incomplete" });
  });

  it("rejects repeated pages, count drift, requests after completion, and page-cap truncation", () => {
    const previous = { ids: ["a"], totalCount: 2, pages: 1, complete: false };
    for (const [page, progress] of [
      [{ ids: ["a"], totalCount: 2, hasNextPage: false }, previous],
      [{ ids: ["b"], totalCount: 3, hasNextPage: false }, previous],
      [{ ids: ["b"], totalCount: 2, hasNextPage: false }, { ...previous, complete: true }],
      [{ ids: ["b"], totalCount: 2, hasNextPage: false }, { ...previous, pages: 100 }],
      [{ ids: ["b"], totalCount: 3, hasNextPage: true }, { ...previous, totalCount: 3, pages: 99 }],
    ] as const) {
      expect(validateBudgetLookupPage(page, progress)).toEqual({ ok: false, code: "budget_source_incomplete" });
    }
  });
});
