import { notFound, redirect } from "next/navigation";
import type { AccessResult } from "../../../authz/access";
import { getAccess } from "../../../authz/server";

export const dynamic = "force-dynamic";

export default async function UserDetailsPage() {
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
