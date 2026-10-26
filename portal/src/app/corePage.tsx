import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { DEFAULT_MIN_GROUP_SIZE } from "@shared/api";
import type { Scope } from "@shared/rows";
import PortalShell from "@/components/PortalShell";
import UpstreamCoreView from "@/adapters/UpstreamCoreView";
import ApiCoreView from "@/adapters/ApiCoreView";
import { getPortalViewerContext, resolvePortalScope, type PortalScopeKind } from "@/access/portalAccess";
import { getCorePage, visibleCorePages } from "@/navigation/corePages";
import { getApiCoreData, getPortalDataSource } from "@/data/portalDataSource";
import { logUsageFailure } from "@/usage/api";

const REPORTING_PERIOD = { period: "last_7_days" } as const;

function dataUnavailable() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Data unavailable</h1>
      <p className="mt-2 text-muted">A reporting data source is not available for this page and scope.</p>
    </main>
  );
}

function scopeForApi(scope: PortalScopeKind): Scope {
  if (scope === "all") return "company";
  return scope;
}

function parseScopeToken(token: string | undefined): { kind?: string; value?: string } {
  if (!token) return {};
  const separator = token.indexOf(":");
  if (separator < 0) return {};
  return { kind: token.slice(0, separator), value: token.slice(separator + 1) };
}

export async function renderCorePage(
  slug: string,
  searchParams: Promise<{ scope?: string }>,
) {
  const correlationId = randomUUID();
  const { viewer, access } = await getPortalViewerContext(correlationId);
  if (viewer.accessState === "signed-out") redirect("/sign-in");
  if (viewer.accessState === "no-access") redirect("/no-access");
  if (viewer.accessState === "unavailable") redirect("/service-unavailable");

  const page = getCorePage(slug);
  if (!page || !visibleCorePages(viewer).some(({ slug: visibleSlug }) => visibleSlug === slug)) notFound();

  const token = parseScopeToken((await searchParams).scope);
  const selection = resolvePortalScope(viewer, token.kind, token.value);
  if (!selection) notFound();

  if (access.state === "authorized") {
    try {
      const apiData = await getApiCoreData({
        page: slug,
        access,
        selection,
        request: REPORTING_PERIOD,
      });
      if (apiData) {
        const suppressed = apiData.page !== "users" && apiData.overview.adoption.suppressed;
        const userCount = apiData.overview.adoption.value?.totalUsers ?? null;
        return (
          <PortalShell
            viewer={viewer}
            pageSlug={slug}
            selection={selection}
            userCount={userCount}
            suppressed={suppressed}
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
    scope: scopeForApi(selection.kind),
    allowedUserIds: selection.userIds,
    perUserDetailEnabled: viewer.perUserDetailEnabled,
  });
  const isSuppressed = data.suppressed || data.visibleUserCount < DEFAULT_MIN_GROUP_SIZE;

  return (
    <PortalShell
      viewer={viewer}
      pageSlug={slug}
      selection={selection}
      userCount={isSuppressed ? null : data.visibleUserCount}
      suppressed={isSuppressed}
    >
      <UpstreamCoreView
        view={page.view}
        metrics={data.aggregatedMetrics}
        pageTitle={page.title}
        selection={selection}
      />
    </PortalShell>
  );
}
