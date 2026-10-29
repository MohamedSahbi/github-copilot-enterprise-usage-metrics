import { describe, expect, it } from "vitest";
import type { SyncRunObservation } from "./queries";
import { STALLED_AFTER_MS, summarizeSync, syncWarnings } from "./sync-status";

const now = Date.parse("2026-10-29T12:00:00Z");
const run = (values: Partial<SyncRunObservation> = {}): SyncRunObservation => ({
  source_kind: "directory", last_started_at: null, last_started_open: null, last_status: null,
  last_completed_at: null, last_report_day: null, last_error_code: null, last_error_message: null,
  last_correlation_id: null, last_success_at: null, failed_last_24h: 0, ...values,
});

describe("sync status", () => {
  it("treats a sync with no runs as idle with no result and no warning", () => {
    expect(summarizeSync(run(), now)).toMatchObject({ activity: "idle", result: "none" });
    expect(syncWarnings([run()], now)).toEqual([]);
  });

  it("shows a published run as succeeded and hides its error fields", () => {
    const sync = summarizeSync(run({ last_status: "published", last_error_code: "stale", last_completed_at: new Date(now) }), now);
    expect(sync).toMatchObject({ result: "succeeded", errorCode: null, errorMessage: null });
  });

  it("warns on a failed or quarantined last run with its error", () => {
    const failed = run({ last_status: "failed", last_error_code: "graph_throttled", last_error_message: "429 from Graph",
      last_completed_at: new Date(now - 60000) });
    const quarantined = run({ source_kind: "users_1_day", last_status: "quarantined", last_error_code: "smaller_day_blocked",
      last_report_day: new Date("2026-10-28T00:00:00Z") });
    expect(syncWarnings([failed, quarantined], now).map((sync) => [sync.source, sync.result, sync.errorCode])).toEqual([
      ["directory", "failed", "graph_throttled"], ["users_1_day", "quarantined", "smaller_day_blocked"],
    ]);
    expect(summarizeSync(quarantined, now).reportDay).toBe("2026-10-28");
  });

  it("keeps warning about a failed last run while a new run is in progress", () => {
    const sync = run({ last_status: "failed", last_started_open: true, last_started_at: new Date(now - 60000) });
    expect(summarizeSync(sync, now).activity).toBe("in-progress");
    expect(syncWarnings([sync], now)).toHaveLength(1);
  });

  it("flags an open run as stalled after the threshold", () => {
    const fresh = run({ last_status: "published", last_started_open: true, last_started_at: new Date(now - STALLED_AFTER_MS + 1000) });
    const stuck = run({ last_status: "published", last_started_open: true, last_started_at: new Date(now - STALLED_AFTER_MS - 1000) });
    expect(summarizeSync(fresh, now).activity).toBe("in-progress");
    expect(syncWarnings([fresh], now)).toEqual([]);
    expect(syncWarnings([stuck], now).map((sync) => sync.activity)).toEqual(["stalled"]);
  });

  it("ignores an old open run once a newer run started", () => {
    const superseded = run({ last_status: "published", last_started_open: false, last_started_at: new Date(now - 60000) });
    expect(summarizeSync(superseded, now).activity).toBe("idle");
  });

  it("does not warn about a cancelled run", () => {
    expect(syncWarnings([run({ last_status: "cancelled" })], now)).toEqual([]);
  });
});
