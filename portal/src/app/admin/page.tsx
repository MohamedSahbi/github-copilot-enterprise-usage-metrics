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
import SubPageFrame, { Card, DataTable, buttonClass, fieldClass } from "../../components/SubPageFrame";
import SideNavCard from "../../components/SideNavCard";
import PersonLabel from "../../components/PersonLabel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration | GitHub Copilot Usage Metrics" };
const sections = {
  access: "Access Control", hierarchy: "Manager Hierarchy", audit: "Audit Log",
  "login-history": "Login History", issues: "Issues Inbox", health: "Health", upstream: "Upstream Version",
};
type Section = keyof typeof sections;
type Params = { section?: string; page?: string; principalId?: string; userId?: string };

const date = (value: string | Date | null) => value === null ? "-" : new Date(value).toISOString();

async function AdminContent({ section, params, correlationId }: { section: Section; params: Params; correlationId: string }) {
  if (section === "upstream") return <Card title="Pinned upstream and portal release">
    <p className="text-sm">Portal release: <span className="font-semibold">{process.env.PORTAL_RELEASE_VERSION}</span></p>
    <p className="text-sm">Pinned upstream commit: <code className="rounded bg-[#f6f8fa] px-1.5 py-0.5 font-mono text-xs">{process.env.PORTAL_UPSTREAM_COMMIT}</code></p>
    <p className="text-sm text-muted">Read-only build metadata. Upstream updates are reviewed submodule changes, not runtime sync.</p>
  </Card>;
  const parsedPage = parsePage(new URLSearchParams(params.page ? { page: params.page } : {}));
  if (!parsedPage.ok) notFound();
  const page = parsedPage.page;
  if ((page.page - 1) * page.pageSize > 2147483647) notFound();
  if (params.principalId && !isGuid(params.principalId)) notFound();
  if (params.userId && (!/^[1-9]\d*$/.test(params.userId) || !Number.isSafeInteger(Number(params.userId)))) notFound();
  const data = await readAdminPage(section, page, params, correlationId);
  if (!data) return <section role="alert" className="rounded-md border border-[#ff818266] bg-[#ffebe9] p-4 text-sm">
    <h2 className="text-base font-semibold text-[#d1242f]">Administration data unavailable</h2>
    <p className="mt-1">SQL or the requested administrative data could not be read. No successful operation is implied. Reference: {correlationId}</p></section>;
  let content: ReactNode;
    switch (data.section) {
      case "access": {
        content = <AccessControl key={`${params.principalId}:${page.page}`} formData={data.formData}
          principals={data.principals} grants={data.grants} principalId={params.principalId ?? ""} />;
        break;
      }
      case "audit": {
        content = <Card title="Audit log"><DataTable headings={["Time", "Actor", "Action", "Target", "Outcome", "Correlation"]}
          rows={data.rows.map((row) => [date(row.occurred_at),
            row.actor_entra_oid ? <PersonLabel displayName={row.actor_display_name} email={row.actor_email} id={row.actor_entra_oid} /> : "Ingestion",
            row.action, row.target_id, row.outcome, row.correlation_id])} /></Card>;
        break;
      }
      case "login-history": {
        content = <Card title="Login history">
          <form action="/admin" className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="section" value="login-history" />
            <label htmlFor="history-user">Numeric GitHub user ID</label>
            <input id="history-user" name="userId" required inputMode="numeric" defaultValue={params.userId} className={fieldClass} />
            <button type="submit" className={buttonClass}>Load history</button>
          </form>
          <p className="text-sm text-muted">Audit-only history. Visible to administrators, regardless of the named-metrics setting.</p>
          <DataTable headings={["User ID", "Login", "First seen", "Last seen", "Hashed"]}
            rows={data.rows.map((row) => [row.user_id, row.login, date(row.first_seen_day).slice(0, 10), date(row.last_seen_day).slice(0, 10), row.is_hashed_login ? "Yes" : "No"])} />
        </Card>;
        break;
      }
      case "issues": {
        content = <IssuesInbox issues={data.rows} />; break;
      }
      case "hierarchy": {
        content = <Card title="Current manager hierarchy"
          actions={<button type="button" disabled aria-describedby="sync-unavailable" className={buttonClass}>Sync now</button>}>
          <p id="sync-unavailable" className="text-sm text-muted">Manual sync is unavailable: no durable directory request receiver is implemented.
            No sync can be requested here. Scheduled directory activation remains separately controlled.</p>
          <DataTable headings={["Person", "Manager", "Department", "Business area", "Manager resolved", "User ID"]}
            rows={data.rows.map((row) => [
              <PersonLabel key="person" displayName={row.display_name} email={row.email} id={row.entra_object_id} />,
              row.manager_entra_object_id
                ? <PersonLabel key="manager" displayName={row.manager_display_name} email={row.manager_email} id={row.manager_entra_object_id} /> : null,
              row.department, row.business_area, row.manager_resolved ? "Yes" : "No", row.user_id])} />
        </Card>;
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
  return <>{content}<nav aria-label="Pagination" className="flex items-center justify-center gap-3 text-sm">
    {page.page > 1 && <Link href={href(page.page - 1)} className={buttonClass}>Previous page</Link>}
    <span className="text-muted">Page {page.page}</span>
    {page.page * page.pageSize < data.total && <Link href={href(page.page + 1)} className={buttonClass}>Next page</Link>}
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
  return <SubPageFrame title="Administration" description="Manage access control, manager hierarchy and the audit log."
    nav={<SideNavCard label="Admin sections" heading="Administration" items={Object.entries(sections).map(([key, title]) => ({
      href: `/admin?section=${key}`, label: title, icon: key as Section, current: section === key,
    }))} />}>
    <AdminContent section={section as Section} params={params} correlationId={correlationId} />
  </SubPageFrame>;
}
