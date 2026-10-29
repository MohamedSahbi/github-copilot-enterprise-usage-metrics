import { describe, expect, it } from "vitest";
import { mapBudgetLookupSource } from "./mapper";

const source = {
  individualBudgets: [
    {
      id: "individual-1",
      user: "octo-user",
      budget_type: "BundlePricing",
      budget_product_sku: "ai_credits",
      budget_scope: "user",
      budget_amount: "125.5",
      consumed_amount: "42.125",
      expires_at: "2027-01-01",
    },
    {
      id: "unrelated",
      user: "another-user",
      budget_type: "BundlePricing",
      budget_product_sku: "ai_credits",
      budget_scope: "user",
      budget_amount: "20",
    },
    {
      id: "unsupported",
      user: "octo-user",
      budget_type: "SkuPricing",
      budget_product_sku: "actions_linux",
      budget_scope: "user",
      budget_amount: "20",
    },
  ],
  defaultPerUserBudgets: [
    {
      id: "default-1",
      budget_type: "BundlePricing",
      budget_product_sku: "ai_credits",
      budget_scope: "multi_user_customer",
      budget_amount: "300",
    },
  ],
  effectiveBudget: {
    id: "individual-1",
    budget_amount: "125.5",
    consumed_amount: "42.125",
  },
};

describe("Budget Lookup source mapper", () => {
  it("returns only exact supported classifications and exact target-user matches", () => {
    expect(mapBudgetLookupSource(source, "octo-user", 123)).toEqual({
      userId: 123,
      amountUnit: "USD",
      cycle: "calendar_month_utc",
      budgets: [
        {
          id: "individual-1",
          kind: "individual",
          amount: "125.5",
          consumedAmount: { status: "reported", amount: "42.125", unit: "USD" },
          expiresAt: "2027-01-01",
        },
        {
          id: "default-1",
          kind: "default_per_user",
          amount: "300",
          consumedAmount: { status: "not_reported" },
          expiresAt: null,
        },
      ],
      effectiveBudget: {
        status: "reported",
        budgetId: "individual-1",
        amount: "125.5",
        consumedAmount: { status: "reported", amount: "42.125", unit: "USD" },
      },
    });
  });

  it("does not expose an unsupported effective allocation", () => {
    expect(mapBudgetLookupSource({
      ...source,
      effectiveBudget: { id: "outside", budget_amount: "999", consumed_amount: "10" },
    }, "octo-user", 123).effectiveBudget).toEqual({ status: "outside_mvp" });
    expect(mapBudgetLookupSource({ ...source, effectiveBudget: null }, "octo-user", 123).effectiveBudget)
      .toEqual({ status: "not_reported" });
  });

  it("accepts an individual budget by ID that leaves out the target user", () => {
    const withoutUser: Record<string, unknown> & { id: string } = { ...source.individualBudgets[0]! };
    delete withoutUser.user;
    const mapped = mapBudgetLookupSource({ ...source, individualBudgets: [withoutUser] }, "octo-user", 123);
    expect(mapped.budgets.map((budget) => budget.id)).toEqual(["individual-1", "default-1"]);
  });

  it.each([
    [{ ...source, individualBudgets: [{ ...source.individualBudgets[0], user: "octo-user", budget_amount: "1.0000000001" }] }],
    [{ ...source, individualBudgets: [{ ...source.individualBudgets[0], id: "duplicate" }], defaultPerUserBudgets: [{ ...source.defaultPerUserBudgets[0], id: "duplicate" }] }],
    [{ ...source, effectiveBudget: { id: "individual-1", budget_amount: "not-a-decimal", consumed_amount: null } }],
  ])("rejects malformed, ambiguous or imprecise source data", (invalid) => {
    expect(() => mapBudgetLookupSource(invalid, "octo-user", 123)).toThrow();
  });
});
