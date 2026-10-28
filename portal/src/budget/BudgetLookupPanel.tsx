"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { budgetLookupDataSchema } from "../../../shared/src/budget";
import type { BudgetLookupData } from "../../../shared/src/api";

type PanelErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "per_user_detail_disabled"
  | "module_disabled"
  | "permissions_unavailable"
  | "budget_source_unavailable"
  | "budget_source_timeout"
  | "budget_source_invalid"
  | "budget_source_incomplete"
  | "rate_limited"
  | "unknown";

const errorMessages: Record<PanelErrorCode, string> = {
  unauthenticated: "Sign in to view budget information.",
  forbidden: "You do not have permission to view this user's budget.",
  per_user_detail_disabled: "Per-user budget access is disabled for this deployment.",
  module_disabled: "Budget Lookup is not available.",
  permissions_unavailable: "Permissions could not be verified. No budget data was requested.",
  budget_source_unavailable: "The budget source is temporarily unavailable.",
  budget_source_timeout: "The budget source did not respond before the request timed out.",
  budget_source_invalid: "The budget source returned data that could not be safely displayed.",
  budget_source_incomplete: "The budget source did not return a complete result.",
  rate_limited: "The budget source rate limit was reached. Try again later.",
  unknown: "The budget request could not be completed.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function panelErrorCode(value: unknown): PanelErrorCode {
  if (!isRecord(value) || typeof value.code !== "string") return "unknown";
  return isPanelErrorCode(value.code) ? value.code : "unknown";
}

function isPanelErrorCode(value: string): value is PanelErrorCode {
  return value in errorMessages;
}

async function requestBudget(userId: string | null, signal?: AbortSignal): Promise<BudgetLookupData> {
  const query = userId === null ? "" : `?userId=${encodeURIComponent(userId)}`;
  let response: Response;
  try {
    response = await fetch(`/api/budget-lookup${query}`, {
      method: "GET",
      cache: "no-store",
      signal,
    });
  } catch {
    throw new Error(errorMessages.budget_source_unavailable);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(errorMessages.unknown);
  }
  if (!response.ok) {
    const code = isRecord(body) && isRecord(body.error) ? panelErrorCode(body.error) : "unknown";
    throw new Error(errorMessages[code]);
  }
  const parsed = isRecord(body) ? budgetLookupDataSchema.safeParse(body.data) : null;
  if (!parsed?.success) throw new Error(errorMessages.budget_source_invalid);
  return parsed.data;
}

function consumptionText(data: BudgetLookupData["budgets"][number]["consumedAmount"]): string {
  return data.status === "reported" ? `USD ${data.amount}` : "Not reported";
}

function effectiveText(data: BudgetLookupData["effectiveBudget"]): string {
  switch (data.status) {
    case "reported":
      return `USD ${data.amount} (GitHub-reported allocation)`;
    case "not_reported":
      return "Not reported by GitHub.";
    case "outside_mvp":
      return "GitHub reported an allocation outside the supported Budget Lookup scope; its details are withheld.";
  }
}

export default function BudgetLookupPanel() {
  const [userId, setUserId] = useState("");
  const [data, setData] = useState<BudgetLookupData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void requestBudget(null, controller.signal).then(setData).catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : errorMessages.unknown);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const target = userId.trim() || null;
      if (target !== null && !/^[1-9]\d*$/.test(target)) {
        throw new Error("Enter a positive numeric GitHub user ID.");
      }
      setData(await requestBudget(target));
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : errorMessages.unknown);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="budget-lookup-heading" className="space-y-6">
      <div>
        <h1 id="budget-lookup-heading" className="text-2xl font-semibold">Budget Lookup</h1>
        <p className="mt-2 text-sm text-muted">
          View source-reported AI-credit budget information in USD. Consumption may not be reported.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <label htmlFor="budget-user-id" className="text-sm font-medium">GitHub user ID</label>
          <input
            id="budget-user-id"
            inputMode="numeric"
            autoComplete="off"
            value={userId}
            onChange={(event) => setUserId(event.currentTarget.value)}
            aria-describedby="budget-user-id-help"
            className="rounded border border-default px-3 py-2"
          />
          <span id="budget-user-id-help" className="text-xs text-muted">
            Leave blank for your own budget. Other users must be in your authorized population.
          </span>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-[#24292f] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Look up budget
        </button>
      </form>

      {loading && <p role="status">Loading budget data...</p>}
      {error && <p role="alert">{error}</p>}
      {data && (
        <div className="space-y-5">
          <h2 className="text-lg font-semibold">Budget data for user {data.userId}</h2>
          <section aria-labelledby="effective-budget-heading">
            <h3 id="effective-budget-heading" className="font-semibold">Effective allocation</h3>
            <p>{effectiveText(data.effectiveBudget)}</p>
          </section>
          <section aria-labelledby="budget-definitions-heading" className="space-y-2">
            <h3 id="budget-definitions-heading" className="font-semibold">Supported budget definitions</h3>
            {data.budgets.length === 0 ? (
              <p>
                No supported AI-credit budget definitions were returned. This does not prove that no other
                budget applies.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">AI-credit budget definitions and source-reported consumption</caption>
                  <thead>
                    <tr className="border-b border-default">
                      <th scope="col" className="py-2 pr-4">Type</th>
                      <th scope="col" className="py-2 pr-4">Budget amount</th>
                      <th scope="col" className="py-2 pr-4">Consumed amount</th>
                      <th scope="col" className="py-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.budgets.map((budget) => (
                      <tr key={budget.id} className="border-b border-default">
                        <th scope="row" className="py-2 pr-4 font-medium">
                          {budget.kind === "individual" ? "Individual" : "Default per user"}
                        </th>
                        <td className="py-2 pr-4">USD {budget.amount}</td>
                        <td className="py-2 pr-4">{consumptionText(budget.consumedAmount)}</td>
                        <td className="py-2">{budget.expiresAt ?? "Not applicable"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="text-sm text-muted">Budget reset cycle: {data.cycle.replaceAll("_", " ")}.</p>
        </div>
      )}
    </section>
  );
}
