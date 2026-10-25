import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_GROUP_SIZE, MAX_DATE_RANGE_DAYS, MAX_PAGE_SIZE, normalizePage, suppress, validateDateRange } from "../../shared/src/api";

describe("API contract helpers", () => {
  it.each(["2025-02-31", "2025-02-29", "2026-04-31", "2026-00-01", "2026-13-01"])("rejects invalid calendar date %s at either boundary", (day) => {
    expect(validateDateRange({ from: day, to: "2026-12-31" })).toEqual({ ok: false, code: "invalid_request" });
    expect(validateDateRange({ from: "2025-01-01", to: day })).toEqual({ ok: false, code: "invalid_request" });
  });

  it("accepts a real leap day", () => {
    expect(validateDateRange({ from: "2024-02-29", to: "2024-03-01" })).toEqual({ ok: true });
  });

  it("bounds date ranges", () => {
    expect(validateDateRange({ from: "2026-01-01", to: "2026-01-31" })).toEqual({ ok: true });
    expect(validateDateRange({ from: "2026-02-01", to: "2026-01-01" })).toEqual({ ok: false, code: "invalid_request" });
    expect(validateDateRange({ from: "2026-1-1", to: "2026-01-02" })).toEqual({ ok: false, code: "invalid_request" });
    expect(validateDateRange({ from: "2025-01-01", to: "2026-12-31" })).toEqual({ ok: false, code: "date_range_too_large" });
    const edge = new Date(Date.UTC(2026, 0, 1) + (MAX_DATE_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    expect(validateDateRange({ from: "2026-01-01", to: edge })).toEqual({ ok: true });
  });

  it("bounds page sizes", () => {
    expect(normalizePage({})).toEqual({ page: 1, pageSize: 50 });
    expect(normalizePage({ pageSize: MAX_PAGE_SIZE + 1 })).toEqual({ error: "page_size_too_large" });
    expect(normalizePage({ page: 0 })).toEqual({ error: "invalid_request" });
  });

  it("fails closed on a lowered threshold or an invalid count", () => {
    expect(suppress(2, 0, 1, false).suppressed).toBe(true);
    expect(suppress(Number.NaN, 5, 1, false).suppressed).toBe(true);
    expect(suppress(3, Number.NaN, 1, false).suppressed).toBe(true);
  });

  it("suppresses small groups unless names are visible to the viewer", () => {
    expect(DEFAULT_MIN_GROUP_SIZE).toBe(5);
    expect(suppress(4, 5, { n: 1 }, false)).toEqual({ suppressed: true, userCount: null, value: null });
    expect(suppress(5, 5, { n: 1 }, false).suppressed).toBe(false);
    expect(suppress(2, 5, { n: 1 }, true).suppressed).toBe(false);
  });
});
