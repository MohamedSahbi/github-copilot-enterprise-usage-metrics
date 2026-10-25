import type { AdoptionSummary, Suppressible, UsageSeriesPoint } from "../../../shared/src/api";

function getCompleteInteractionTotal(
  series: readonly Suppressible<UsageSeriesPoint>[],
): number | null {
  const visibleRows = series.flatMap(({ suppressed, value }) => (
    suppressed || value === null ? [] : [value]
  ));
  if (series.length === 0 || visibleRows.length !== series.length) return null;
  return visibleRows.reduce((total, row) => total + row.interactions, 0);
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export default function OverviewSummary({
  adoption,
  series,
}: {
  adoption: Suppressible<AdoptionSummary>;
  series: readonly Suppressible<UsageSeriesPoint>[];
}) {
  const totalInteractions = getCompleteInteractionTotal(series);
  const totalUsers = adoption.suppressed ? null : adoption.value?.totalUsers ?? null;

  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {totalUsers !== null && (
        <div className="rounded border border-default bg-white p-4">
          <dt className="text-sm text-muted">Observed users</dt>
          <dd className="mt-2 text-2xl font-semibold">{numberFormat.format(totalUsers)}</dd>
        </div>
      )}
      <div className="rounded border border-default bg-white p-4">
        <dt className="text-sm text-muted">Interactions</dt>
        <dd className="mt-2 text-2xl font-semibold">
          {totalInteractions === null
            ? "Unavailable (daily totals are incomplete or suppressed)"
            : numberFormat.format(totalInteractions)}
        </dd>
      </div>
    </dl>
  );
}
