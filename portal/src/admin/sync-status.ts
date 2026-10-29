import type { SyncRunObservation } from "./queries";

export const SYNC_LABELS = { directory: "Directory sync (Entra)", users_1_day: "Metrics sync (GitHub)" } as const;
// The newest run still open after this long most likely stopped without recording a result.
// Older open runs are ignored once a newer run started, so one crashed run does not warn forever.
export const STALLED_AFTER_MS = 2 * 3600000;

// Both timers are expected to run at least daily. No new run for this long means the timer did not fire or the
// function app failed before it could record a run (host down, startup or configuration error, SQL unreachable).
export const OVERDUE_AFTER_MS = 26 * 3600000;

export type SyncActivity = "idle" | "in-progress" | "stalled" | "overdue";
export type SyncResult = "none" | "succeeded" | "failed" | "quarantined" | "cancelled";
export interface SyncSummary {
  source: SyncRunObservation["source_kind"];
  label: string;
  activity: SyncActivity;
  result: SyncResult;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastSuccessAt: Date | null;
  reportDay: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  correlationId: string | null;
  failedLast24h: number;
}

export function summarizeSync(run: SyncRunObservation, now: number): SyncSummary {
  const open = run.last_started_open === true && run.last_started_at !== null;
  const result: SyncResult = run.last_status === null ? "none"
    : run.last_status === "published" ? "succeeded"
    : run.last_status === "quarantined" || run.last_status === "cancelled" ? run.last_status : "failed";
  return {
    source: run.source_kind, label: SYNC_LABELS[run.source_kind], result,
    activity: open ? (now - run.last_started_at!.getTime() > STALLED_AFTER_MS ? "stalled" : "in-progress")
      : run.last_started_at !== null && now - run.last_started_at.getTime() > OVERDUE_AFTER_MS ? "overdue" : "idle",
    lastStartedAt: run.last_started_at,
    lastCompletedAt: run.last_completed_at, lastSuccessAt: run.last_success_at,
    reportDay: run.last_report_day?.toISOString().slice(0, 10) ?? null,
    errorCode: result === "succeeded" ? null : run.last_error_code,
    errorMessage: result === "succeeded" ? null : run.last_error_message,
    correlationId: run.last_correlation_id, failedLast24h: run.failed_last_24h,
  };
}

// Warn when the last finished run failed or was quarantined, a run looks stuck, or no run started for over a day.
// A sync that never ran is not a warning: it may simply be switched off.
export function syncWarnings(runs: SyncRunObservation[], now: number): SyncSummary[] {
  return runs.map((run) => summarizeSync(run, now))
    .filter((sync) => sync.activity === "stalled" || sync.activity === "overdue" || sync.result === "failed" || sync.result === "quarantined");
}
