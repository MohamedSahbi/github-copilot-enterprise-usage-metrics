const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export default function OverviewSummary({
  totalUsers,
}: {
  totalUsers: number | null;
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-1">
      {totalUsers !== null && (
        <div className="rounded border border-default bg-white p-4">
          <dt className="text-sm text-muted">Observed users</dt>
          <dd className="mt-2 text-2xl font-semibold">{numberFormat.format(totalUsers)}</dd>
        </div>
      )}
    </dl>
  );
}
