import { describe, expect, it, vi } from "vitest";
import { BudgetLookupSourceError, createBudgetLookupClient } from "./client";

const config = {
  token: "synthetic-token",
  enterprise: "example-enterprise",
};

function page(budgets: unknown[], hasNextPage: boolean, totalCount: number, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    budgets,
    has_next_page: hasNextPage,
    total_count: totalCount,
    ...extra,
  }), { status: 200 });
}

function rawPage(body: string) {
  return new Response(body, { status: 200 });
}

describe("GitHub Budget Lookup client", () => {
  it("uses only the fixed GET endpoint and completes all three user-filtered lists", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([{ id: "individual-1", budget_amount: 10 }], false, 1))
      .mockResolvedValueOnce(page([{ id: "default-1", budget_amount: 20 }], false, 1))
      .mockResolvedValueOnce(page([], false, 0, {
        user: "octo-user",
        effective_budget: { id: "individual-1", budget_amount: 10 },
      }));

    const result = await createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user");

    expect(result.individualBudgets).toEqual([{ id: "individual-1", budget_amount: "10" }]);
    expect(result.defaultPerUserBudgets).toEqual([{ id: "default-1", budget_amount: "20" }]);
    expect(result.effectiveBudget).toEqual({ id: "individual-1", budget_amount: "10" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(String(input)).toMatch(/^https:\/\/api\.github\.com\/enterprises\/example-enterprise\/settings\/billing\/budgets\?/);
      expect(init?.method).toBe("GET");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBe("2026-03-10");
      expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github+json");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
      const url = new URL(String(input));
      expect(url.searchParams.get("user")).toBe("octo-user");
      expect(url.searchParams.get("per_page")).toBe("100");
      expect(url.searchParams.get("page")).toBe("1");
    }
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get("scope")).toBe("user");
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("scope")).toBe("multi_user_customer");
    expect(new URL(String(fetchImpl.mock.calls[2]![0])).searchParams.has("scope")).toBe(false);
  });

  it("follows explicit pagination and preserves decimal JSON tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(rawPage('{"budgets":[{"id":"one","budget_amount":0.123456789012345}],"has_next_page":true,"total_count":2}'))
      .mockResolvedValueOnce(rawPage('{"budgets":[{"id":"two","budget_amount":9007199254740993}],"has_next_page":false,"total_count":2}'))
      .mockResolvedValueOnce(page([], false, 0, { effective_budget: "ignored-user-list-metadata" }))
      .mockResolvedValueOnce(page([], false, 0, { user: "octo-user" }));

    const result = await createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user");

    expect(result.individualBudgets).toEqual([
      { id: "one", budget_amount: "0.123456789012345" },
      { id: "two", budget_amount: "9007199254740993" },
    ]);
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("page")).toBe("2");
  });

  it("rejects incomplete pages instead of returning partial budgets", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ budgets: [{ id: "one" }], total_count: 1 }), { status: 200 }));

    await expect(createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_incomplete" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed source pages and conflicting effective metadata", async () => {
    const malformedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([{ budget_amount: 10 }], false, 1));
    await expect(createBudgetLookupClient({ ...config, fetchImpl: malformedFetch }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_invalid" });

    const conflictingFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([], false, 0, { effective_budget: { id: "ignored-user-list-metadata" } }))
      .mockResolvedValueOnce(page([], false, 0, { effective_budget: { id: "ignored-default-list-metadata" } }))
      .mockResolvedValueOnce(page([{ id: "one" }], true, 2, {
        user: "octo-user",
        effective_budget: { id: "effective-one", budget_amount: 5 },
      }))
      .mockResolvedValueOnce(page([{ id: "two" }], false, 2, {
        user: "octo-user",
        effective_budget: { id: "effective-two", budget_amount: 5 },
      }));
    await expect(createBudgetLookupClient({ ...config, fetchImpl: conflictingFetch }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_invalid" });
  });

  it.each(["another-user", undefined])("rejects an unscoped effective response for user %s", async (user) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([], false, 0))
      .mockResolvedValueOnce(page([], false, 0))
      .mockResolvedValueOnce(page([], false, 0, user === undefined ? {} : { user }));
    await expect(createBudgetLookupClient({ ...config, fetchImpl }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_invalid" });
  });

  it("maps provider errors and deadlines to typed failures", async () => {
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(createBudgetLookupClient({ ...config, fetchImpl: providerFetch }).read("octo-user"))
      .rejects.toMatchObject({ code: "budget_source_unavailable" });

    const hangingFetch = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(createBudgetLookupClient({
      ...config,
      fetchImpl: hangingFetch,
      timeoutMs: 1,
    }).read("octo-user")).rejects.toMatchObject({ code: "budget_source_timeout" });
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

  it.each(["request", "response body"])("aborts later-page %s IO at the overall deadline", async (phase) => {
    vi.useFakeTimers();
    try {
      const aborted = vi.fn();
      let pendingSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(page([{ id: "first" }], true, 2))
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
      expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("page")).toBe("2");
      expect(pendingSignal?.aborted).toBe(false);
      expect(aborted).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
      expect(pendingSignal?.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
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
