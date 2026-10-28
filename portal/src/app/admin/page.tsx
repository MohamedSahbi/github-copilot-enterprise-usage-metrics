import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isGuid } from "../../../../shared/src/access";
import { requireAdmin } from "../../admin/server";
import { getAccess } from "../../authz/server";
import { readAdminPage } from "../../admin/page-data";
import AccessControl from "../../admin/AccessControl";
import IssuesInbox from "../../admin/IssuesInbox";
import HealthPanel from "../../admin/HealthPanel";
import { parsePage } from "../../usage/api";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration | GitHub Copilot Usage Metrics" };
const sections = {
  access: "Access Control", hierarchy: "Manager Hierarchy", audit: "Audit Log",
  "login-history": "Login History", issues: "Issues Inbox", health: "Health", upstream: "Upstream Version",
};
type Section = keyof typeof sections;
type Params = { section?: string; page?: string; principalId?: string; userId?: string };

function Table({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  return <div className="overflow-auto"><table className="w-full text-left">
    <thead><tr>{headings.map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index} className="border-t border-default">
      {row.map((cell, column) => <td key={column} className="p-3">{cell ?? "-"}</td>)}
    </tr>)}</tbody>
  </table>{rows.length === 0 && <p>No records found.</p>}</div>;
}
const date = (value: string | Date | null) => value === null ? "-" : new Date(value).toISOString();

async function AdminContent({ section, params, correlationId }: { section: Section; params: Params; correlationId: string }) {
  if (section === "upstream") return <section className="space-y-3">
    <h2 className="text-xl font-semibold">Pinned upstream and portal release</h2>
    <p>Portal release: {process.env.PORTAL_RELEASE_VERSION}</p>
    <p>Pinned upstream commit: <code>{process.env.PORTAL_UPSTREAM_COMMIT}</code></p>
    <p>Read-only build metadata. Upstream updates are reviewed submodule changes, not runtime sync.</p>
  </section>;
  const parsedPage = parsePage(new URLSearchParams(params.page ? { page: params.page } : {}));
  if (!parsedPage.ok) notFound();
  const page = parsedPage.page;
  if ((page.page - 1) * page.pageSize > 2147483647) notFound();
  if (params.principalId && !isGuid(params.principalId)) notFound();
  if (params.userId && (!/^[1-9]\d*$/.test(params.userId) || !Number.isSafeInteger(Number(params.userId)))) notFound();
  const data = await readAdminPage(section, page, params, correlationId);
  if (!data) return <section role="alert"><h2 className="text-xl font-semibold">Administration data unavailable</h2>
    <p>SQL or the requested administrative data could not be read. No successful operation is implied. Reference: {correlationId}</p></section>;
  let content: ReactNode;
    switch (data.section) {
      case "access": {
        content = <AccessControl key={`${params.principalId}:${page.page}`} formData={data.formData}
          principals={data.principals} grants={data.grants} principalId={params.principalId ?? ""} />;
        break;
      }
      case "audit": {
        content = <Table headings={["Time", "Actor Entra ID", "Action", "Target", "Outcome", "Correlation"]}
          rows={data.rows.map((row) => [date(row.occurred_at), row.actor_entra_oid, row.action, row.target_id, row.outcome, row.correlation_id])} />;
        break;
      }
      case "login-history": {
        content = <section className="space-y-4">
          <form action="/admin" className="flex items-center gap-3">
            <input type="hidden" name="section" value="login-history" />
            <label htmlFor="history-user">Numeric GitHub user ID</label>
            <input id="history-user" name="userId" required inputMode="numeric" defaultValue={params.userId} className="rounded border border-default p-2" />
            <button type="submit" className="rounded border border-default p-2">Load history</button>
          </form>
          <p>Audit-only history. Visible to administrators, regardless of the named-metrics setting.</p>
          <Table headings={["User ID", "Login", "First seen", "Last seen", "Hashed"]}
            rows={data.rows.map((row) => [row.user_id, row.login, date(row.first_seen_day).slice(0, 10), date(row.last_seen_day).slice(0, 10), row.is_hashed_login ? "Yes" : "No"])} />
        </section>;
        break;
      }
      case "issues": {
        content = <IssuesInbox issues={data.rows} />; break;
      }
      case "hierarchy": {
        content = <section className="space-y-4">
          <h2 className="text-xl font-semibold">Current manager hierarchy</h2>
          <button type="button" disabled aria-describedby="sync-unavailable" className="rounded border border-default p-2">Sync now</button>
          <p id="sync-unavailable">Manual sync is unavailable: no durable directory request receiver is implemented.
            No sync can be requested here. Scheduled directory activation remains separately controlled.</p>
          <Table headings={["User ID", "Entra object ID", "Manager object ID", "Department", "Business area", "Manager resolved"]}
            rows={data.rows.map((row) => [row.user_id, row.entra_object_id, row.manager_entra_object_id, row.department, row.business_area, row.manager_resolved ? "Yes" : "No"])} />
        </section>;
        break;
      }
      case "health": return <HealthPanel runs={data.runs} observedAt={data.observedAt} />;
    }
  const href = (next: number) => {
    const query = new URLSearchParams({ section, page: String(next) });
    if (params.principalId) query.set("principalId", params.principalId);
    if (params.userId) query.set("userId", params.userId);
    return `/admin?${query}`;
  };
  return <>{content}<nav aria-label="Pagination" className="mt-5 flex gap-4">
    {page.page > 1 && <Link href={href(page.page - 1)}>Previous page</Link>}
    <span>Page {page.page}</span>
    {page.page * page.pageSize < data.total && <Link href={href(page.page + 1)}>Next page</Link>}
  </nav></>;
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<Params> }) {
  const correlationId = randomUUID();
  const gate = await requireAdmin(correlationId);
  if (!gate.ok) {
    if (gate.response.status === 401) redirect("/sign-in");
    if (gate.response.status === 503) redirect("/service-unavailable");
    // /no-access sends any authorized viewer back to "/", so signed-in non-admins get a 404 instead.
    if ((await getAccess(correlationId)).state === "authorized") notFound();
    redirect("/no-access");
  }
  const params = await searchParams;
  if (Object.values(params).some((value) => value !== undefined && typeof value !== "string")) notFound();
  const section = params.section ?? "access";
  if (!Object.hasOwn(sections, section)) notFound();
  return <main className="mx-auto max-w-[1440px] space-y-6 p-6">
    <Link href="/">Back to portal</Link>
    <h1 className="text-3xl font-semibold">Administration</h1>
    <p>Manage access control, manager hierarchy and the audit log.</p>
    <nav aria-label="Admin sections" className="flex flex-wrap gap-5 border-b border-default pb-3">
      {Object.entries(sections).map(([key, title]) => <Link key={key} href={`/admin?section=${key}`}
        aria-current={section === key ? "page" : undefined} className={section === key ? "font-bold underline" : ""}>{title}</Link>)}
    </nav>
    <AdminContent section={section as Section} params={params} correlationId={correlationId} />
  </main>;
}
