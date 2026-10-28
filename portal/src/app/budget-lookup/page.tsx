import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import BudgetLookupPanel from "@/budget/BudgetLookupPanel";
import PortalShell from "@/components/PortalShell";
import { getPortalViewerContext, resolvePortalScope } from "@/access/portalAccess";

export const dynamic = "force-dynamic";

export default async function BudgetLookupPage() {
  if (process.env.MODULE_BUDGET_LOOKUP !== "true") notFound();

  const correlationId = randomUUID();
  const { viewer } = await getPortalViewerContext(correlationId);
  if (viewer.accessState === "signed-out") redirect("/sign-in");
  if (viewer.accessState === "no-access") redirect("/no-access");
  if (viewer.accessState === "unavailable") redirect("/service-unavailable");

  const selection = resolvePortalScope(viewer);
  if (!selection) notFound();

  return (
    <PortalShell viewer={viewer} pageSlug="budget-lookup" selection={selection}>
      <BudgetLookupPanel />
    </PortalShell>
  );
}
