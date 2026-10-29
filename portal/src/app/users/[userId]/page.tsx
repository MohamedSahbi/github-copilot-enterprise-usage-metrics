import { notFound, redirect } from "next/navigation";
import type { AccessResult } from "../../../authz/access";
import { getAccess } from "../../../authz/server";
import { upstreamViewsEnabled } from "../../../navigation/corePages";

export const dynamic = "force-dynamic";

export default async function UserDetailsPage(props?: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  if (upstreamViewsEnabled() && props) {
    const { renderUserDetailsPage } = await import("./renderUserDetails");
    return renderUserDetailsPage((await props.params).userId, props.searchParams);
  }
  let access: AccessResult;
  try {
    access = await getAccess();
  } catch {
    redirect("/service-unavailable");
  }
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state === "no-access") redirect("/no-access");
  notFound();
}
