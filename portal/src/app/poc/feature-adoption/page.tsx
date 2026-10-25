import FeatureAdoptionChart from "@upstream/components/charts/FeatureAdoptionChart";
import AccessibleUpstreamCharts from "@/components/AccessibleUpstreamCharts";
import { toFeatureAdoptionData } from "@/adapters/featureAdoption";
import { auth } from "@/auth/config";
import { getAccess } from "@/authz/server";
import { redirect } from "next/navigation";
import { featureAdoptionFixture } from "@/poc/featureAdoptionFixture";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feature adoption proof of concept" };

export default async function FeatureAdoptionPocPage() {
  const access = await getAccess();
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state === "no-access") redirect("/no-access");
  const session = await auth();
  const persona = session?.user?.name;

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold">Feature adoption (proof of concept)</h1>
      <p className="mt-1 text-sm">
        {persona ? `Signed in as ${persona}` : "Signed out"}. Upstream chart fed from a hard-coded fixture.
      </p>
      <div className="mt-4">
        <AccessibleUpstreamCharts pageTitle="Feature adoption">
          <FeatureAdoptionChart data={toFeatureAdoptionData(featureAdoptionFixture)} />
        </AccessibleUpstreamCharts>
      </div>
    </main>
  );
}
