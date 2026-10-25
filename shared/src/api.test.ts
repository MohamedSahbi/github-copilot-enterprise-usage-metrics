import { describe, expect, it } from "vitest";
import { validateBudgetLookupRequest } from "./api";
import type { BudgetLookupRequest, BudgetLookupResponse } from "./api";
import { exactDecimal18_9 } from "./decimal";

describe("Budget Lookup contract", () => {
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
    const response = {
      meta: { correlationId: "correlation-id", generatedAt: "2026-10-25T00:00:00Z", minGroupSize: 5, metricVersion: 1 },
      data: {
        userId: 123,
        budgets: [
          {
            id: "budget-id",
            scope: { type: "universal", githubScope: "multi_user_customer" },
            entityName: null,
            amount: "1250.000000001",
            currency: "USD",
            consumedAmount: "42.500000009",
            consumedAgainstType: "universal_default",
            expiresAt: null,
          },
          {
            id: "raw-budget-id",
            scope: { type: "raw", githubScope: "repository" },
            entityName: "{repository}",
            amount: "20",
            currency: "USD",
            consumedAmount: null,
            consumedAgainstType: "repository",
            expiresAt: null,
          },
          {
            id: "individual-budget-id",
            scope: { type: "individual", githubScope: "user" },
            entityName: null,
            amount: "75",
            currency: "USD",
            consumedAmount: "10.25",
            consumedAgainstType: "individual_budget",
            expiresAt: null,
          },
        ],
        effectiveBudget: {
          id: "budget-id",
          amount: "1250.000000001",
          consumedAmount: "42.500000009",
          consumedAgainstType: "universal_default",
        },
        costCenterMemberships: [{ id: "center-id", name: "{cost-center}", state: "active" }],
      },
    } satisfies BudgetLookupResponse;

    expect(exactDecimal18_9(response.data.budgets[0]!.amount)).toBe("1250.000000001");
    expect(exactDecimal18_9(response.data.effectiveBudget!.consumedAmount)).toBe("42.500000009");
  });

  it("contracts cost-center views with budget and member amounts", () => {
    const response = {
      meta: { correlationId: "correlation-id", generatedAt: "2026-10-25T00:00:00Z", minGroupSize: 5, metricVersion: 1 },
      data: {
        costCenterName: "{cost-center}",
        budget: {
          id: "budget-id",
          scope: { type: "cost_center", githubScope: "cost_center" },
          entityName: "{cost-center}",
          amount: "1000",
          currency: "USD",
          consumedAmount: "250.25",
          consumedAgainstType: "cost_center",
          expiresAt: null,
        },
        members: [
          { resourceType: "user", resourceName: "{member}", userId: 123, consumedAmount: "250.25", targetAmount: "500" },
        ],
      },
    } satisfies BudgetLookupResponse;

    expect(response.data.members[0]!.userId).toBe(123);
  });
});
