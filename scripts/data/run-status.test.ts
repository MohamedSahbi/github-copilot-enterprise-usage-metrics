import { describe, expect, it } from "vitest";
import { daysBetween, parseRunStatusArguments, summarizeRuns, type RunRow } from "./run-status";

const NOW = new Date("2026-10-29T18:00:00Z");

function run(overrides: Partial<RunRow>): RunRow {
  return {
    scope_key: "101", report_day: "2026-09-01", status: "published", is_current: true, rows_loaded: 10,
    rows_quarantined: 0, error_code: null, synthetic: false, run_id: "00000000-0000-4000-8000-0000000000A1", ...overrides,
  };
}

describe("run-status arguments", () => {
  it("needs --from and defaults --to to yesterday (UTC)", () => {
    expect(parseRunStatusArguments(["--from", "2026-09-01"], NOW)).toEqual({ from: "2026-09-01", to: "2026-10-28" });
    expect(parseRunStatusArguments(["--from", "2026-09-01", "--to", "2026-09-03"], NOW)).toEqual({ from: "2026-09-01", to: "2026-09-03" });
    expect(() => parseRunStatusArguments([], NOW)).toThrow();
  });

  it("rejects bad days, reversed or oversized ranges and unknown flags", () => {
    expect(() => parseRunStatusArguments(["--from", "2026-02-30"], NOW)).toThrow();
    expect(() => parseRunStatusArguments(["--from", "2026-09-03", "--to", "2026-09-01"], NOW)).toThrow();
    expect(() => parseRunStatusArguments(["--from", "2024-01-01"], NOW)).toThrow();
    expect(() => parseRunStatusArguments(["--from", "2026-09-01", "--from", "2026-09-02"], NOW)).toThrow();
    expect(() => parseRunStatusArguments(["--from", "2026-09-01", "--days", "3"], NOW)).toThrow();
  });

  it("lists every day of the range inclusive", () => {
    expect(daysBetween("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

describe("run-status summary", () => {
  it("classifies each scope and day and lists synthetic runs", () => {
    const report = summarizeRuns({ from: "2026-09-01", to: "2026-09-03" }, ["101", "202"], [
      run({ rows_quarantined: 2 }),
      run({ report_day: "2026-09-02", status: "failed", is_current: false, error_code: "fetch_failed", rows_loaded: null }),
      run({ report_day: "2026-09-02", status: "failed", is_current: false, error_code: "invalid_response", rows_loaded: null }),
      run({ report_day: "2026-09-03", status: "started", is_current: false }),
      run({ scope_key: "202", report_day: "2026-09-03", synthetic: true }),
    ]);
    expect(report.scopes).toBe(2);
    expect(report.totals).toEqual({ published: 2, failed: 1, started: 1, gap: 2 });
    expect(report.syntheticRunIds).toEqual(["00000000-0000-4000-8000-0000000000a1"]);
    expect(report.days).toEqual([
      { day: "2026-09-01", scope: "101", state: "published", rowsLoaded: 10, rowsQuarantined: 2, failedAttempts: 0 },
      { day: "2026-09-01", scope: "202", state: "gap", rowsLoaded: 0, rowsQuarantined: 0, failedAttempts: 0 },
      { day: "2026-09-02", scope: "101", state: "failed", rowsLoaded: 0, rowsQuarantined: 0, failedAttempts: 2, lastError: "invalid_response" },
      { day: "2026-09-02", scope: "202", state: "gap", rowsLoaded: 0, rowsQuarantined: 0, failedAttempts: 0 },
      { day: "2026-09-03", scope: "101", state: "started", rowsLoaded: 0, rowsQuarantined: 0, failedAttempts: 0 },
      { day: "2026-09-03", scope: "202", state: "published", rowsLoaded: 10, rowsQuarantined: 0, failedAttempts: 0, synthetic: true },
    ]);
  });
});
