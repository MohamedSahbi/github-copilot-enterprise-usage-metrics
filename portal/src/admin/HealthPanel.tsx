import type { HealthRunObservation } from "./queries";
import { Card, DataTable } from "../components/SubPageFrame";

export default function HealthPanel({ runs, observedAt }: { runs: HealthRunObservation[]; observedAt: number }) {
  const usage = runs.find((run) => run.source_kind === "users_1_day");
  const age = usage?.last_success ? ((observedAt - usage.last_success.getTime()) / 3600000).toFixed(1) : null;
  const modules = [
    { name: "AI Credits", enabled: process.env.MODULE_AI_CREDITS, run: runs.find((run) => run.source_kind === "ai_credit")?.last_run },
    { name: "Budget Lookup", enabled: process.env.MODULE_BUDGET_LOOKUP, run: null },
    { name: "Feedback", enabled: process.env.MODULE_FEEDBACK, run: null },
  ];
  return <section className="space-y-6" aria-label="Health">
    <Card title="Health">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-default bg-[#f6f8fa] p-3 text-sm">
          <p>SQL reachable: Yes (ingestion state query completed).</p>
        </div>
        <div className="rounded-md border border-default bg-[#f6f8fa] p-3 text-sm">
          <p>Last successful usage ingestion: {usage?.last_success?.toISOString() ?? "Unavailable — no published run recorded"}.
            {" "}Age: {age === null ? "Unavailable" : `${age} hours`}.</p>
        </div>
      </div>
      <DataTable caption="Module observations" headings={["Module", "Enabled", "Secret present", "Permission OK", "Last run"]}
        rows={modules.map((module) => [module.name,
          module.enabled === "true" ? "Yes" : module.enabled === "false" ? "No" : "Not configured",
          "Unknown", "Unknown", module.run?.toISOString() ?? "Unavailable"])} />
      <p className="text-sm text-muted">Secret and permission observations are not supplied by the owning workers. The portal does not read their credentials
        or probe external services. Unavailable observations do not mean healthy.</p>
      <p className="text-sm text-muted">The public /api/health endpoint currently reports application liveness only, not these operational checks.</p>
    </Card>
  </section>;
}
