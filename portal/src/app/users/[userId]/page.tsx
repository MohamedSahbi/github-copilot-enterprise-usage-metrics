import { notFound } from "next/navigation";
import type { Scope } from "@shared/rows";
import UserDetailsView from "@/adapters/UserDetailsView";
import PortalShell from "@/components/PortalShell";
import { getPortalViewer, resolvePortalScope } from "@/access/portalAccess";
import type { PortalScopeKind } from "@/access/portalAccess";
import { getPortalDataSource } from "@/data/portalDataSource";

export const dynamic = "force-dynamic";

const FIXTURE_RANGE = { from: "2026-03-02", to: "2026-03-06" } as const;

function apiScope(scope: PortalScopeKind): Scope {
  if (scope === "all") return "company";
  return scope;
}

export default async function UserDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const viewer = await getPortalViewer();
  if (viewer.accessState !== "authorized" || !viewer.perUserDetailEnabled ||
    !["admin", "executive", "manager", "member"].includes(viewer.role)) {
    notFound();
  }
  const userId = Number((await params).userId);
  if (!Number.isSafeInteger(userId) || userId < 1) notFound();

  const scopeParam = (await searchParams).scope ?? "";
  const separator = scopeParam.indexOf(":");
  const selection = resolvePortalScope(
    viewer,
    separator < 0 ? undefined : scopeParam.slice(0, separator),
    separator < 0 ? undefined : scopeParam.slice(separator + 1),
  );
  if (!selection || !selection.userIds.includes(userId)) notFound();

  const dataSource = getPortalDataSource();
  if (!dataSource) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Data unavailable</h1>
        <p className="mt-2 text-muted">A reporting data source is not configured for this deployment.</p>
      </main>
    );
  }

  const model = await dataSource.getUserDetails(
    {
      request: FIXTURE_RANGE,
      scope: apiScope(selection.kind),
      allowedUserIds: selection.userIds,
      perUserDetailEnabled: viewer.perUserDetailEnabled,
    },
    { id: userId, login: `example-user-${String(userId).slice(-3)}` },
  );
  if (!model) notFound();

  return (
    <PortalShell
      viewer={viewer}
      pageSlug="users"
      selection={selection}
      userCount={selection.userIds.length}
      suppressed={false}
    >
      <UserDetailsView
        model={model}
        scopeQuery={`scope=${encodeURIComponent(`${selection.kind}:${selection.value}`)}`}
      />
    </PortalShell>
  );
}
