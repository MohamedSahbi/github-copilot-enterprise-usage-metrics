import { notFound, redirect } from "next/navigation";
import { DEFAULT_MIN_GROUP_SIZE } from "@shared/api";
import type { Scope } from "@shared/rows";
import PortalShell from "@/components/PortalShell";
import UpstreamCoreView from "@/adapters/UpstreamCoreView";
import { getPortalViewer, resolvePortalScope, type PortalScopeKind } from "@/access/portalAccess";
import { getCorePage, visibleCorePages } from "@/navigation/corePages";
import { getPortalDataSource } from "@/data/portalDataSource";

const FIXTURE_RANGE = { from: "2026-03-02", to: "2026-03-06" } as const;

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
  const viewer = await getPortalViewer();
  if (viewer.accessState === "signed-out") redirect("/sign-in");
  if (viewer.accessState === "no-access") redirect("/no-access");
  if (viewer.accessState === "unavailable") redirect("/service-unavailable");

  const page = getCorePage(slug);
  if (!page || !visibleCorePages(viewer).some(({ slug: visibleSlug }) => visibleSlug === slug)) notFound();

  const token = parseScopeToken((await searchParams).scope);
  const selection = resolvePortalScope(viewer, token.kind, token.value);
  if (!selection) notFound();

  const dataSource = getPortalDataSource();
  if (!dataSource) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Data unavailable</h1>
        <p className="mt-2 text-muted">A reporting data source is not configured for this deployment.</p>
      </main>
    );
  }

  const data = await dataSource.getCoreData({
    request: FIXTURE_RANGE,
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
      userCount={data.visibleUserCount}
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
