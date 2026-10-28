"use client";

import { useState, type FormEvent } from "react";
import type { InboxIssue } from "../../../shared/src/issues";
import { alertClass, buttonClass, fieldClass, statusClass } from "../components/SubPageFrame";

export default function IssuesInbox({ issues }: { issues: InboxIssue[] }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  async function apply(event: FormEvent<HTMLFormElement>, issue: InboxIssue) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/issues/actions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: issue.issueId, action: form.get("action"), confirm: form.get("confirm") === "on", confirmDate: form.get("confirmDate") || undefined }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${result.error?.code ?? "request_failed"} (reference ${result.error?.correlationId ?? "unavailable"})`);
      setChosen([...chosen, issue.issueId]);
      setMessage(result.data.reprocessRequested
        ? "Action recorded for ingestion. No reprocessing has been executed by the portal."
        : "Issue dismissed.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Action failed."); }
    finally { setPending(false); }
  }
  return <section aria-label="Issues inbox" className="space-y-4">
    <p className="text-sm text-muted">The portal records the chosen action; ingestion owns reprocessing. Each issue accepts one confirmed action.</p>
    {error && <p role="alert" className={alertClass}>{error}</p>}{message && <p role="status" className={statusClass}>{message}</p>}
    {issues.length === 0 && <p className="rounded-md border border-default bg-white px-4 py-8 text-center text-sm text-muted">No ingestion issues found.</p>}
    {issues.map((issue) => <article key={issue.issueId} className="rounded-md border border-default bg-white p-4 shadow-sm">
      <h2 className="font-semibold">Issue {issue.issueId}: {issue.type}</h2>
      <p className="mt-1 text-sm text-muted">{issue.errorCode} | {issue.reportDay ?? "No report day"} | {issue.status}</p>
      {issue.availableActions.length > 0 && !chosen.includes(issue.issueId) && <form onSubmit={(event) => apply(event, issue)} className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label>Action <select name="action" className={fieldClass}>
          {issue.availableActions.map((action) => <option key={action}>{action}</option>)}
        </select></label>
        <label>Confirm report date (required to force an empty day) <input name="confirmDate" type="date" className={fieldClass} /></label>
        <label><input required name="confirm" type="checkbox" /> Confirm this action</label>
        <button disabled={pending} className={buttonClass}>Apply action</button>
      </form>}
    </article>)}
  </section>;
}
