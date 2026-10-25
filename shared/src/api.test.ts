import { describe, expect, it } from "vitest";
import { validateBudgetLookupRequest } from "./api";
import type { BudgetLookupBudget, BudgetLookupRequest, BudgetLookupResponse, GitHubBudgetUserStatesPage } from "./api";
import { exactDecimal18_9 } from "./decimal";

describe("Budget Lookup contract", () => {
  it("represents BundlePricing and losslessly normalized singular and plural product SKUs", () => {
    const examples = [
      {
        source: { budget_type: "BundlePricing", budget_product_skus: ["ai_credits"] },
        normalized: { budgetType: "BundlePricing", budgetProductSkus: ["ai_credits"] },
      },
      {
        source: { budget_type: "SkuPricing", budget_product_sku: "actions_linux" },
        normalized: { budgetType: "SkuPricing", budgetProductSkus: ["actions_linux"] },
      },
      {
        source: { budget_type: "ProductPricing", budget_product_skus: ["actions_linux", "actions_windows"] },
        normalized: { budgetType: "ProductPricing", budgetProductSkus: ["actions_linux", "actions_windows"] },
      },
    ] satisfies {
      source: { budget_type: string; budget_product_sku?: string; budget_product_skus?: string[] };
      normalized: Pick<BudgetLookupBudget, "budgetType" | "budgetProductSkus">;
    }[];

    for (const { source, normalized } of examples) {
      expect(normalized.budgetType).toBe(source.budget_type);
      expect(normalized.budgetProductSkus).toEqual(source.budget_product_skus ?? [source.budget_product_sku]);
    }
  });

  it("accepts numeric GitHub user IDs and cost-center names as distinct lookup keys", () => {
    const userRequest: BudgetLookupRequest = { userId: 123 };
    const costCenterRequest: BudgetLookupRequest = { costCenterName: "{cost-center}" };

    expect(validateBudgetLookupRequest(userRequest)).toEqual({ ok: true, request: userRequest });
    expect(validateBudgetLookupRequest({ costCenterName: " {cost-center} " })).toEqual({
      ok: true,
      request: costCenterRequest,
    });
  });

  it.each([
    null,
    [],
    {},
    { userId: 0 },
    { userId: -1 },
    { userId: 1.5 },
    { userId: Number.MAX_SAFE_INTEGER + 1 },
    { userId: "123" },
    { costCenterName: "" },
    { costCenterName: "   " },
    { userId: 123, costCenterName: "{cost-center}" },
    { login: "login" },
    { email: "email" },
  ])("rejects an invalid or ambiguous lookup key: %o", (request) => {
    expect(validateBudgetLookupRequest(request)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("accepts cost-center names at GitHub's 255-character limit", () => {
    const costCenterName = "c".repeat(255);
    expect(validateBudgetLookupRequest({ costCenterName })).toEqual({
      ok: true,
      request: { costCenterName },
    });
  });

  it("rejects cost-center names longer than GitHub's 255-character limit", () => {
    expect(validateBudgetLookupRequest({ costCenterName: "c".repeat(256) })).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  it("keeps live budget, effective-budget, and cost-center amounts as exact decimal strings", () => {
    const githubUserStatesPage = {
      user_states: [
        {
          user: "{login}",
          consumed_amount: "42.500000009",
          target_amount: "1250",
          override_budget_id: "00000000-0000-4000-8000-000000000001",
        },
      ],
      has_next_page: false,
      total_count: 1,
    } satisfies GitHubBudgetUserStatesPage;

    const response = {
      meta: { correlationId: "correlation-id", generatedAt: "2026-10-25T00:00:00Z", minGroupSize: 5, metricVersion: 1 },
      data: {
        userId: 123,
        budgets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            scope: { type: "universal", githubScope: "multi_user_customer" },
            entityName: null,
            budgetType: "ProductPricing",
            budgetProductSkus: ["ai_credits"],
            amount: "1250",
            preventFurtherUsage: true,
            budgetAlerting: { willAlert: false, alertRecipients: [] },
            consumedAmount: "42.500000009",
            expiresAt: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            scope: { type: "raw", githubScope: "repository" },
            entityName: "{repository}",
            budgetType: "SkuPricing",
            budgetProductSkus: ["ai_credits"],
            amount: "20",
            preventFurtherUsage: false,
            budgetAlerting: { willAlert: false, alertRecipients: [] },
            consumedAmount: null,
            expiresAt: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000003",
            scope: { type: "individual", githubScope: "user" },
            entityName: null,
            budgetType: "SkuPricing",
            budgetProductSkus: ["ai_credits"],
            amount: "75",
            preventFurtherUsage: true,
            budgetAlerting: { willAlert: false, alertRecipients: [] },
            consumedAmount: "10.25",
            expiresAt: null,
          },
        ],
        effectiveBudget: {
          id: "00000000-0000-4000-8000-000000000001",
          amount: "1250",
          consumedAmount: "42.500000009",
        },
        userStates: [
          {
            budgetId: "00000000-0000-4000-8000-000000000001",
            userId: 123,
            consumedAmount: "42.500000009",
            targetAmount: "1250",
            overrideBudgetId: null,
          },
        ],
        costCenterMemberships: [{ id: "center-id", name: "{cost-center}", state: "active" }],
      },
    } satisfies BudgetLookupResponse;

    expect(exactDecimal18_9(response.data.budgets[0]!.amount)).toBe("1250");
    expect(exactDecimal18_9(response.data.effectiveBudget!.amount)).toBe("1250");
    expect(exactDecimal18_9(response.data.effectiveBudget!.consumedAmount)).toBe("42.500000009");
    expect(exactDecimal18_9("42.500000009")).toBe("42.500000009");
    expect(response.data.userStates[0]!.overrideBudgetId).toBeNull();
    expect(exactDecimal18_9(githubUserStatesPage.user_states[0]!.consumed_amount)).toBe("42.500000009");
    expect(githubUserStatesPage.has_next_page).toBe(false);
    expect(githubUserStatesPage.total_count).toBe(1);

    const unmappedUserResponse = {
      meta: { correlationId: "correlation-id", generatedAt: "2026-10-25T00:00:00Z", minGroupSize: 5, metricVersion: 1 },
      data: {
        userId: null,
        budgets: [],
        effectiveBudget: null,
        userStates: [
          {
            budgetId: "00000000-0000-4000-8000-000000000006",
            userId: null,
            consumedAmount: "0",
            targetAmount: "0",
            overrideBudgetId: null,
          },
        ],
        costCenterMemberships: [],
      },
    } satisfies BudgetLookupResponse;
    expect(unmappedUserResponse.data.userId).toBeNull();
    expect(unmappedUserResponse.data.userStates[0]!.userId).toBeNull();
  });

  it("contracts cost-center views with budget and member amounts", () => {
    const response = {
      meta: { correlationId: "correlation-id", generatedAt: "2026-10-25T00:00:00Z", minGroupSize: 5, metricVersion: 1 },
      data: {
        costCenterName: "{cost-center}",
        state: "active",
        budget: {
          id: "00000000-0000-4000-8000-000000000004",
          scope: { type: "cost_center", githubScope: "cost_center" },
          entityName: "{cost-center}",
          budgetType: "ProductPricing",
          budgetProductSkus: ["ai_credits"],
          amount: "1000",
          preventFurtherUsage: false,
          budgetAlerting: { willAlert: true, alertRecipients: ["{login}"] },
          consumedAmount: "250.25",
          expiresAt: null,
        },
        members: [
          {
            resourceType: "user",
            resourceName: "{login}",
            userId: 123,
            consumedAmount: "250.25",
            targetAmount: "500",
            overrideBudgetId: "00000000-0000-4000-8000-000000000005",
          },
          {
            resourceType: "user",
            resourceName: "{unmapped-login}",
            userId: null,
            consumedAmount: "0",
            targetAmount: "500",
            overrideBudgetId: null,
          },
        ],
      },
    } satisfies BudgetLookupResponse;

    expect(response.data.members[0]!.userId).toBe(123);
    expect(response.data.members[1]!.userId).toBeNull();
    expect(response.data.members[0]!.overrideBudgetId).toBe("00000000-0000-4000-8000-000000000005");
  });
});
