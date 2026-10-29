import type { UsageSeriesPoint } from "../../../shared/src/api";
import type { ApiCorePageData } from "../data/apiCoreDataSource";
import OverviewSummary from "./OverviewSummary";
import DailySeriesCharts from "./DailySeriesCharts";

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
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{impactOnly ? "Daily Copilot impact" : "Daily usage overview"}</caption>
        <thead>
          <tr className="border-b border-default">
            <th className="p-2" scope="col">Day</th>
            {!impactOnly && <th className="p-2" scope="col">Active users</th>}
            {!impactOnly && <th className="p-2" scope="col">Interactions</th>}
            <th className="p-2" scope="col">Code generations</th>
            <th className="p-2" scope="col">Code acceptances</th>
            <th className="p-2" scope="col">Lines added</th>
            <th className="p-2" scope="col">Lines deleted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-b border-default" key={row.day}>
              <th className="p-2 font-normal" scope="row">{formatDay(row.day)}</th>
              {!impactOnly && <td className="p-2">{formatNumber(row.activeUsers)}</td>}
              {!impactOnly && <td className="p-2">{formatNumber(row.interactions)}</td>}
              <td className="p-2">{formatNumber(row.codeGenerations)}</td>
              <td className="p-2">{formatNumber(row.codeAcceptances)}</td>
              <td className="p-2">{formatNumber(row.locAdded)}</td>
              <td className="p-2">{formatNumber(row.locDeleted)}</td>
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
      <h2 className="text-2xl font-semibold">{pageTitle}</h2>
      <p className="text-sm text-muted">Curated usage activity for the latest seven available days.</p>
      <p className="text-sm text-muted">
        Daily usage metrics are subject to minimum-group privacy controls.
      </p>
      {data.page === "overview" && <OverviewSummary totalUsers={data.totalUsers} />}
      <DailySeriesCharts rows={data.series} pageTitle={pageTitle} impactOnly={data.page === "copilot-impact"} />
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
