import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { BudgetLookupData } from "../../../../../shared/src/api";
import { BudgetLookupSourceError } from "../../../budget/client";
import { lookupBudget } from "../../../budget/service";
import { GET } from "./route";

vi.mock("../../../budget/service", () => ({ lookupBudget: vi.fn() }));

const data: BudgetLookupData = {
  userId: 123,
  budgets: [],
  effectiveBudget: { status: "not_reported" },
  amountUnit: "USD",
  cycle: "calendar_month_utc",
};

describe("GET /api/budget-lookup", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects extra and duplicate query parameters before authorization or source access", async () => {
    for (const url of [
      "http://localhost/api/budget-lookup?userId=123&userId=123",
      "http://localhost/api/budget-lookup?login=octo-user",
    ]) {
      const response = await GET(new NextRequest(url));
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error.code).toBe("invalid_request");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(lookupBudget).not.toHaveBeenCalled();
  });

  it("returns a private, no-store response for authorized data", async () => {
    vi.mocked(lookupBudget).mockResolvedValue({ state: "ok", data });
    const request = new NextRequest("http://localhost/api/budget-lookup?userId=123");

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Correlation-ID")).toBeTruthy();
    expect((await response.json()).data).toEqual(data);
    expect(lookupBudget).toHaveBeenCalledWith(
      expect.any(String),
      { target: "user", userId: 123 },
      undefined,
      request.signal,
    );
  });

  it.each([
    ["budget_source_unavailable", 503],
    ["budget_source_timeout", 504],
    ["budget_source_invalid", 502],
    ["budget_source_incomplete", 502],
    ["rate_limited", 429],
  ] as const)("maps %s to its typed status without returning partial data", async (code, status) => {
    vi.mocked(lookupBudget).mockRejectedValue(new BudgetLookupSourceError(code, "provider details", 60));
    const response = await GET(new NextRequest("http://localhost/api/budget-lookup"));
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.data).toBeUndefined();
    expect(body.error.code).toBe(code);
    expect(body.error.message).not.toContain("provider details");
    if (code === "rate_limited") expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("maps a denied target without contacting the source", async () => {
    vi.mocked(lookupBudget).mockResolvedValue({ state: "denied", code: "forbidden" });
    const response = await GET(new NextRequest("http://localhost/api/budget-lookup?userId=456"));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });
});
