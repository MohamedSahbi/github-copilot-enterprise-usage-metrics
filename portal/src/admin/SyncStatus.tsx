import Link from "next/link";
import type { SyncRunObservation } from "./queries";
import { STALLED_AFTER_MS, summarizeSync, type SyncSummary } from "./sync-status";
import { Card, alertClass } from "../components/SubPageFrame";

const time = (value: Date | null) => value?.toISOString() ?? "-";
const RESULT_TEXT = { none: "No finished run recorded", succeeded: "Succeeded", failed: "Failed",
  quarantined: "Quarantined (data held for review)", cancelled: "Cancelled" } as const;

function activityText(sync: SyncSummary) {
  if (sync.activity === "idle") return "No";
  if (sync.activity === "in-progress") return `Yes, since ${time(sync.lastStartedAt)}`;
  return `Possibly stalled: started ${time(sync.lastStartedAt)}, no result after ${STALLED_AFTER_MS / 3600000} hours`;
}

function failureText(sync: SyncSummary) {
  if (sync.result === "succeeded" || sync.result === "none") return "-";
  return [sync.errorCode, sync.errorMessage].filter(Boolean).join(": ") || "No error detail recorded";
}

export default function SyncStatus({ runs, observedAt }: { runs: SyncRunObservation[]; observedAt: number }) {
  const syncs = runs.map((run) => summarizeSync(run, observedAt));
  return <section className="space-y-6" aria-label="Sync status">
    <div className="grid gap-6 lg:grid-cols-2">
      {syncs.map((sync) => <Card key={sync.source} title={sync.label}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          {([
            ["Last run started", time(sync.lastStartedAt)],
            ["In progress", activityText(sync)],
            ["Last result", sync.source === "users_1_day" && sync.reportDay ? `${RESULT_TEXT[sync.result]} (day ${sync.reportDay})` : RESULT_TEXT[sync.result]],
            ["Finished", time(sync.lastCompletedAt)],
            ["Failure", failureText(sync)],
            ["Last success", time(sync.lastSuccessAt)],
            ["Failed runs (24 hours)", String(sync.failedLast24h)],
            ["Correlation ID", sync.correlationId ?? "-"],
          ] as const).map(([term, value]) => <div key={term} className="contents">
            <dt className="font-semibold">{term}</dt><dd className="break-words">{value}</dd>
          </div>)}
        </dl>
      </Card>)}
    </div>
    <p className="text-sm text-muted">Read from the run records the sync workers already write. Times are UTC.
      The metrics sync records one run per organization and day, so its last result is the most recently finished day.
      No run recorded usually means the sync is not enabled.</p>
  </section>;
}

export function SyncWarning({ warnings }: { warnings: SyncSummary[] }) {
  if (warnings.length === 0) return null;
  return <section role="alert" className={alertClass}>
    <h2 className="font-semibold text-[#d1242f]">Sync needs attention</h2>
    <ul className="mt-1 list-disc pl-5">{warnings.map((sync) => <li key={sync.source}>
      {sync.label}: {sync.activity === "stalled" ? `a run started ${time(sync.lastStartedAt)} has not finished.`
        : `last run ${sync.result} at ${time(sync.lastCompletedAt)}${sync.errorCode ? ` (${sync.errorCode})` : ""}.`}
    </li>)}</ul>
    <p className="mt-1"><Link href="/admin?section=sync" className="underline">View sync status</Link></p>
  </section>;
}
