import { getPortalSqlPool } from "../db/pool";
import { readAccessSettings } from "../auth/settings";
import { grantFormData } from "./grants";
import { readAudit, readGrants, readHealthRuns, readHierarchy, readIssues, readLoginHistory, readPrincipals } from "./queries";

export async function readAdminPage(
  section: "access" | "audit" | "login-history" | "issues" | "hierarchy" | "health",
  page: { page: number; pageSize: number },
  params: { principalId?: string; userId?: string },
  correlationId: string,
) {
  try {
    const pool = await getPortalSqlPool();
    switch (section) {
      case "access": {
        const principals = await readPrincipals(pool, params.principalId ? { page: 1, pageSize: 100 } : page, process.env.ENTRA_TENANT_ID!);
        const grants = params.principalId ? await readGrants(pool, page, params.principalId, process.env.ENTRA_TENANT_ID!) : [];
        return {
          section, principals, grants, formData: await grantFormData(pool, readAccessSettings()),
          total: params.principalId ? grants[0]?.total ?? 0 : principals[0]?.total ?? 0,
        };
      }
      case "audit": {
        const rows = await readAudit(pool, page);
        return { section, rows, total: rows[0]?.total ?? 0 };
      }
      case "login-history": {
        const rows = params.userId ? await readLoginHistory(pool, page, Number(params.userId)) : [];
        return { section, rows, total: rows[0]?.total ?? 0 };
      }
      case "issues": {
        const rows = await readIssues(pool, page);
        return { section, rows, total: rows[0]?.total ?? 0 };
      }
      case "hierarchy": {
        const rows = await readHierarchy(pool, page);
        return { section, rows, total: rows[0]?.total ?? 0 };
      }
      case "health": return { section, runs: await readHealthRuns(pool), observedAt: Date.now(), total: 0 };
    }
  } catch {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "admin.page_failed", correlationId })}\n`);
    return null;
  }
}
