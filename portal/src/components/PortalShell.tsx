import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth/config";
import type { PortalScopeSelection, PortalViewer } from "@/access/portalAccess";
import { visibleCorePages } from "@/navigation/corePages";
import { feedbackEnabled } from "@/feedback/access";
import { GitHubMark } from "@/components/CenteredCard";

// Outline icon paths (24x24, stroke) for the side navigation.
const ICON_PATHS: Record<string, string> = {
  overview: "M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z",
  "copilot-impact": "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  admin: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  "budget-lookup": "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z",
  feedback: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z",
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg className="h-5 w-5 shrink-0" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[name] ?? ICON_PATHS.overview} />
    </svg>
  );
}

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors duration-150 ${
          active
            ? "bg-[#f6f8fa] font-semibold !text-[#1f2328]"
            : "!text-[#59636e] hover:bg-[#f6f8fa] hover:!text-[#1f2328]"
        }`}
      >
        <NavIcon name={icon} />
        {label}
      </Link>
    </li>
  );
}

export default function PortalShell({
  viewer,
  pageSlug,
  selection,
  children,
}: {
  viewer: PortalViewer;
  pageSlug: string;
  selection: PortalScopeSelection;
  children: ReactNode;
}) {
  const pages = visibleCorePages(viewer);
  const scopeToken = `${selection.kind}:${selection.value}`;
  const pageHref = (slug: string) => {
    const path = slug === "overview" ? "/" : `/${slug}`;
    return `${path}?scope=${encodeURIComponent(scopeToken)}`;
  };
  const initial = viewer.displayName.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f8fa] text-default">
      <header className="sticky top-0 z-50 bg-[#24292f] text-white shadow-sm print:hidden">
        <div className="mx-auto flex min-h-16 max-w-[1440px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
          <Link href={pageHref("overview")} className="flex min-w-0 items-center gap-3 !text-white">
            <GitHubMark size={32} />
            <span className="truncate text-lg font-semibold tracking-tight">GitHub Copilot Usage Metrics</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <form action={pageSlug === "overview" ? "/" : `/${pageSlug}`} className="flex items-center gap-2">
              <label htmlFor="scope-selection" className="text-sm text-white/80">Scope</label>
              <select
                id="scope-selection"
                name="scope"
                defaultValue={scopeToken}
                className="max-w-[42vw] rounded-md border border-[#57606a] bg-[#24292f] px-3 py-1.5 text-sm text-white outline-none transition-colors focus:border-[#2f81f7]"
              >
                {viewer.scopeOptions.map((option) => (
                  <option key={`${option.kind}:${option.value}`} value={`${option.kind}:${option.value}`}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                className="cursor-pointer rounded-md border border-[#57606a] px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/[0.08]"
                type="submit"
              >
                Apply
              </button>
            </form>
            <Link
              href="/help"
              className="rounded-md px-3 py-1.5 text-sm font-medium !text-white transition-colors hover:bg-white/[0.08]"
            >
              Help / FAQ
            </Link>
            <div className="flex items-center gap-2 border-l border-white/20 pl-3">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2f81f7] text-sm font-semibold"
              >
                {initial}
              </span>
              <span className="hidden text-sm text-white/80 md:inline">Signed in as {viewer.displayName}</span>
              <form action={async () => {
                "use server";
                await signOut({ redirectTo: "/sign-in" });
              }}>
                <button
                  className="cursor-pointer rounded-md px-2 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
                  type="submit"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1440px] flex-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[232px_minmax(0,1fr)] lg:px-8">
        <nav aria-label="Main navigation" className="print:hidden lg:sticky lg:top-24 lg:self-start">
          <ul className="space-y-0.5 rounded-md border border-[#d1d9e0] bg-white p-2">
            {pages.map((page) => (
              <NavLink
                key={page.slug}
                href={pageHref(page.slug)}
                label={page.title}
                icon={page.slug}
                active={page.slug === pageSlug}
              />
            ))}
            {process.env.MODULE_BUDGET_LOOKUP === "true" && (
              <NavLink href="/budget-lookup" label="Budget Lookup" icon="budget-lookup" active={pageSlug === "budget-lookup"} />
            )}
            {feedbackEnabled() && (
              <NavLink href="/feedback" label="Feedback" icon="feedback" active={pageSlug === "feedback"} />
            )}
            {viewer.role === "admin" && (
              <NavLink href="/admin" label="Administration" icon="admin" active={pageSlug === "admin"} />
            )}
          </ul>
        </nav>

        <main className="min-w-0">
          <h1 className="sr-only">{pages.find(({ slug }) => slug === pageSlug)?.title ?? "Copilot usage metrics"}</h1>
          <div className="mb-5 flex items-start gap-2 rounded-md border border-[#d1d9e0] bg-white px-4 py-3 text-sm text-[#59636e]">
            <svg aria-hidden="true" focusable="false" className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <p>Metrics may be limited by the deployment&apos;s minimum-group privacy controls.</p>
          </div>
          {children}
        </main>
      </div>

      <footer className="pb-4 text-center text-xs text-[#59636e] print:hidden">
        GitHub Copilot Usage Metrics
      </footer>
    </div>
  );
}
