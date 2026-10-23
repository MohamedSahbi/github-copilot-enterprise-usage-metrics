import { cookies } from "next/headers";
import FeatureAdoptionChart from "@upstream/components/charts/FeatureAdoptionChart";
import { toFeatureAdoptionData } from "@/adapters/featureAdoption";
import { personaLabel, TEST_SESSION_COOKIE } from "@/auth/test-auth";
import { featureAdoptionFixture } from "@/poc/featureAdoptionFixture";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feature adoption proof of concept" };

export default async function FeatureAdoptionPocPage() {
  const persona = personaLabel((await cookies()).get(TEST_SESSION_COOKIE)?.value);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold">Feature adoption (proof of concept)</h1>
      <p className="mt-1 text-sm">
        {persona ? `Signed in as ${persona}` : "Signed out"}. Upstream chart fed from a hard-coded fixture.
      </p>
      <div className="mt-4">
        <FeatureAdoptionChart data={toFeatureAdoptionData(featureAdoptionFixture)} />
      </div>
    </main>
  );
}
