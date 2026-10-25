import type { Suppressible, UsageSeriesPoint } from "../../../shared/src/api";

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

export default function InteractionTotal({
  series,
}: {
  series: readonly Suppressible<UsageSeriesPoint>[];
}) {
  const total = getCompleteInteractionTotal(series);
  return total === null
    ? <>Unavailable (daily totals are incomplete or suppressed)</>
    : <>{numberFormat.format(total)}</>;
}
