import FeatureAdoptionChart from "@upstream/components/charts/FeatureAdoptionChart";
import type { UsageBreakdownRow, UsageSeriesPoint, UserUsageRow } from "../../../shared/src/api";
import { toFeatureAdoptionData } from "@/adapters/featureAdoption";
import AccessibleUpstreamCharts from "@/components/AccessibleUpstreamCharts";
import type { ApiCorePageData } from "@/data/portalDataSource";
import OverviewSummary from "./OverviewSummary";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

function formatDay(value: string): string {
  return dateFormat.format(new Date(`${value}T00:00:00.000Z`));
}

function visibleSeries(data: ApiCorePageData): UsageSeriesPoint[] {
  return data.overview.series.flatMap(({ suppressed, value }) => (
    suppressed || value === null ? [] : [value]
  ));
}

function visibleBreakdownRows(data: Extract<ApiCorePageData, { breakdown: unknown }>): UsageBreakdownRow[] {
  return data.breakdown.rows.flatMap(({ suppressed, value }) => (
    suppressed || value === null ? [] : [value]
  ));
}

function SeriesTable({ rows, impactOnly = false }: { rows: UsageSeriesPoint[]; impactOnly?: boolean }) {
  if (rows.length === 0) return <p>No visible daily usage data is available for this period.</p>;

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

function BreakdownTable({ data }: { data: Extract<ApiCorePageData, { breakdown: unknown }> }) {
  const rows = visibleBreakdownRows(data);
  const hasSuppressedRows = data.breakdown.rows.some(({ suppressed }) => suppressed);
  if (rows.length === 0) {
    return <p>{hasSuppressedRows ? "Category data is hidden because groups are below the minimum size." : "No category data is available for this period."}</p>;
  }

  return (
    <div className="space-y-3">
      {hasSuppressedRows && <p>Some categories are hidden because groups are below the minimum size.</p>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{data.breakdownKind} usage breakdown</caption>
          <thead>
            <tr className="border-b border-default">
              <th className="p-2" scope="col">Category</th>
              <th className="p-2" scope="col">Observed users</th>
              <th className="p-2" scope="col">Interactions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b border-default" key={row.key}>
                <th className="p-2 font-normal" scope="row">{row.key}</th>
                <td className="p-2">{formatNumber(row.userCount)}</td>
                <td className="p-2">{formatNumber(row.interactions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsersTable({ rows }: { rows: UserUsageRow[] }) {
  if (rows.length === 0) return <p>No user usage data is available for this period.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Per-user usage summary</caption>
        <thead>
          <tr className="border-b border-default">
            <th className="p-2" scope="col">User</th>
            <th className="p-2" scope="col">Active days</th>
            <th className="p-2" scope="col">Interactions</th>
            <th className="p-2" scope="col">AI credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-b border-default" key={row.userId}>
              <th className="p-2 font-normal" scope="row">{row.login ?? `User ${row.userId}`}</th>
              <td className="p-2">{formatNumber(row.daysActive)}</td>
              <td className="p-2">{formatNumber(row.interactions)}</td>
              <td className="p-2">{formatNumber(row.aiCreditsUsed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApiPageContent({ data, pageTitle }: { data: ApiCorePageData; pageTitle: string }) {
  if (data.page === "users") {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">{pageTitle}</h2>
        <p className="text-sm text-muted">Per-user summary for the latest seven available days.</p>
        <UsersTable rows={data.users.rows} />
      </section>
    );
  }

  if (data.page === "languages" || data.page === "model-usage" || data.page === "clients") {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">{pageTitle}</h2>
        <p className="text-sm text-muted">Curated aggregate breakdown for the latest seven available days.</p>
        <BreakdownTable data={data} />
      </section>
    );
  }

  const adoption = data.overview.adoption;
  if (data.page === "overview") {
    const series = visibleSeries(data);
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">{pageTitle}</h2>
        <p className="text-sm text-muted">Curated usage activity for the latest seven available days.</p>
        <OverviewSummary adoption={adoption} series={data.overview.series} />
        <SeriesTable rows={series} />
      </section>
    );
  }

  if (adoption.suppressed || adoption.value === null) {
    return null;
  }

  if (data.page === "copilot-adoption") {
    const featureData = toFeatureAdoptionData(adoption.value);
    const featureRows = [
      ["Code completion", featureData.completionUsers],
      ["Chat", featureData.chatUsers],
      ["IDE Agent Mode", featureData.agentModeUsers],
      ["Ask mode", featureData.askModeUsers],
      ["Inline mode", featureData.inlineModeUsers],
      ["Plan mode", featureData.planModeUsers],
      ["Copilot CLI", featureData.cliUsers],
      ["VS Code Agents", featureData.vscodeAgentUsers],
      ["Copilot App", featureData.appUsers],
      ["Cloud Agent", featureData.codingAgentUsers],
      ["Code Review", featureData.codeReviewUsers],
      ["Advanced Users", featureData.advancedUsers],
    ] as const;
    return (
      <AccessibleUpstreamCharts pageTitle={pageTitle}>
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">{pageTitle}</h2>
          <p className="text-sm text-muted">Feature adoption in the latest seven available days.</p>
          <FeatureAdoptionChart data={featureData} />
          <ul className="grid gap-2 sm:grid-cols-2">
            {featureRows.map(([label, count]) => (
              <li className="rounded border border-default bg-white p-3" key={label}>
                <span className="font-medium">{label}</span>
                <span className="ml-2">{formatNumber(count)} users</span>
              </li>
            ))}
          </ul>
        </section>
      </AccessibleUpstreamCharts>
    );
  }

  if (data.page === "cli-adoption") {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">{pageTitle}</h2>
        <p className="text-sm text-muted">Copilot CLI users in the latest seven available days.</p>
        <p className="rounded border border-default bg-white p-4 text-2xl font-semibold">
          {formatNumber(adoption.value.cliUsers)} users
        </p>
      </section>
    );
  }

  const series = visibleSeries(data);
  if (data.page === "copilot-impact") {
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">{pageTitle}</h2>
        <p className="text-sm text-muted">Curated daily impact totals for the latest seven available days.</p>
        <SeriesTable rows={series} impactOnly />
      </section>
    );
  }
  return null;
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
