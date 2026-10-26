"use client";

import { useRouter } from "next/navigation";
import type { AggregatedMetrics } from "@upstream/types/aggregatedMetrics";
import { VIEW_MODES, type ViewMode } from "@upstream/types/navigation";
import ExecutiveSummaryPortalView from "@/adapters/ExecutiveSummaryPortalView";
import type { PortalScopeSelection } from "@/access/portalAccess";
import {
  AiAdoptionPhasesRouteAdapter,
  CliAdoptionRouteAdapter,
  ClientVersionsRouteAdapter,
  ClientsRouteAdapter,
  CopilotAdoptionRouteAdapter,
  CopilotImpactRouteAdapter,
  LanguagesRouteAdapter,
  ModelDetailsRouteAdapter,
  OverviewRouteAdapter,
  UsersRouteAdapter,
  type StandardRouteContext,
} from "@upstream/components/layout/routes/standardRouteAdapters";
import AccessibleUpstreamCharts from "@/components/AccessibleUpstreamCharts";

function CoreRoute({
  view,
  context,
}: {
  view: ViewMode;
  context: StandardRouteContext;
}) {
  switch (view) {
    case VIEW_MODES.COPILOT_ADOPTION:
      return <CopilotAdoptionRouteAdapter {...context} />;
    case VIEW_MODES.LANGUAGES:
      return <LanguagesRouteAdapter {...context} />;
    case VIEW_MODES.MODEL_DETAILS:
      return <ModelDetailsRouteAdapter {...context} />;
    case VIEW_MODES.CLI_ADOPTION:
      return <CliAdoptionRouteAdapter {...context} />;
    case VIEW_MODES.COPILOT_IMPACT:
      return <CopilotImpactRouteAdapter {...context} />;
    case VIEW_MODES.CLIENT_ANALYSIS:
      return <ClientsRouteAdapter {...context} />;
    case VIEW_MODES.CLIENT_VERSIONS:
      return <ClientVersionsRouteAdapter {...context} />;
    case VIEW_MODES.AI_ADOPTION_PHASES:
      return <AiAdoptionPhasesRouteAdapter {...context} />;
    case VIEW_MODES.USERS:
      return <UsersRouteAdapter {...context} />;
    case VIEW_MODES.OVERVIEW:
    default:
      return <OverviewRouteAdapter {...context} />;
  }
}

export default function UpstreamCoreView({
  view,
  metrics,
  pageTitle,
  selection,
}: {
  view: ViewMode;
  metrics: AggregatedMetrics;
  pageTitle: string;
  selection: PortalScopeSelection;
}) {
  const router = useRouter();
  const scopeQuery = `scope=${encodeURIComponent(`${selection.kind}:${selection.value}`)}`;
  const onUserSelect = (_login: string, userId: number) => router.push(`/users/${userId}?${scopeQuery}`);
  const context: StandardRouteContext = { aggregatedMetrics: metrics, enterpriseName: null, onUserSelect };

  return (
    <AccessibleUpstreamCharts pageTitle={pageTitle}>
      {view === VIEW_MODES.EXECUTIVE_SUMMARY
        ? <ExecutiveSummaryPortalView metrics={metrics} />
        : <CoreRoute view={view} context={context} />}
    </AccessibleUpstreamCharts>
  );
}
