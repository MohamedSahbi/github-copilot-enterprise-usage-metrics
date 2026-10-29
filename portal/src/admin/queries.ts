import sql from "mssql";
import type { AdminGrant, AdminPrincipalSummary } from "../../../shared/src/api";
import type { AuditLogRow, DimUserLoginHistoryRow, DimUserRow } from "../../../shared/src/rows";
import { deriveIssueStatus, ISSUE_ACTIONS, type InboxIssue, type IssueAction, type IssueType } from "../../../shared/src/issues";
export interface HealthRunObservation {
  source_kind: string;
  last_run: Date | null;
  last_success: Date | null;
}

export type AdminReadSection = "principals" | "grants" | "audit" | "login-history" | "issues" | "hierarchy";
export type HierarchyRow = Pick<DimUserRow, "user_id" | "entra_object_id" | "display_name" | "email" | "manager_entra_object_id" |
  "manager_email" | "department" | "business_area" | "manager_resolved"> & { manager_display_name: string | null };
export type AdminAuditRow = AuditLogRow & { actor_display_name: string | null; actor_email: string | null };
type Page = { page: number; pageSize: number };
export async function readHealthRuns(pool: sql.ConnectionPool): Promise<HealthRunObservation[]> {
  return (await pool.request().query<HealthRunObservation>(`
    SELECT source_kind, MAX(completed_at) AS last_run,
      MAX(CASE WHEN status = 'published' THEN completed_at END) AS last_success
    FROM portal.IngestionRun GROUP BY source_kind`)).recordset;
}
// Latest directory name and email for an Entra object ID, for recognition only (active rows first).
const DIRECTORY_PERSON = (oid: string) => `SELECT TOP (1) display_name, email FROM portal.dim_user
  WHERE entra_object_id = ${oid} ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, user_id DESC`;

function pageRequest(pool: sql.ConnectionPool, page: Page) {
  return pool.request().input("offset", sql.Int, (page.page - 1) * page.pageSize).input("size", sql.Int, page.pageSize);
}

export async function readPrincipals(pool: sql.ConnectionPool, page: Page, tenant: string) {
  const result = await pageRequest(pool, page).input("tenant", sql.UniqueIdentifier, tenant)
    .query<AdminPrincipalSummary & { total: number }>(`
      SELECT p.principal_id AS principalId, CONVERT(char(36), p.entra_object_id) AS entraObjectId,
        u.display_name AS displayName, u.email, p.status,
        CAST(CASE WHEN p.entra_object_id IS NULL THEN 0 ELSE 1 END AS bit) AS hasEntraIdentity,
        CAST(CASE WHEN p.github_user_id IS NULL THEN 0 ELSE 1 END AS bit) AS hasGithubIdentity,
        p.permissions_verified_at AS permissionsVerifiedAt, COUNT(*) OVER() AS total
      FROM portal.Principal p
      OUTER APPLY (${DIRECTORY_PERSON("p.entra_object_id")}) u
      WHERE p.entra_tenant_id = @tenant
      ORDER BY CASE WHEN u.display_name IS NULL THEN 1 ELSE 0 END, u.display_name, p.principal_id
      OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  return result.recordset;
}

export async function readGrants(pool: sql.ConnectionPool, page: Page, principalId: string, tenant: string) {
  return (await pageRequest(pool, page)
    .input("id", sql.UniqueIdentifier, principalId).input("tenant", sql.UniqueIdentifier, tenant)
    .query<AdminGrant & { total: number }>(`
      SELECT g.grant_id AS grantId, g.role, g.scope, g.scope_value AS scopeValue,
        CAST(NULL AS datetime2) AS revokedAt, COUNT(*) OVER() AS total
      FROM portal.v_active_grant g JOIN portal.Principal p ON p.principal_id = g.principal_id
      WHERE g.principal_id = @id AND p.entra_tenant_id = @tenant
      ORDER BY g.grant_id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`)).recordset;
}

export async function readAudit(pool: sql.ConnectionPool, page: Page) {
  return (await pageRequest(pool, page).query<AdminAuditRow & { total: number }>(`
    WITH events AS (
      SELECT audit_id, occurred_at, actor_principal_id, actor_entra_oid, action,
        target_type, target_id, outcome, correlation_id, detail_json, 'portal' AS writer
      FROM portal.AuditLog
      UNION ALL
      SELECT event_id, occurred_at, NULL, NULL, action, target_type, target_id, outcome,
        correlation_id, NULL, 'ingestion' FROM portal.IngestionAuditEvent
    )
    SELECT audit_id, occurred_at, actor_principal_id, actor_entra_oid, a.display_name AS actor_display_name,
      a.email AS actor_email, action, target_type, target_id, outcome, correlation_id, detail_json, COUNT(*) OVER() AS total
    FROM events OUTER APPLY (${DIRECTORY_PERSON("events.actor_entra_oid")}) a ORDER BY occurred_at DESC, writer, audit_id DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`)).recordset;
}

export async function readLoginHistory(pool: sql.ConnectionPool, page: Page, userId: number) {
  return (await pageRequest(pool, page).input("user", sql.BigInt, userId)
    .query<DimUserLoginHistoryRow & { total: number }>(`
      SELECT user_id, login, first_seen_day, last_seen_day, is_hashed_login, COUNT(*) OVER() AS total
      FROM portal.dim_user_login_history WHERE user_id = @user
      ORDER BY first_seen_day DESC, login OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`)).recordset;
}

export async function readHierarchy(pool: sql.ConnectionPool, page: Page) {
  return (await pageRequest(pool, page).query<HierarchyRow & { total: number }>(`
    SELECT u.user_id, u.entra_object_id, u.display_name, u.email, u.manager_entra_object_id,
      COALESCE(m.display_name, u.manager_email) AS manager_display_name, u.manager_email,
      u.department, u.business_area, u.manager_resolved, COUNT(*) OVER() AS total
    FROM portal.dim_user u OUTER APPLY (${DIRECTORY_PERSON("u.manager_entra_object_id")}) m
    WHERE u.state = 'active'
    ORDER BY CASE WHEN u.display_name IS NULL THEN 1 ELSE 0 END, u.display_name, u.user_id OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`)).recordset;
}

export async function readIssues(pool: sql.ConnectionPool, page: Page): Promise<(InboxIssue & { total: number })[]> {
  const rows = (await pageRequest(pool, page).query<{
    issueId: number; type: IssueType; errorCode: string; reportDay: Date | null; createdAt: Date;
    lastAction: IssueAction | null; handledAt: Date | null; total: number;
  }>(`SELECT i.issue_id AS issueId, i.issue_type AS type, i.error_code AS errorCode,
      i.report_day AS reportDay, i.created_at AS createdAt, i.handled_at AS handledAt,
      a.action AS lastAction, COUNT(*) OVER() AS total
    FROM portal.ValidationIssue i
    OUTER APPLY (SELECT TOP (1) action FROM portal.IssueAction
      WHERE issue_id = i.issue_id ORDER BY action_id DESC) a
    WHERE i.issue_type IS NOT NULL
    ORDER BY i.created_at DESC, i.issue_id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`)).recordset;
  return rows.map((row) => ({
    issueId: row.issueId, type: row.type, errorCode: row.errorCode,
    reportDay: row.reportDay?.toISOString().slice(0, 10) ?? null,
    createdAt: row.createdAt.toISOString(), fileName: null,
    status: deriveIssueStatus({ lastAction: row.lastAction, handledAt: row.handledAt?.toISOString() ?? null }),
    availableActions: row.lastAction === null && row.handledAt === null ? ISSUE_ACTIONS[row.type] : [],
    total: row.total,
  }));
}
