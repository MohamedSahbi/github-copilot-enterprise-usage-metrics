import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth/config";
import type { PortalScopeSelection, PortalViewer } from "@/access/portalAccess";
import { visibleCorePages } from "@/navigation/corePages";
import SideNavCard from "@/components/SideNavCard";

// Dark-header button, like the GitHub header's secondary actions.
const headerButton =
  "cursor-pointer rounded-md border border-white/30 px-3 py-1.5 text-sm font-medium !text-white transition-colors " +
  "hover:border-white/60 hover:bg-white/15 active:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

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

  return (
    <div className="min-h-screen bg-[#f6f8fa] text-default">
      <header className="border-b border-default bg-[#24292f] text-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-5 py-4">
          <Link href={pageHref("overview")} className="!text-white font-semibold tracking-tight">
            GitHub Copilot Usage Metrics
          </Link>
          <div className="flex flex-wrap items-center gap-4">
            <Link href="/help" className={headerButton}>Help / FAQ</Link>
            <span className="text-sm text-white/80">Signed in as {viewer.displayName}</span>
            <form action={async () => {
              "use server";
              await signOut({ redirectTo: "/sign-in" });
            }}>
              <button className={headerButton} type="submit">Sign out</button>
            </form>
            <form action={pageSlug === "overview" ? "/" : `/${pageSlug}`} className="flex items-center gap-2">
              <label htmlFor="scope-selection" className="text-sm text-white/80">Scope</label>
              <select
                id="scope-selection"
                name="scope"
                defaultValue={`${selection.kind}:${selection.value}`}
                className="cursor-pointer rounded-md border border-white/30 bg-[#32383f] px-2 py-1.5 text-sm text-white transition-colors hover:border-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                {viewer.scopeOptions.map((option) => (
                  <option key={`${option.kind}:${option.value}`} value={`${option.kind}:${option.value}`}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button className={headerButton} type="submit">
                Apply
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1440px] gap-6 px-5 py-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside>
          <SideNavCard label="Main navigation" items={[
            ...(viewer.role === "admin" ? [{ href: "/admin", label: "Administration", icon: "administration" as const }] : []),
            ...pages.map((page) => ({
              href: pageHref(page.slug), label: page.title, current: page.slug === pageSlug,
              icon: page.slug,
            })),
            ...(process.env.MODULE_BUDGET_LOOKUP === "true"
              ? [{ href: "/budget-lookup", label: "Budget Lookup", icon: "budget-lookup" as const, current: pageSlug === "budget-lookup" }] : []),
          ]} />
        </aside>

        <main className="min-w-0">
          <h1 className="sr-only">{pages.find(({ slug }) => slug === pageSlug)?.title ?? "Copilot usage metrics"}</h1>
          <p className="mb-5 text-sm text-muted">
            Metrics may be limited by the deployment&apos;s minimum-group privacy controls.
          </p>
          {children}
        </main>
      </div>
    </div>
  );
}
