import { describe, expect, it, vi } from "vitest";
import { BudgetLookupSourceError, createBudgetLookupClient } from "./client";

const config = {
  token: "synthetic-token",
  enterprise: "example-enterprise",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function rawPage(body: string) {
  return new Response(body, { status: 200 });
}

const individual = {
  id: "individual-1",
  budget_type: "BundlePricing",
  budget_product_sku: "ai_credits",
  budget_scope: "user",
  budget_amount: 10,
};

describe("GitHub Budget Lookup client", () => {
  it("reads the user's effective budget, then that budget by ID, with fixed GET requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        budgets: [{ id: "other" }],
        has_next_page: true,
        total_count: 40,
        effective_budget: { id: "individual-1", budget_amount: 10, consumed_amount: 2.5 },
      }))
      .mockResolvedValueOnce(json(individual));

    const result = await createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user");

    expect(result).toEqual({
      individualBudgets: [{ ...individual, budget_amount: "10", consumed_amount: "2.5" }],
      defaultPerUserBudgets: [],
      effectiveBudget: { id: "individual-1", budget_amount: "10", consumed_amount: "2.5" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBe("2026-03-10");
      expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github+json");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    }
    const list = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(list.origin + list.pathname).toBe("https://api.github.com/enterprises/example-enterprise/settings/billing/budgets");
    expect(Object.fromEntries(list.searchParams)).toEqual({ user: "octo-user", per_page: "1" });
    expect(String(fetchImpl.mock.calls[1]![0]))
      .toBe("https://api.github.com/enterprises/example-enterprise/settings/billing/budgets/individual-1");
  });

  it("files the default per-user budget separately and preserves decimal JSON tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(rawPage('{"budgets":[],"effective_budget":{"id":"default-1","budget_amount":9007199254740993,"consumed_amount":0.123456789}}'))
      .mockResolvedValueOnce(rawPage('{"id":"default-1","budget_type":"BundlePricing","budget_product_sku":"ai_credits","budget_scope":"multi_user_customer","budget_amount":9007199254740993}'));

    const result = await createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user");

    expect(result.individualBudgets).toEqual([]);
    expect(result.defaultPerUserBudgets).toEqual([expect.objectContaining({
      id: "default-1", budget_amount: "9007199254740993", consumed_amount: "0.123456789",
    })]);
  });

  it("returns no budgets when GitHub reports no effective budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ budgets: [], has_next_page: false, total_count: 0 }));

    await expect(createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user"))
      .resolves.toEqual({ individualBudgets: [], defaultPerUserBudgets: [], effectiveBudget: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the effective figure but no definition when the budget is gone or out of scope", async () => {
    const effective = { budgets: [], effective_budget: { id: "cc-1", budget_amount: 5, consumed_amount: 1 } };
    const goneFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(effective))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const gone = await createBudgetLookupClient({ ...config, fetchImpl: goneFetch }).read("octo-user");
    expect(gone).toMatchObject({ individualBudgets: [], defaultPerUserBudgets: [], effectiveBudget: { id: "cc-1" } });

    const costCenterFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(effective))
      .mockResolvedValueOnce(json({ ...individual, id: "cc-1", budget_scope: "cost_center" }));
    const costCenter = await createBudgetLookupClient({ ...config, fetchImpl: costCenterFetch }).read("octo-user");
    expect(costCenter).toMatchObject({ individualBudgets: [], defaultPerUserBudgets: [] });
  });

  it("rejects malformed responses and mismatched identities", async () => {
    const cases: unknown[][] = [
      [[]],
      [{ effective_budget: "not-an-object" }],
      [{ effective_budget: { budget_amount: 5 } }],
      [{ user: "another-user", effective_budget: { id: "individual-1" } }],
      [{ effective_budget: { id: "individual-1" } }, { ...individual, id: "different" }],
    ];
    for (const responses of cases) {
      const fetchImpl = vi.fn<typeof fetch>();
      for (const body of responses) fetchImpl.mockResolvedValueOnce(json(body));
      await expect(createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user"))
        .rejects.toMatchObject({ code: "budget_source_invalid" });
    }
    const malformed = vi.fn<typeof fetch>().mockResolvedValueOnce(rawPage("{"));
    await expect(createBudgetLookupClient({ ...config, fetchImpl: malformed }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_invalid" });
  });

  it("maps provider errors, rate limits and deadlines to typed failures", async () => {
    for (const status of [403, 404, 500]) {
      const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      await expect(createBudgetLookupClient({ ...config, fetchImpl: providerFetch }).read("octo-user"))
        .rejects.toMatchObject({ code: "budget_source_unavailable" });
    }

    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "30" } }));
    await expect(createBudgetLookupClient({ ...config, fetchImpl: limited }).read("octo-user"))
      .rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 30 });

    const hangingFetch = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(createBudgetLookupClient({
      ...config,
      fetchImpl: hangingFetch,
      timeoutMs: 1,
    }).read("octo-user")).rejects.toMatchObject({ code: "budget_source_timeout" });
  });

  it("reports permission observations for health", async () => {
    const observed: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(createBudgetLookupClient({
      ...config, fetchImpl, onPermissionObservation: (status) => observed.push(status),
    }).read("octo-user")).rejects.toBeInstanceOf(BudgetLookupSourceError);
    expect(observed).toEqual([401]);
  });

  it("rejects redirects without following an alternate source destination", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("fetch failed: unexpected redirect");
    });

    await expect(createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["request", "response body"])("aborts the by-ID %s IO at the overall deadline", async (phase) => {
    vi.useFakeTimers();
    try {
      const aborted = vi.fn();
      let pendingSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(json({ effective_budget: { id: "individual-1", budget_amount: 10 } }))
        .mockImplementationOnce(async (_input, init) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Missing provider cancellation signal");
          pendingSignal = signal;
          if (phase === "request") {
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted();
                reject(signal.reason);
              }, { once: true });
            });
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => {
                aborted();
                controller.error(signal.reason);
              }, { once: true });
            },
          }), { status: 200 });
        });
      const lookup = createBudgetLookupClient({ ...config, fetchImpl, timeoutMs: 50 }).read("octo-user");
      const rejection = expect(lookup).rejects.toMatchObject({ code: "budget_source_timeout" });

      await vi.advanceTimersByTimeAsync(10);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(pendingSignal?.aborted).toBe(false);
      expect(aborted).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
      expect(pendingSignal?.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects missing credentials and malformed target identifiers before source access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createBudgetLookupClient({ ...config, token: "", fetchImpl }).read("octo-user"))
      .rejects.toBeInstanceOf(BudgetLookupSourceError);
    await expect(createBudgetLookupClient({ ...config, fetchImpl }).read("invalid/login"))
      .rejects.toMatchObject({ code: "budget_source_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
