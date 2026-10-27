import { notFound, redirect } from "next/navigation";
import { getAccess } from "../../../authz/server";

export const dynamic = "force-dynamic";

export default async function FeatureAdoptionPocPage() {
  const access = await getAccess();
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state === "no-access") redirect("/no-access");
  notFound();
}
