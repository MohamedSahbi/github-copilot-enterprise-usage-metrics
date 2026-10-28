import { budgetLookupDataSchema, budgetLookupSourceClassificationSchema } from "../../../shared/src/budget";
import type { BudgetLookupConsumption, BudgetLookupData, BudgetLookupRecord } from "../../../shared/src/api";
import { exactDecimal18_9 } from "../../../shared/src/decimal";
import { BudgetLookupSourceError } from "./client";
import type { GitHubBudgetSourceData } from "./client";

type SourceRecord = Record<string, unknown> & { id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceAmount(value: unknown): string {
  if (typeof value !== "string") {
    throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned an invalid amount.");
  }
  const amount = exactDecimal18_9(value);
  if (amount === null) {
    throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned an invalid amount.");
  }
  return amount;
}

function consumption(value: unknown): BudgetLookupConsumption {
  return value === undefined || value === null
    ? { status: "not_reported" }
    : { status: "reported", amount: sourceAmount(value), unit: "USD" };
}

function recordBudget(
  budget: SourceRecord,
  kind: BudgetLookupRecord["kind"],
): BudgetLookupRecord {
  const amount = sourceAmount(budget.budget_amount);
  const consumedAmount = consumption(budget.consumed_amount);
  if (kind === "default_per_user") {
    return { id: budget.id, kind, amount, consumedAmount, expiresAt: null };
  }
  const expiresAt = budget.expires_at === undefined || budget.expires_at === null
    ? null
    : typeof budget.expires_at === "string"
      ? budget.expires_at
      : (() => {
          throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned an invalid expiry date.");
        })();
  return { id: budget.id, kind, amount, consumedAmount, expiresAt };
}

function supportedBudgets(
  budgets: readonly SourceRecord[],
  scope: "user" | "multi_user_customer",
  login?: string,
): BudgetLookupRecord[] {
  const result: BudgetLookupRecord[] = [];
  for (const budget of budgets) {
    const classification = budgetLookupSourceClassificationSchema.safeParse({
      budget_type: budget.budget_type,
      budget_product_sku: budget.budget_product_sku,
      budget_product_skus: budget.budget_product_skus,
      budget_scope: budget.budget_scope,
    });
    if (!classification.success || classification.data.budget_scope !== scope) continue;

    if (scope === "user") {
      if (typeof budget.user !== "string") {
        throw new BudgetLookupSourceError("budget_source_invalid", "The budget source omitted target-user identity.");
      }
      if (budget.user !== login) continue;
    }

    result.push(recordBudget(budget, scope === "user" ? "individual" : "default_per_user"));
  }
  return result;
}

function sourceBudget(value: unknown): value is SourceRecord {
  return isRecord(value) && typeof value.id === "string";
}

export function mapBudgetLookupSource(
  source: GitHubBudgetSourceData,
  login: string,
  userId: number,
): BudgetLookupData {
  if (!source.individualBudgets.every(sourceBudget) || !source.defaultPerUserBudgets.every(sourceBudget)) {
    throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned malformed records.");
  }
  const budgets = [
    ...supportedBudgets(source.individualBudgets, "user", login),
    ...supportedBudgets(source.defaultPerUserBudgets, "multi_user_customer"),
  ];

  let effectiveBudget: BudgetLookupData["effectiveBudget"];
  if (source.effectiveBudget === null) {
    effectiveBudget = { status: "not_reported" };
  } else {
    const id = source.effectiveBudget.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned invalid effective-budget metadata.");
    }
    if (!budgets.some((budget) => budget.id === id)) {
      effectiveBudget = { status: "outside_mvp" };
    } else {
      const amount = sourceAmount(source.effectiveBudget.budget_amount);
      const record = budgets.find((budget) => budget.id === id);
      if (record?.amount !== amount) {
        throw new BudgetLookupSourceError("budget_source_invalid", "Effective-budget metadata conflicts with its supported definition.");
      }
      effectiveBudget = {
        status: "reported",
        budgetId: id,
        amount,
        consumedAmount: consumption(source.effectiveBudget.consumed_amount),
      };
    }
  }

  const parsed = budgetLookupDataSchema.safeParse({
    userId,
    budgets,
    effectiveBudget,
    amountUnit: "USD",
    cycle: "calendar_month_utc",
  });
  if (!parsed.success) {
    throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned data outside the supported contract.");
  }
  return parsed.data;
}
