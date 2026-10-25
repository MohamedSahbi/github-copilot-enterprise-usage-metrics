import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccess } from "@/authz/server";
import { auth, signOut } from "@/auth/config";

export default async function HomePage() {
  const access = await getAccess();
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state === "no-access") redirect("/no-access");
  const session = await auth();
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">GitHub Copilot Usage Metrics</h1>
      <p className="mt-2">Signed in as {session?.user?.name ?? "portal user"}</p>
      <p className="mt-2">Your access is verified. Reports will be available in the next phase.</p>
      <p className="mt-4">
        <Link className="underline" href="/poc/feature-adoption">
          Submodule proof of concept: Feature Adoption chart
        </Link>
      </p>
      <form className="mt-4" action={async () => { "use server"; await signOut({ redirectTo: "/sign-in" }); }}>
        <button className="underline" type="submit">Sign out</button>
      </form>
    </main>
  );
}
