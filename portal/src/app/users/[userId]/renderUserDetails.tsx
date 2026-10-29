import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import PortalShell from "@/components/PortalShell";
import UserDetailsView from "@/adapters/UserDetailsView";
import { getPortalViewerContext, resolvePortalScope } from "@/access/portalAccess";
import { getUpstreamUserDetails } from "@/data/upstreamCoreDataSource";
import { logUsageFailure } from "@/usage/api";

export async function renderUserDetailsPage(
  rawUserId: string,
  searchParams: Promise<{ scope?: string | string[] }>,
) {
  const correlationId = randomUUID();
  const { viewer, access } = await getPortalViewerContext(correlationId);
  if (viewer.accessState === "signed-out") redirect("/sign-in");
  if (viewer.accessState === "no-access") redirect("/no-access");
  if (viewer.accessState === "unavailable" || access.state !== "authorized") redirect("/service-unavailable");
  if (!viewer.perUserDetailEnabled) notFound();

  const userId = Number(rawUserId);
  const selection = resolvePortalScope(viewer, (await searchParams).scope);
  if (!selection || !Number.isSafeInteger(userId) || !selection.userIds.includes(userId)) notFound();

  let model;
  try {
    model = await getUpstreamUserDetails({ access, selection, perUserDetailEnabled: true }, userId);
  } catch (error: unknown) {
    logUsageFailure(correlationId, error);
    redirect("/service-unavailable");
  }
  if (!model) notFound();
  const scopeQuery = `scope=${encodeURIComponent(`${selection.kind}:${selection.value}`)}`;
  return (
    <PortalShell viewer={viewer} pageSlug="users" selection={selection}>
      <UserDetailsView model={model} scopeQuery={scopeQuery} />
    </PortalShell>
  );
}
