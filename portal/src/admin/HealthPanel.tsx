import type { HealthRunObservation } from "./queries";

export default function HealthPanel({ runs, observedAt }: { runs: HealthRunObservation[]; observedAt: number }) {
  const usage = runs.find((run) => run.source_kind === "users_1_day");
  const age = usage?.last_success ? ((observedAt - usage.last_success.getTime()) / 3600000).toFixed(1) : null;
  return <section className="space-y-4" aria-label="Health">
    <h2 className="text-xl font-semibold">Health</h2>
    <p>SQL reachable: Yes (ingestion state query completed).</p>
    <p>Last successful usage ingestion: {usage?.last_success?.toISOString() ?? "Unavailable — no published run recorded"}.
      {" "}Age: {age === null ? "Unavailable" : `${age} hours`}.</p>
    <table className="w-full text-left">
      <caption className="text-left font-semibold">Module observations</caption>
      <thead><tr>{["Module", "Enabled", "Secret present", "Permission OK", "Last run"].map((item) => <th className="p-3" key={item}>{item}</th>)}</tr></thead>
      <tbody>{[
        { name: "AI Credits", enabled: process.env.MODULE_AI_CREDITS, run: runs.find((run) => run.source_kind === "ai_credit")?.last_run },
        { name: "Budget Lookup", enabled: process.env.MODULE_BUDGET_LOOKUP, run: null },
        { name: "Feedback", enabled: process.env.MODULE_FEEDBACK, run: null },
      ].map((module) => <tr key={module.name} className="border-t border-default">
        <td className="p-3">{module.name}</td><td className="p-3">{module.enabled === "true" ? "Yes" : module.enabled === "false" ? "No" : "Not configured"}</td>
        <td className="p-3">Unknown</td><td className="p-3">Unknown</td><td className="p-3">{module.run?.toISOString() ?? "Unavailable"}</td>
      </tr>)}</tbody>
    </table>
    <p>Secret and permission observations are not supplied by the owning workers. The portal does not read their credentials
      or probe external services. Unavailable observations do not mean healthy.</p>
    <p>The public /api/health endpoint currently reports application liveness only, not these operational checks.</p>
  </section>;
}
