import { describe, expect, it, vi } from "vitest";
import { runProbe } from "./probe";

const login = "octo-user";
const individual = {
  id: "individual-1", budget_type: "BundlePricing", budget_product_sku: "ai_credits",
  budget_scope: "user", budget_amount: 10,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("budget probe", () => {
  it("reports both requests' shape and the mapped result without amounts", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        budgets: [], has_next_page: false, total_count: 0, user: login,
        effective_budget: { id: "individual-1", budget_amount: 10, consumed_amount: 2.5 },
      }))
      .mockResolvedValueOnce(json(individual));

    const report = await runProbe({ token: "synthetic", enterprise: "example-enterprise", login, fetchImpl });

    expect(report.pages).toEqual([
      {
        request: "effective_budget", status: 200,
        fields: ["budgets", "effective_budget", "has_next_page", "total_count", "user"],
        hasTopLevelUser: true, topLevelUserMatches: true,
        effectiveBudgetFields: ["budget_amount", "consumed_amount", "id"],
      },
      {
        request: "budget_by_id", status: 200,
        fields: ["budget_amount", "budget_product_sku", "budget_scope", "budget_type", "id"],
        budget: {
          budget_type: "BundlePricing", budget_product_sku: "ai_credits", has_budget_product_skus: false,
          budget_scope: "user", user_matches: null, budget_amount_type: "number",
        },
      },
    ]);
    expect(report.result).toMatchObject({
      ok: true,
      data: {
        budgets: [{ id: "individual-1", kind: "individual", consumedAmount: { status: "reported", amount: "2.5" } }],
        effectiveBudget: { status: "reported", budgetId: "individual-1" },
      },
    });
    expect(JSON.stringify(report.pages)).not.toContain("2.5");
  });

  it("shows when the effective budget is outside the supported classification", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ effective_budget: { id: "b-1", budget_amount: 10, consumed_amount: 1 } }))
      .mockResolvedValueOnce(json({ ...individual, id: "b-1", budget_type: "ProductPricing", budget_product_skus: ["actions"] }));

    const report = await runProbe({ token: "synthetic", enterprise: "example-enterprise", login, fetchImpl });

    expect(report.pages[1]!.budget).toMatchObject({ budget_type: "ProductPricing", has_budget_product_skus: true });
    expect(report.result).toMatchObject({ ok: true, data: { budgets: [], effectiveBudget: { status: "outside_mvp" } } });
  });
});
