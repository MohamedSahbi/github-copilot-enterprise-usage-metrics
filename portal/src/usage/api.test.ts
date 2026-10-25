import { describe, expect, it } from "vitest";
import { parseBreakdown, parsePage, parseRange } from "./api";

describe("usage API request validation", () => {
  it("requires valid ISO dates and enforces the shared maximum range", () => {
    expect(parseRange(new URLSearchParams("from=2026-02-30&to=2026-03-02"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
    expect(parseRange(new URLSearchParams("from=2025-01-01&to=2026-03-02"))).toMatchObject({
      ok: false,
      failure: { code: "date_range_too_large" },
    });
    expect(parseRange(new URLSearchParams("from=2026-03-01&to=2026-03-02")).ok).toBe(true);
  });

  it("accepts positive safe organization IDs and rejects malformed identifiers", () => {
    expect(parseRange(new URLSearchParams("from=2026-03-01&to=2026-03-02&organizationIds=12,15&organizationIds=12")))
      .toMatchObject({ ok: true, range: { organizationIds: [12, 15] } });
    expect(parseRange(new URLSearchParams("from=2026-03-01&to=2026-03-02&organizationIds=1abc"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
    expect(parseRange(new URLSearchParams(`from=2026-03-01&to=2026-03-02&organizationIds=${Number.MAX_SAFE_INTEGER + 1}`))).toMatchObject({
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
    expect(parseBreakdown(new URLSearchParams("from=2026-03-01&to=2026-03-02&kind=feature")).ok).toBe(true);
    expect(parseBreakdown(new URLSearchParams("from=2026-03-01&to=2026-03-02&kind=account"))).toMatchObject({
      ok: false,
      failure: { code: "invalid_request" },
    });
  });
});
