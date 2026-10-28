import Link from "next/link";
import type { ReactNode } from "react";

// Header and two-column layout for pages outside the metrics shell (administration, Help / FAQ).
export default function SubPageFrame({
  title,
  description,
  nav,
  children,
}: {
  title?: string;
  description?: ReactNode;
  nav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f6f8fa] text-default">
      <header className="border-b border-default bg-[#24292f] text-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="!text-white font-semibold tracking-tight">GitHub Copilot Usage Metrics</Link>
          <div className="flex items-center gap-2 text-sm">
            <Link href="/help" className="rounded-md px-3 py-1.5 !text-white transition-colors hover:bg-white/15">Help / FAQ</Link>
            <Link href="/" className="rounded-md border border-white/30 px-3 py-1.5 !text-white transition-colors hover:bg-white/15">
              Back to portal
            </Link>
          </div>
        </div>
      </header>
      <div className={`mx-auto grid max-w-[1440px] gap-6 px-5 py-6 ${nav ? "lg:grid-cols-[240px_minmax(0,1fr)]" : ""}`}>
        {nav && <aside>{nav}</aside>}
        <main className="min-w-0 space-y-6">
          {title && <div>
            <h1 className="text-2xl font-semibold text-[#1f2328]">{title}</h1>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>}
          {children}
        </main>
      </div>
    </div>
  );
}

// Bordered white card that holds one block of page content.
export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-default bg-white shadow-sm">
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default px-4 py-3">
          {title && <h2 className="text-base font-semibold text-[#1f2328]">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

// Primer-like table: muted header row, row hover, scrolls sideways on narrow screens.
export function DataTable({ caption, headings, rows, empty = "No records found." }: {
  caption?: string; headings: string[]; rows: ReactNode[][]; empty?: string;
}) {
  return (
    <div className="overflow-auto rounded-md border border-default">
      <table className="w-full text-left text-sm">
        {caption && <caption className="border-b border-default bg-white px-3 py-2 text-left font-semibold">{caption}</caption>}
        <thead className="bg-[#f6f8fa] text-xs font-semibold text-[#59636e]">
          <tr>{headings.map((heading) => <th key={heading} className="px-3 py-2">{heading}</th>)}</tr>
        </thead>
        <tbody>{rows.map((row, index) => (
          <tr key={index} className="border-t border-default transition-colors hover:bg-[#f6f8fa]">
            {row.map((cell, column) => <td key={column} className="px-3 py-2 align-top">{cell ?? "-"}</td>)}
          </tr>
        ))}</tbody>
      </table>
      {rows.length === 0 && <p className="border-t border-default px-3 py-6 text-center text-sm text-muted">{empty}</p>}
    </div>
  );
}

// Button and field classes shared by the admin forms, styled like Primer's default button and inputs.
export const buttonClass =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-[#d1d9e0] bg-[#f6f8fa] px-3 py-1.5 text-sm font-medium text-[#25292e] shadow-sm transition-colors " +
  "hover:border-[#c4cdd5] hover:bg-[#eff2f5] active:bg-[#e6eaef] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0969da] " +
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-[#f6f8fa]";
export const primaryActionClass =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-[#1f883d] bg-[#1f883d] px-3 py-1.5 text-sm font-medium !text-white shadow-sm transition-colors " +
  "hover:bg-[#1c8139] active:bg-[#197935] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0969da] " +
  "disabled:cursor-not-allowed disabled:opacity-60";
export const dangerActionClass =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-[#d1d9e0] bg-[#f6f8fa] px-3 py-1 text-sm font-medium text-[#d1242f] transition-colors " +
  "hover:border-[#d1242f] hover:bg-[#d1242f] hover:text-white active:bg-[#a40e26] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0969da] " +
  "disabled:cursor-not-allowed disabled:opacity-60";
export const fieldClass =
  "max-w-full rounded-md border border-[#d1d9e0] bg-white px-3 py-1.5 text-sm text-[#1f2328] shadow-inner transition-shadow focus:border-[#0969da] focus:outline-none focus:ring-2 focus:ring-[#0969da]/30";
export const alertClass = "rounded-md border border-[#ff818266] bg-[#ffebe9] px-4 py-3 text-sm text-[#1f2328]";
export const statusClass = "rounded-md border border-[#4ac26b66] bg-[#dafbe1] px-4 py-3 text-sm text-[#1f2328]";
