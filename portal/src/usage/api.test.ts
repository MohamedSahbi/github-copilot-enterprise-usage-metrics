import { describe, expect, it } from "vitest";
import { parseBreakdown, parsePage, parseUsagePeriod } from "./api";

describe("usage API request validation", () => {
  it("accepts only the supported fixed periods and rejects raw or arbitrary date ranges", () => {
    for (const period of ["last_7_days", "last_28_days", "last_90_days"]) {
      expect(parseUsagePeriod(new URLSearchParams(`period=${period}`))).toMatchObject({ ok: true, period: { period } });
    }
    expect(parseUsagePeriod(new URLSearchParams("period=calendar_month&month=2026-02"))).toMatchObject({
      ok: true,
      period: { period: "calendar_month", month: "2026-02" },
    });
    expect(parseUsagePeriod(new URLSearchParams("from=2026-03-01&to=2026-03-02"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
    expect(parseUsagePeriod(new URLSearchParams("period=custom&from=2026-03-01&to=2026-03-02"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
    expect(parseUsagePeriod(new URLSearchParams("period=calendar_month"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
    expect(parseUsagePeriod(new URLSearchParams("period=last_7_days&month=2026-02"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
  });

  it("accepts positive safe organization IDs and rejects malformed identifiers", () => {
    expect(parseUsagePeriod(new URLSearchParams("period=last_7_days&organizationIds=12,15&organizationIds=12")))
      .toMatchObject({ ok: true, period: { organizationIds: [12, 15] } });
    expect(parseUsagePeriod(new URLSearchParams("period=last_7_days&organizationIds=1abc"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
    expect(parseUsagePeriod(new URLSearchParams(`period=last_7_days&organizationIds=${Number.MAX_SAFE_INTEGER + 1}`))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
  });

  it("uses the shared paging defaults and rejects invalid or over-limit pages", () => {
    expect(parsePage(new URLSearchParams("")).page).toEqual({ page: 1, pageSize: 50 });
    expect(parsePage(new URLSearchParams("page=2&pageSize=100")).page).toEqual({ page: 2, pageSize: 100 });
    expect(parsePage(new URLSearchParams("page=0"))).toMatchObject({ ok: false, failure: { code: "invalid_request" } });
    expect(parsePage(new URLSearchParams("pageSize=101"))).toMatchObject({ ok: false, failure: { code: "page_size_too_large" } });
    expect(parsePage(new URLSearchParams("page=9007199254740991&pageSize=100"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
  });

  it("requires a supported breakdown kind", () => {
    expect(parseBreakdown(new URLSearchParams("period=last_7_days&kind=feature")).ok).toBe(true);
    expect(parseBreakdown(new URLSearchParams("period=last_7_days&kind=account"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
  });
});
