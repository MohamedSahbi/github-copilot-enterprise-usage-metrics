import { describe, expect, it, vi } from "vitest";
import { runProbe } from "./probe";

const login = "octo-user";

function page(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ has_next_page: false, ...body }), { status: 200 });
}

const individual = {
  id: "individual-1", budget_type: "BundlePricing", budget_product_sku: "ai_credits",
  budget_scope: "user", user: login, budget_amount: 10, consumed_amount: 2.5,
};
const defaultPerUser = {
  id: "default-1", budget_type: "BundlePricing", budget_product_sku: "ai_credits",
  budget_scope: "multi_user_customer", budget_amount: 20,
};

describe("budget probe", () => {
  it("reports the documented shape and the mapped result", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page({ budgets: [individual], total_count: 1 }))
      .mockResolvedValueOnce(page({ budgets: [defaultPerUser], total_count: 1 }))
      .mockResolvedValueOnce(page({
        budgets: [], total_count: 0, user: login,
        effective_budget: { id: "individual-1", budget_amount: 10, consumed_amount: 2.5 },
      }));

    const report = await runProbe({ token: "synthetic", enterprise: "example-enterprise", login, fetchImpl });

    expect(report.pages.map((p) => p.scope)).toEqual(["user", "multi_user_customer", "unscoped"]);
    expect(report.pages[0]!.budgets[0]).toEqual({
      budget_type: "BundlePricing", budget_product_sku: "ai_credits", has_budget_product_skus: false,
      budget_scope: "user", has_user: true, user_matches: true, has_consumed_amount: true, budget_amount_type: "number",
    });
    expect(report.pages[2]).toMatchObject({ hasTopLevelUser: true, topLevelUserMatches: true, hasEffectiveBudget: true });
    expect(report.result).toMatchObject({ ok: true, data: { effectiveBudget: { status: "reported", budgetId: "individual-1" } } });
    expect(JSON.stringify(report.pages)).not.toContain("2.5");
  });

  it("shows the example-shaped response the docs also print, and the error it causes", async () => {
    const exampleShaped = { id: "b-1", budget_type: "ProductPricing", budget_product_skus: ["actions"], budget_scope: "user", budget_amount: 10 };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page({ budgets: [exampleShaped], total_count: 1 }))
      .mockResolvedValueOnce(page({ budgets: [], total_count: 0 }))
      .mockResolvedValueOnce(page({ budgets: [], total_count: 0 }));

    const report = await runProbe({ token: "synthetic", enterprise: "example-enterprise", login, fetchImpl });

    expect(report.pages[0]!.budgets[0]).toMatchObject({ has_budget_product_skus: true, has_user: false, user_matches: null });
    expect(report.pages[2]).toMatchObject({ hasTopLevelUser: false, topLevelUserMatches: null });
    expect(report.result).toEqual({ ok: false, code: "budget_source_invalid", message: "The budget source returned a mismatched user identity." });
  });
});
