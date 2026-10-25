import { redirect } from "next/navigation";
import { signOut } from "@/auth/config";
import { getAccess } from "@/authz/server";
import { readAccessSettings } from "@/auth/settings";

export default async function NoAccessPage() {
  const access = await getAccess();
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state === "authorized") redirect("/");
  const settings = readAccessSettings();
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">No access</h1>
      <p className="mt-2">{settings.noAccessMessage}</p>
      {settings.requestUrl && <p className="mt-4"><a className="underline" href={settings.requestUrl}>Request access</a></p>}
      {settings.contact && <p className="mt-4">Contact: {settings.contact}</p>}
      <form className="mt-4" action={async () => { "use server"; await signOut({ redirectTo: "/sign-in" }); }}>
        <button className="underline" type="submit">Sign out</button>
      </form>
    </main>
  );
}
