import { z } from "zod";
import { validateBudgetLookupRequest, validateDateRange } from "./api";
import type { ApiErrorCode, BudgetLookupData } from "./api";
import { exactDecimal18_9 } from "./decimal";

const userIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const amountSchema = z.string().max(128).refine((value) => exactDecimal18_9(value) !== null)
  .transform((value) => exactDecimal18_9(value)!);
const consumptionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("reported"), amount: amountSchema, unit: z.literal("USD") }),
  z.strictObject({ status: z.literal("not_reported") }),
]);
const expirySchema = z.string().refine((value) => validateDateRange({ from: value, to: value }).ok);

// Classification only, not a full source decoder or an applicability/authorization check.
export const budgetLookupSourceClassificationSchema = z.object({
  budget_type: z.literal("BundlePricing"),
  budget_product_sku: z.literal("ai_credits"),
  budget_scope: z.enum(["user", "multi_user_customer"]),
  budget_product_skus: z.never().optional(),
});

export const budgetLookupDataSchema = z.strictObject({
  userId: userIdSchema,
  amountUnit: z.literal("USD"),
  cycle: z.literal("calendar_month_utc"),
  budgets: z.array(z.discriminatedUnion("kind", [
    z.strictObject({
      id: z.string().min(1), kind: z.literal("individual"), amount: amountSchema,
      consumedAmount: consumptionSchema, expiresAt: expirySchema.nullable(),
    }),
    z.strictObject({
      id: z.string().min(1), kind: z.literal("default_per_user"), amount: amountSchema,
      consumedAmount: consumptionSchema, expiresAt: z.null(),
    }),
  ])),
  effectiveBudget: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("reported"),
      budgetId: z.string().min(1),
      amount: amountSchema,
      consumedAmount: consumptionSchema,
    }),
    z.strictObject({ status: z.literal("not_reported") }),
    z.strictObject({ status: z.literal("outside_mvp") }),
  ]),
}).superRefine((data, context) => {
  if (new Set(data.budgets.map((budget) => budget.id)).size !== data.budgets.length) {
    context.addIssue({ code: "custom", path: ["budgets"], message: "Budget IDs must be unique." });
  }
  const effective = data.effectiveBudget;
  if (effective.status === "reported" &&
      !data.budgets.some((budget) => budget.id === effective.budgetId)) {
    context.addIssue({ code: "custom", path: ["effectiveBudget"], message: "Effective budget must identify a supported record." });
  }
}) satisfies z.ZodType<BudgetLookupData>;

/**
 * Server-only facts, never browser input. Authorized state requires a valid current grant,
 * active linked immutable principal and fresh/complete directory and population evidence.
 * The existing scope resolver owns population expansion; role names are not authority here.
 */
export interface BudgetLookupTargetContext {
  moduleEnabled: boolean;
  perUserDetailEnabled: boolean;
  access:
    | { state: "unauthenticated" | "forbidden" | "permissions_unavailable" }
    | { state: "authorized"; selfUserId: number; authorizedUserIds: readonly number[] };
}

export function validateBudgetLookupTarget(
  request: unknown,
  context: BudgetLookupTargetContext,
): { ok: true; userId: number } | { ok: false; code: ApiErrorCode } {
  const validation = validateBudgetLookupRequest(request);
  if (!validation.ok) return validation;
  if (context.access.state !== "authorized") return { ok: false, code: context.access.state };
  if (!context.moduleEnabled) return { ok: false, code: "module_disabled" };
  const { selfUserId, authorizedUserIds } = context.access;
  if (!userIdSchema.safeParse(selfUserId).success ||
      authorizedUserIds.some((id) => !userIdSchema.safeParse(id).success)) {
    return { ok: false, code: "permissions_unavailable" };
  }
  const userId = validation.request.target === "self" ? selfUserId : validation.request.userId;
  if (userId === selfUserId) return { ok: true, userId };
  if (!authorizedUserIds.includes(userId)) return { ok: false, code: "forbidden" };
  if (!context.perUserDetailEnabled) return { ok: false, code: "per_user_detail_disabled" };
  return { ok: true, userId };
}

export const BUDGET_LOOKUP_MAX_PAGES = 100;
export const BUDGET_LOOKUP_TIMEOUT_MS = 10_000;

export interface BudgetLookupPageProgress {
  readonly ids: readonly string[];
  readonly totalCount: number;
  readonly pages: number;
  readonly complete: boolean;
}

const pageSchema = z.strictObject({
  ids: z.array(z.string().min(1)).max(100),
  hasNextPage: z.boolean(),
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

// Call once per raw page before product/identity filtering, using IDs (or exact user-state logins).
export function validateBudgetLookupPage(
  page: unknown,
  previous: BudgetLookupPageProgress | null,
): { ok: true; progress: BudgetLookupPageProgress } | { ok: false; code: "budget_source_incomplete" } {
  const parsed = pageSchema.safeParse(page);
  if (!parsed.success || previous?.complete || (previous?.pages ?? 0) >= BUDGET_LOOKUP_MAX_PAGES) {
    return { ok: false, code: "budget_source_incomplete" };
  }
  const { ids, totalCount, hasNextPage } = parsed.data;
  const allIds = [...(previous?.ids ?? []), ...ids];
  const pages = (previous?.pages ?? 0) + 1;
  if ((previous !== null && previous.totalCount !== totalCount) ||
      new Set(allIds).size !== allIds.length ||
      (hasNextPage && pages === BUDGET_LOOKUP_MAX_PAGES) ||
      (hasNextPage ? ids.length === 0 || allIds.length >= totalCount : allIds.length !== totalCount)) {
    return { ok: false, code: "budget_source_incomplete" };
  }
  return {
    ok: true,
    progress: { ids: allIds, totalCount, pages, complete: !hasNextPage },
  };
}
