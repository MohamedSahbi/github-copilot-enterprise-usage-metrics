import { notFound } from "next/navigation";
import { DEFAULT_MIN_GROUP_SIZE } from "@shared/api";
import type { Scope } from "@shared/rows";
import PortalShell from "@/components/PortalShell";
import UpstreamCoreView from "@/adapters/UpstreamCoreView";
import { getPortalViewer, resolvePortalScope, type PortalScopeKind } from "@/access/portalAccess";
import { getCorePage, visibleCorePages } from "@/navigation/corePages";
import { syntheticPortalDataSource } from "@/data/portalDataSource";

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
  if (!viewer.authenticated) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Sign in required</h1>
        <p className="mt-2 text-muted">Sign in with your configured portal identity to view usage metrics.</p>
      </main>
    );
  }
  if (viewer.role === "no-access") {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">No access</h1>
        <p className="mt-2 text-muted">Your portal identity does not have a usage-data grant.</p>
      </main>
    );
  }

  const page = getCorePage(slug);
  if (!page || !visibleCorePages(viewer).some(({ slug: visibleSlug }) => visibleSlug === slug)) notFound();

  const token = parseScopeToken((await searchParams).scope);
  const selection = resolvePortalScope(viewer, token.kind, token.value);
  if (!selection) notFound();

  const data = await syntheticPortalDataSource.getCoreData({
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
