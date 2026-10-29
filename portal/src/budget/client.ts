import { BUDGET_LOOKUP_TIMEOUT_MS } from "../../../shared/src/budget";
import type { BudgetLookupSourceErrorCode } from "../../../shared/src/api";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";

// Same two reads as the original Lookup-BudgetCostCenter function: the user-filtered
// "Get all budgets" call is the only one that reports the effective budget and its
// consumption, and "Get a budget by ID" tells us what that budget is.
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

  async function getJson(url: URL, signal: AbortSignal): Promise<JsonRecord | null> {
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
    if (response.status === 404) return null;
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
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned an invalid response.");
    }
    return body;
  }

  function budgetsUrl(path = ""): URL {
    return new URL(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets${path}`, API_ORIGIN);
  }

  async function readEffectiveBudget(login: string, signal: AbortSignal): Promise<JsonRecord | null> {
    const url = budgetsUrl();
    url.searchParams.set("user", login);
    url.searchParams.set("per_page", "1");
    const body = await getJson(url, signal);
    if (body === null) {
      throw new BudgetLookupSourceError("budget_source_unavailable", "The budget source request failed.");
    }
    if (typeof body.user === "string" && body.user !== login) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned a mismatched user identity.");
    }
    const effective = body.effective_budget;
    if (effective === undefined || effective === null) return null;
    if (!isRecord(effective) || typeof effective.id !== "string" || effective.id.length === 0) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned invalid effective-budget metadata.");
    }
    return effective;
  }

  async function readBudget(id: string, signal: AbortSignal): Promise<SourceBudget | null> {
    const budget = await getJson(budgetsUrl(`/${encodeURIComponent(id)}`), signal);
    if (budget === null) return null;
    if (budget.id !== id) {
      throw new BudgetLookupSourceError("budget_source_invalid", "The budget source returned a mismatched budget ID.");
    }
    return { ...budget, id };
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
          const effectiveBudget = await readEffectiveBudget(login, signal);
          const result: GitHubBudgetSourceData = { individualBudgets: [], defaultPerUserBudgets: [], effectiveBudget };
          if (effectiveBudget === null) return result;

          const budget = await readBudget(effectiveBudget.id as string, signal);
          if (budget === null) return result;
          // "Get a budget by ID" never reports spend, so the record carries the effective figure.
          const withConsumption = budget.consumed_amount === undefined
            ? { ...budget, consumed_amount: effectiveBudget.consumed_amount }
            : budget;
          if (budget.budget_scope === "user") result.individualBudgets.push(withConsumption);
          else if (budget.budget_scope === "multi_user_customer") result.defaultPerUserBudgets.push(withConsumption);
          return result;
        };
        return await Promise.race([read(), timeout]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    },
  };
}
