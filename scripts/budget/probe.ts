import { pathToFileURL } from "node:url";
import { BudgetLookupSourceError, createBudgetLookupClient } from "../../portal/src/budget/client.js";
import { mapBudgetLookupSource } from "../../portal/src/budget/mapper.js";

// Read-only live check for Budget Lookup. It runs the same GETs as the portal for one
// login and prints the response shape (field names and classification values, without
// amounts or other users' logins), then that login's mapped result or the error code.

type JsonRecord = Record<string, unknown>;

// The portal maps with the caller's numeric ID; the probe only checks the shape.
const PLACEHOLDER_USER_ID = 1;

export interface ProbePage {
  request: "effective_budget" | "budget_by_id";
  status: number;
  body: unknown;
}

export interface ProbePageSummary {
  request: ProbePage["request"];
  status: number;
  fields: string[];
  hasTopLevelUser?: boolean;
  topLevelUserMatches?: boolean | null;
  effectiveBudgetFields?: string[] | null;
  budget?: {
    budget_type: unknown;
    budget_product_sku: unknown;
    has_budget_product_skus: boolean;
    budget_scope: unknown;
    user_matches: boolean | null;
    budget_amount_type: string;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeProbePage(page: ProbePage, login: string): ProbePageSummary {
  const body = isRecord(page.body) ? page.body : {};
  const summary: ProbePageSummary = { request: page.request, status: page.status, fields: Object.keys(body).sort() };
  if (page.request === "effective_budget") {
    summary.hasTopLevelUser = "user" in body;
    summary.topLevelUserMatches = "user" in body ? body.user === login : null;
    summary.effectiveBudgetFields = isRecord(body.effective_budget) ? Object.keys(body.effective_budget).sort() : null;
  } else if (page.status === 200) {
    summary.budget = {
      budget_type: body.budget_type,
      budget_product_sku: body.budget_product_sku,
      has_budget_product_skus: "budget_product_skus" in body,
      budget_scope: body.budget_scope,
      user_matches: "user" in body ? body.user === login : null,
      budget_amount_type: typeof body.budget_amount,
    };
  }
  return summary;
}

export function recordingFetch(pages: ProbePage[], fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    let body: unknown;
    try {
      body = JSON.parse(await response.clone().text()) as unknown;
    } catch {
      body = null;
    }
    const request = url.pathname.endsWith("/budgets") ? "effective_budget" : "budget_by_id";
    pages.push({ request, status: response.status, body });
    return response;
  };
}

export async function runProbe(options: {
  token: string;
  enterprise: string;
  login: string;
  fetchImpl?: typeof fetch;
}) {
  const pages: ProbePage[] = [];
  const client = createBudgetLookupClient({
    token: options.token,
    enterprise: options.enterprise,
    fetchImpl: recordingFetch(pages, options.fetchImpl),
  });
  let result: { ok: true; data: unknown } | { ok: false; code: string; message: string };
  try {
    const source = await client.read(options.login);
    result = { ok: true, data: mapBudgetLookupSource(source, options.login, PLACEHOLDER_USER_ID) };
  } catch (error) {
    result = error instanceof BudgetLookupSourceError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "unexpected", message: error instanceof Error ? error.message : String(error) };
  }
  return { pages: pages.map((page) => summarizeProbePage(page, options.login)), result };
}

async function main() {
  const token = process.env.BUDGET_LOOKUP_KEY;
  const enterprise = process.env.ENTERPRISE_SLUG;
  const login = process.argv[2];
  if (!token || !enterprise || !login) {
    console.error("Usage: BUDGET_LOOKUP_KEY=... ENTERPRISE_SLUG=... npm run budget:probe -- <github-login>");
    process.exit(2);
  }
  const report = await runProbe({ token, enterprise, login });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
