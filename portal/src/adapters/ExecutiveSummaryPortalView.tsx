import type { AggregatedMetrics } from "@upstream/types/aggregatedMetrics";
import { selectExecutiveSummaryReadModel } from "@upstream/read-models/overview";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function formatNumber(value: number | null) {
  return value === null ? "N/A" : numberFormat.format(value);
}

function formatDate(day: string) {
  return dateFormat.format(new Date(`${day}T00:00:00Z`));
}

export default function ExecutiveSummaryPortalView({
  metrics,
}: {
  metrics: AggregatedMetrics;
}) {
  const { summary, featureAdoptionData } = selectExecutiveSummaryReadModel(metrics);
  const featureRows = [
    { label: "Code completion", users: featureAdoptionData.completionUsers },
    { label: "Chat", users: featureAdoptionData.chatUsers },
    { label: "IDE Agent Mode", users: featureAdoptionData.agentModeUsers },
    { label: "Copilot CLI", users: featureAdoptionData.cliUsers },
    { label: "Cloud Agent", users: featureAdoptionData.codingAgentUsers },
    { label: "Code Review", users: featureAdoptionData.codeReviewUsers },
  ];
  const chartWidth = 700;
  const chartHeight = 180;
  const chartLeft = 44;
  const chartBaseline = 142;
  const chartTop = 20;
  const chartDays = Math.max(summary.calendarDays, 1);
  const chartStep = (chartWidth - chartLeft - 12) / chartDays;
  const chartScale = Math.max(summary.peakDailyUsers, 1);
  const participationLabel = summary.observedStartDay
    ? `Daily observed users from ${summary.observedStartDay} to ${summary.observedEndDay}. Peak: ${formatNumber(summary.peakDailyUsers)} users.`
    : "No daily participation data available.";

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Executive Summary</h2>
        <p className="mt-1 text-muted">Participation, patterns of use, and resource consumption.</p>
      </header>

      {summary.observedUsers === 0 ? (
        <p className="rounded border border-default bg-white p-5">No activity records are available for this summary.</p>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Observed users", formatNumber(summary.observedUsers)],
              ["Mean active days per user", formatNumber(summary.averageDaysPerUser)],
              ["Median active days per user", formatNumber(summary.medianDaysPerUser)],
              ["AI credits", formatNumber(summary.totalAiCreditsUsed)],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-default bg-white p-4">
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="mt-2 text-2xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby="executive-participation" className="rounded border border-default bg-white p-5">
            <h3 id="executive-participation" className="text-lg font-semibold">Participation across the window</h3>
            <p className="mt-1 text-sm text-muted">
              {summary.reportedDays} dates with records across {summary.calendarDays} calendar days.
              {summary.weekdayAverage !== null && ` Mean on reported weekdays: ${formatNumber(summary.weekdayAverage)}.`}
            </p>
            {summary.participation.length === 0 ? (
              <p className="mt-4">No daily participation data available.</p>
            ) : (
              <svg
                className="mt-4 h-auto w-full"
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                role="img"
                aria-label={participationLabel}
              >
                {summary.participation.map((day) => {
                  const barHeight = (day.users / chartScale) * (chartBaseline - chartTop);
                  return (
                    <rect
                      key={day.date}
                      x={chartLeft + day.dayOffset * chartStep + chartStep * 0.1}
                      y={chartBaseline - barHeight}
                      width={chartStep * 0.8}
                      height={barHeight}
                      fill={day.isWeekend ? "#8250df" : "#0969da"}
                    >
                      <title>{`${formatDate(day.date)}: ${formatNumber(day.users)} observed users`}</title>
                    </rect>
                  );
                })}
                <text x={chartLeft} y={chartHeight - 8}>{formatDate(summary.observedStartDay)}</text>
                {summary.observedStartDay !== summary.observedEndDay && (
                  <text x={chartWidth - 12} y={chartHeight - 8} textAnchor="end">
                    {formatDate(summary.observedEndDay)}
                  </text>
                )}
              </svg>
            )}
          </section>

          <section aria-labelledby="executive-features" className="rounded border border-default bg-white p-5">
            <h3 id="executive-features" className="text-lg font-semibold">How people use Copilot</h3>
            <p className="mt-1 text-sm text-muted">Selected features; populations may overlap.</p>
            <ul className="mt-4 space-y-3">
              {featureRows.map(({ label, users }) => {
                const share = summary.observedUsers > 0 ? (users / summary.observedUsers) * 100 : 0;
                return (
                  <li key={label} className="grid grid-cols-[9rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                    <span>{label}</span>
                    <span className="h-2 rounded bg-neutral-200" aria-hidden="true">
                      <span className="block h-2 rounded bg-[#0969da]" style={{ width: `${share}%` }} />
                    </span>
                    <span>{formatNumber(users)} ({formatNumber(share)}%)</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
