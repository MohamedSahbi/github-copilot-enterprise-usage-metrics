import type { UsageSeriesPoint } from "../../../shared/src/api";
import type { ApiCorePageData } from "../data/apiCoreDataSource";
import OverviewSummary from "./OverviewSummary";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

function formatDay(value: string): string {
  return dateFormat.format(new Date(`${value}T00:00:00.000Z`));
}

function SeriesTable({ rows, impactOnly = false }: { rows: UsageSeriesPoint[]; impactOnly?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-md border border-[#d1d9e0] bg-white">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{impactOnly ? "Daily Copilot impact" : "Daily usage overview"}</caption>
        <thead className="bg-[#f6f8fa] text-xs uppercase tracking-wide text-[#59636e]">
          <tr className="border-b border-default">
            <th className="px-4 py-2.5" scope="col">Day</th>
            {!impactOnly && <th className="px-4 py-2.5" scope="col">Active users</th>}
            {!impactOnly && <th className="px-4 py-2.5" scope="col">Interactions</th>}
            <th className="px-4 py-2.5" scope="col">Code generations</th>
            <th className="px-4 py-2.5" scope="col">Code acceptances</th>
            <th className="px-4 py-2.5" scope="col">Lines added</th>
            <th className="px-4 py-2.5" scope="col">Lines deleted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-b border-default last:border-b-0 hover:bg-[#f6f8fa]" key={row.day}>
              <th className="px-4 py-2.5 font-normal" scope="row">{formatDay(row.day)}</th>
              {!impactOnly && <td className="px-4 py-2.5">{formatNumber(row.activeUsers)}</td>}
              {!impactOnly && <td className="px-4 py-2.5">{formatNumber(row.interactions)}</td>}
              <td className="px-4 py-2.5">{formatNumber(row.codeGenerations)}</td>
              <td className="px-4 py-2.5">{formatNumber(row.codeAcceptances)}</td>
              <td className="px-4 py-2.5">{formatNumber(row.locAdded)}</td>
              <td className="px-4 py-2.5">{formatNumber(row.locDeleted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApiPageContent({ data, pageTitle }: { data: ApiCorePageData; pageTitle: string }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-[#1f2328]">{pageTitle}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Curated usage activity for the latest seven available days.
          {" "}Daily usage metrics are subject to minimum-group privacy controls.
        </p>
      </div>
      {data.page === "overview" && <OverviewSummary totalUsers={data.totalUsers} />}
      <SeriesTable rows={data.series} impactOnly={data.page === "copilot-impact"} />
    </section>
  );
}

export default function ApiCoreView({
  data,
  pageTitle,
}: {
  data: ApiCorePageData;
  pageTitle: string;
}) {
  return <ApiPageContent data={data} pageTitle={pageTitle} />;
}
