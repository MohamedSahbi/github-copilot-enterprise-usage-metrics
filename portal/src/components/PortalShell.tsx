import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/auth/config";
import type { PortalScopeSelection, PortalViewer } from "@/access/portalAccess";
import { visibleCorePages } from "@/navigation/corePages";

export default function PortalShell({
  viewer,
  pageSlug,
  selection,
  userCount,
  suppressed,
  children,
}: {
  viewer: PortalViewer;
  pageSlug: string;
  selection: PortalScopeSelection;
  userCount: number | null;
  suppressed: boolean;
  children: ReactNode;
}) {
  const pages = visibleCorePages(viewer);
  const scopeToken = `${selection.kind}:${selection.value}`;
  const pageHref = (slug: string) => {
    const path = slug === "overview" ? "/" : `/${slug}`;
    return `${path}?scope=${encodeURIComponent(scopeToken)}`;
  };

  return (
    <div className="min-h-screen bg-canvas text-default">
      <header className="border-b border-default bg-[#24292f] text-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-5 py-4">
          <Link href={pageHref("overview")} className="!text-white font-semibold tracking-tight">
            GitHub Copilot Usage Metrics
          </Link>
          <div className="flex flex-wrap items-center gap-4">
            <Link href="/help" className="text-sm !text-white underline">Help / FAQ</Link>
            <span className="text-sm text-white/80">Signed in as {viewer.displayName}</span>
            <form action={async () => {
              "use server";
              await signOut({ redirectTo: "/sign-in" });
            }}>
              <button className="text-sm text-white underline" type="submit">Sign out</button>
            </form>
            <form action={pageSlug === "overview" ? "/" : `/${pageSlug}`} className="flex items-center gap-2">
              <label htmlFor="scope-selection" className="text-sm">Scope</label>
              <select
                id="scope-selection"
                name="scope"
                defaultValue={`${selection.kind}:${selection.value}`}
                className="rounded border border-white/30 bg-[#24292f] px-2 py-1 text-sm text-white"
              >
                {viewer.scopeOptions.map((option) => (
                  <option key={`${option.kind}:${option.value}`} value={`${option.kind}:${option.value}`}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button className="rounded border border-white/30 px-2 py-1 text-sm hover:bg-white/10" type="submit">
                Apply
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1440px] gap-6 px-5 py-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Main navigation">
          <ul className="space-y-1">
            {pages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={pageHref(page.slug)}
                  aria-current={page.slug === pageSlug ? "page" : undefined}
                  className={`block rounded px-3 py-2 text-sm ${
                    page.slug === pageSlug ? "bg-neutral-200 font-semibold text-neutral-950" : "hover:bg-neutral-100"
                  }`}
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0">
          <h1 className="sr-only">{pages.find(({ slug }) => slug === pageSlug)?.title ?? "Copilot usage metrics"}</h1>
          <p className="mb-5 text-sm text-muted">
            {suppressed
              ? "Metrics are hidden because this scope is smaller than the minimum group size."
              : userCount === null
                ? "Usage metrics for the selected scope."
                : `${userCount} observed users in the selected scope.`}
          </p>
          {children}
        </main>
      </div>
    </div>
  );
}
