import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import PortalShell from "@/components/PortalShell";
import ApiCoreView from "@/adapters/ApiCoreView";
import UpstreamCoreView from "@/adapters/UpstreamCoreView";
import { getPortalViewerContext, resolvePortalScope } from "@/access/portalAccess";
import { getCorePage, upstreamViewsEnabled, visibleCorePages, type CorePage } from "@/navigation/corePages";
import { getApiCoreData, projectCorePageData } from "@/data/apiCoreDataSource";
import { getPortalDataSource } from "@/data/portalDataSource";
import { getUpstreamCoreData } from "@/data/upstreamCoreDataSource";
import { logUsageFailure } from "@/usage/api";
import { readMinGroupSize } from "@/auth/settings";

const REPORTING_PERIOD = { period: "last_7_days" } as const;

function dataUnavailable() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Data unavailable</h1>
      <p className="mt-2 text-muted">A reporting data source is not available for this page and scope.</p>
    </main>
  );
}

function scopeTooSmall(pageTitle: string) {
  return (
    <section className="space-y-2">
      <h2 className="text-2xl font-semibold">{pageTitle}</h2>
      <p className="text-sm text-muted">
        This scope has too few users to show metrics under the deployment&apos;s minimum-group privacy controls.
      </p>
    </section>
  );
}

async function renderUpstreamPage(
  page: CorePage,
  context: Awaited<ReturnType<typeof getPortalViewerContext>>,
  selection: NonNullable<ReturnType<typeof resolvePortalScope>>,
  correlationId: string,
) {
  const { viewer, access } = context;
  const shell = (children: ReactNode) => (
    <PortalShell viewer={viewer} pageSlug={page.slug} selection={selection}>{children}</PortalShell>
  );
  if (access.state === "authorized") {
    try {
      const data = await getUpstreamCoreData({
        access,
        selection,
        perUserDetailEnabled: viewer.perUserDetailEnabled,
        minGroupSize: readMinGroupSize(),
      });
      if (!data) return dataUnavailable();
      if (data.state === "suppressed") return shell(scopeTooSmall(page.title));
      return shell(
        <UpstreamCoreView view={page.view} metrics={data.metrics} pageTitle={page.title} selection={selection} />,
      );
    } catch (error: unknown) {
      logUsageFailure(correlationId, error);
      return dataUnavailable();
    }
  }
  const dataSource = getPortalDataSource();
  if (!dataSource) return dataUnavailable();
  const data = await dataSource.getCoreData({
    request: REPORTING_PERIOD,
    scope: selection.kind === "all" ? "company" : selection.kind,
    allowedUserIds: selection.userIds,
    perUserDetailEnabled: viewer.perUserDetailEnabled,
  });
  return shell(
    <UpstreamCoreView view={page.view} metrics={data.aggregatedMetrics} pageTitle={page.title} selection={selection} />,
  );
}

export async function renderCorePage(
  slug: string,
  searchParams: Promise<{ scope?: string | string[] }>,
) {
  const correlationId = randomUUID();
  const context = await getPortalViewerContext(correlationId);
  const { viewer, access } = context;
  if (viewer.accessState === "signed-out") redirect("/sign-in");
  if (viewer.accessState === "no-access") redirect("/no-access");
  if (viewer.accessState === "unavailable") redirect("/service-unavailable");

  const page = getCorePage(slug);
  if (!page || !visibleCorePages(viewer).some(({ slug: visibleSlug }) => visibleSlug === slug)) notFound();

  const selection = resolvePortalScope(viewer, (await searchParams).scope);
  if (!selection) notFound();
  if (upstreamViewsEnabled()) return renderUpstreamPage(page, context, selection, correlationId);

  if (access.state === "authorized") {
    try {
      const apiData = await getApiCoreData({
        page: slug,
        access,
        selection,
        request: REPORTING_PERIOD,
      });
      if (apiData) {
        return (
          <PortalShell
            viewer={viewer}
            pageSlug={slug}
            selection={selection}
          >
            <ApiCoreView data={apiData} pageTitle={page.title} />
          </PortalShell>
        );
      }
    } catch (error: unknown) {
      logUsageFailure(correlationId, error);
      return dataUnavailable();
    }
  }

  const dataSource = getPortalDataSource();
  if (!dataSource) return dataUnavailable();
  const data = await dataSource.getCoreData({
    request: REPORTING_PERIOD,
    scope: selection.kind === "all" ? "company" : selection.kind,
    allowedUserIds: selection.userIds,
    perUserDetailEnabled: viewer.perUserDetailEnabled,
  });
  if (page.slug !== "overview" && page.slug !== "copilot-impact") notFound();
  const pageData = projectCorePageData(page.slug, data.overview.data);
  return (
    <PortalShell viewer={viewer} pageSlug={slug} selection={selection}>
      <ApiCoreView data={pageData} pageTitle={page.title} />
    </PortalShell>
  );
}
