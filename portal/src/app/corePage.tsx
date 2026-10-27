import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import PortalShell from "@/components/PortalShell";
import ApiCoreView from "@/adapters/ApiCoreView";
import { getPortalViewerContext, resolvePortalScope } from "@/access/portalAccess";
import { getCorePage, visibleCorePages } from "@/navigation/corePages";
import { getApiCoreData, projectCorePageData } from "@/data/apiCoreDataSource";
import { getPortalDataSource } from "@/data/portalDataSource";
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

export async function renderCorePage(
  slug: string,
  searchParams: Promise<{ scope?: string | string[] }>,
) {
  const correlationId = randomUUID();
  const { viewer, access } = await getPortalViewerContext(correlationId);
  if (viewer.accessState === "signed-out") redirect("/sign-in");
  if (viewer.accessState === "no-access") redirect("/no-access");
  if (viewer.accessState === "unavailable") redirect("/service-unavailable");

  const page = getCorePage(slug);
  if (!page || !visibleCorePages(viewer).some(({ slug: visibleSlug }) => visibleSlug === slug)) notFound();

  const selection = resolvePortalScope(viewer, (await searchParams).scope);
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
  const pageData = projectCorePageData(page.slug, data.overview.data);
  return (
    <PortalShell viewer={viewer} pageSlug={slug} selection={selection}>
      <ApiCoreView data={pageData} pageTitle={page.title} />
    </PortalShell>
  );
}
