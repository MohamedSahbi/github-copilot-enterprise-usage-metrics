"use client";

import { Bar, Line } from "react-chartjs-2";
import type { UsageSeriesPoint } from "../../../shared/src/api";
import { registerChartJS } from "../../upstream/src/components/charts/utils/chartSetup";
import { createBaseChartOptions } from "../../upstream/src/components/charts/utils/chartOptions";
import { createBarDataset, createFilledLineDataset } from "../../upstream/src/components/charts/utils/chartStyles";
import { chartColors } from "../../upstream/src/components/charts/utils/chartColors";
import { formatShortDate } from "../../upstream/src/utils/formatters";
import ChartContainer from "../../upstream/src/components/ui/ChartContainer";
import AccessibleUpstreamCharts from "../components/AccessibleUpstreamCharts";

registerChartJS();

// Charts plot only the released daily rows the table shows. They add no period
// totals or averages, because suppressed days are already removed from the series.
function ActiveUsersChart({ rows }: { rows: UsageSeriesPoint[] }) {
  return (
    <ChartContainer title="Daily active users" description="Users with Copilot activity each day">
      <Line
        data={{
          labels: rows.map(({ day }) => formatShortDate(day)),
          datasets: [createFilledLineDataset(chartColors.blue.solid, "Active users", rows.map((row) => row.activeUsers))],
        }}
        options={createBaseChartOptions<"line">({ xAxisLabel: "Date", yAxisLabel: "Users" })}
      />
    </ChartContainer>
  );
}

function InteractionsChart({ rows }: { rows: UsageSeriesPoint[] }) {
  return (
    <ChartContainer title="Daily interactions" description="Copilot interactions across all features each day">
      <Line
        data={{
          labels: rows.map(({ day }) => formatShortDate(day)),
          datasets: [createFilledLineDataset(chartColors.purple.solid, "Interactions", rows.map((row) => row.interactions))],
        }}
        options={createBaseChartOptions<"line">({ xAxisLabel: "Date", yAxisLabel: "Interactions" })}
      />
    </ChartContainer>
  );
}

function CodeChart({ rows }: { rows: UsageSeriesPoint[] }) {
  const labels = rows.map(({ day }) => formatShortDate(day));
  return (
    <ChartContainer title="Code suggestions" description="Code generations and acceptances each day">
      <Bar
        data={{
          labels,
          datasets: [
            createBarDataset(chartColors.teal.solid, "Code generations", rows.map((row) => row.codeGenerations)),
            createBarDataset(chartColors.green.solid, "Code acceptances", rows.map((row) => row.codeAcceptances)),
          ],
        }}
        options={createBaseChartOptions<"bar">({ xAxisLabel: "Date", showLegend: true })}
      />
    </ChartContainer>
  );
}

function LinesChart({ rows }: { rows: UsageSeriesPoint[] }) {
  const labels = rows.map(({ day }) => formatShortDate(day));
  return (
    <ChartContainer title="Lines of code" description="Lines added and deleted with Copilot each day">
      <Bar
        data={{
          labels,
          datasets: [
            createBarDataset(chartColors.green.solid, "Lines added", rows.map((row) => row.locAdded)),
            createBarDataset(chartColors.red.solid, "Lines deleted", rows.map((row) => row.locDeleted)),
          ],
        }}
        options={createBaseChartOptions<"bar">({ xAxisLabel: "Date", showLegend: true })}
      />
    </ChartContainer>
  );
}

export default function DailySeriesCharts({
  rows,
  pageTitle,
  impactOnly = false,
}: {
  rows: UsageSeriesPoint[];
  pageTitle: string;
  impactOnly?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <AccessibleUpstreamCharts pageTitle={pageTitle}>
      <div className="grid gap-4 lg:grid-cols-2">
        {!impactOnly && <ActiveUsersChart rows={rows} />}
        {!impactOnly && <InteractionsChart rows={rows} />}
        <CodeChart rows={rows} />
        <LinesChart rows={rows} />
      </div>
    </AccessibleUpstreamCharts>
  );
}
