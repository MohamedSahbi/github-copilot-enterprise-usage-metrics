import { redirect } from "next/navigation";
import Link from "next/link";
import { signOut } from "@/auth/config";
import { getAccess } from "@/authz/server";
import { readAccessSettings } from "@/auth/settings";
import CenteredCard, { primaryButtonClass, secondaryButtonClass } from "@/components/CenteredCard";

function LockIcon() {
  return (
    <svg aria-hidden="true" focusable="false" className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  );
}

export default async function NoAccessPage() {
  const access = await getAccess();
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state === "authorized") redirect("/");
  const settings = readAccessSettings();
  return (
    <CenteredCard
      title="No access"
      tone="attention"
      icon={<LockIcon />}
      description={<>
        <p>{settings.noAccessMessage}</p>
        {settings.contact && <p className="mt-2">Contact: {settings.contact}</p>}
      </>}
      footer={<Link className="underline underline-offset-2" href="/help#why-do-i-see-no-access">Help / FAQ: Why do I see No access?</Link>}
    >
      <div className="space-y-3">
        {settings.requestUrl && <a className={`${primaryButtonClass} !text-white`} href={settings.requestUrl}>Request access</a>}
        <form action={async () => { "use server"; await signOut({ redirectTo: "/sign-in" }); }}>
          <button className={secondaryButtonClass} type="submit">Sign out</button>
        </form>
      </div>
    </CenteredCard>
  );
}
