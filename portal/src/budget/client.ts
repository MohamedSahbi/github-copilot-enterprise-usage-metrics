import {
  BUDGET_LOOKUP_MAX_PAGES,
  BUDGET_LOOKUP_TIMEOUT_MS,
  validateBudgetLookupPage,
} from "../../../shared/src/budget";
import type { BudgetLookupSourceErrorCode } from "../../../shared/src/api";
import type { BudgetLookupPageProgress } from "../../../shared/src/budget";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const PER_PAGE = 100;

type BudgetScope = "user" | "multi_user_customer" | "unscoped";
type JsonRecord = Record<string, unknown>;
type SourceBudget = JsonRecord & { id: string };

export class BudgetLookupSourceError extends Error {
  constructor(
    readonly code: BudgetLookupSourceErrorCode | "rate_limited",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "BudgetLookupSourceError";
  }
}

export interface BudgetLookupClientOptions {
  token: string;
  enterprise: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onPermissionObservation?: (status: 200 | 401 | 403) => void;
}

export interface GitHubBudgetSourceData {
  individualBudgets: SourceBudget[];
  defaultPerUserBudgets: SourceBudget[];
  effectiveBudget: JsonRecord | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteJsonNumbers(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      index += 1;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))?.[0];
      if (number) {
        const next = source[index + number.length];
        if (next === undefined || /[\s,\]}]/.test(next)) {
          output += JSON.stringify(number);
          index += number.length;
          continue;
        }
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

function parseLosslessJson(text: string): unknown {
  try {
    return JSON.parse(quoteJsonNumbers(text)) as unknown;
  } catch {
    throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned malformed JSON.");
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseTotalCount(value: unknown): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBudgetRecords(value: unknown): SourceBudget[] {
  if (!Array.isArray(value)) {
    throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned an invalid budget list.");
  }
  return value.map((budget): SourceBudget => {
    if (!isRecord(budget) || typeof budget.id !== "string" || budget.id.length === 0) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned a record without a stable ID.");
    }
    return { ...budget, id: budget.id };
  });
}

function readRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value || !/^\d{1,5}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : undefined;
}

export function createBudgetLookupClient(options: BudgetLookupClientOptions) {
  const token = options.token.trim();
  const enterprise = options.enterprise.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BUDGET_LOOKUP_TIMEOUT_MS;

  async function fetchBudgetPage(
    scope: BudgetScope,
    login: string,
    page: number,
    signal: AbortSignal,
  ): Promise<{ budgets: SourceBudget[]; hasNextPage: boolean; totalCount: number; effectiveBudget: JsonRecord | null }> {
    const url = new URL(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets`, API_ORIGIN);
    if (scope !== "unscoped") url.searchParams.set("scope", scope);
    url.searchParams.set("user", login);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw new BudgetLookupSourceError("budget_source_timeout", "The budget source request timed out.");
      }
      throw new BudgetLookupSourceError("budget_source_unavailable", "The budget source could not be reached.");
    }

    if (response.status === 200 || response.status === 401 || response.status === 403) {
      options.onPermissionObservation?.(response.status);
    }
    if (response.status === 429) {
      throw new BudgetLookupSourceError(
        "rate_limited",
        "The budget source rate limit was reached.",
        readRetryAfter(response),
      );
    }
    if (!response.ok) {
      throw new BudgetLookupSourceError("budget_source_unavailable", "The budget source request failed.");
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      if (signal.aborted) {
        throw new BudgetLookupSourceError("budget_source_timeout", "The budget source request timed out.");
      }
      throw new BudgetLookupSourceError("budget_source_unavailable", "The budget source response could not be read.");
    }
    const body = parseLosslessJson(responseText);
    if (!isRecord(body)) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned an invalid page.");
    }
    if (scope === "unscoped" && body.user !== login) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned a mismatched user identity.");
    }
    const budgets = parseBudgetRecords(body.budgets);
    if (typeof body.has_next_page !== "boolean") {
      throw new BudgetLookupSourceError("budget_source_incomplete", "The budget source omitted pagination completion.");
    }
    const totalCount = parseTotalCount(body.total_count);
    if (totalCount === null) {
      throw new BudgetLookupSourceError("budget_source_incomplete", "The budget source omitted a valid total count.");
    }
    const effectiveBudget = scope !== "unscoped" ||
      body.effective_budget === undefined || body.effective_budget === null
      ? null
      : isRecord(body.effective_budget)
        ? body.effective_budget
        : (() => {
            throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned invalid effective-budget metadata.");
          })();
    return { budgets, hasNextPage: body.has_next_page, totalCount, effectiveBudget };
  }

  async function listBudgets(scope: BudgetScope, login: string, signal: AbortSignal): Promise<{
    budgets: SourceBudget[];
    effectiveBudget: JsonRecord | null;
  }> {
    let progress: BudgetLookupPageProgress | null = null;
    const budgets: SourceBudget[] = [];
    let effectiveBudget: JsonRecord | null = null;
    let effectiveFingerprint: string | null = null;

    for (let pageNumber = 1; pageNumber <= BUDGET_LOOKUP_MAX_PAGES; pageNumber += 1) {
      const page = await fetchBudgetPage(scope, login, pageNumber, signal);
      const validated = validateBudgetLookupPage({
        ids: page.budgets.map((budget) => budget.id),
        hasNextPage: page.hasNextPage,
        totalCount: page.totalCount,
      }, progress);
      if (!validated.ok) {
        throw new BudgetLookupSourceError("budget_source_incomplete", "The budget source returned incomplete pagination.");
      }
      progress = validated.progress;
      budgets.push(...page.budgets);
      if (scope === "unscoped" && page.effectiveBudget) {
        const fingerprint = stableSerialize(page.effectiveBudget);
        if (effectiveFingerprint !== null && effectiveFingerprint !== fingerprint) {
          throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned conflicting effective-budget metadata.");
        }
        effectiveFingerprint = fingerprint;
        effectiveBudget = page.effectiveBudget;
      }
      if (progress.complete) return { budgets, effectiveBudget };
    }
    throw new BudgetLookupSourceError("budget_source_incomplete", "The budget source exceeded its page limit.");
  }

  return {
    async read(login: string, requestSignal?: AbortSignal): Promise<GitHubBudgetSourceData> {
      if (!token || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})$/.test(enterprise)) {
        throw new BudgetLookupSourceError("budget_source_unavailable", "Budget source configuration is unavailable.");
      }
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})$/.test(login)) {
        throw new BudgetLookupSourceError("budget_source_invalid", "The resolved source identity is invalid.");
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new BudgetLookupSourceError("budget_source_unavailable", "Budget source configuration is invalid.");
      }

      const controller = new AbortController();
      const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new BudgetLookupSourceError("budget_source_timeout", "The budget source request timed out."));
        }, timeoutMs);
      });
      try {
        const read = async (): Promise<GitHubBudgetSourceData> => {
          const individual = await listBudgets("user", login, signal);
          const defaults = await listBudgets("multi_user_customer", login, signal);
          const effective = await listBudgets("unscoped", login, signal);
          return {
            individualBudgets: individual.budgets,
            defaultPerUserBudgets: defaults.budgets,
            effectiveBudget: effective.effectiveBudget,
          };
        };
        return await Promise.race([read(), timeout]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    },
  };
}
