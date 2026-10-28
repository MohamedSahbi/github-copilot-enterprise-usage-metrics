import { randomUUID } from "node:crypto";
import { auth } from "../auth/config";
import { readAccessSettings } from "../auth/settings";
import { getAccess } from "../authz/server";
import { canAccess } from "../authz/access";
import { getPortalSqlPool } from "../db/pool";
import { isGuid } from "../../../shared/src/access";
import { errorResponse, parsePage, responseHeaders, responseMeta } from "../usage/api";
import { changeGrant, grantFormData, type AdminActor } from "./grants";
import { AdminError, parseGrantInput, parseIssueInput } from "./input";
import { applyIssueAction } from "./issues";
import { readAudit, readGrants, readHierarchy, readIssues, readLoginHistory, readPrincipals, type AdminReadSection } from "./queries";

export async function requireAdmin(correlationId: string): Promise<
  { ok: true; actor: AdminActor } | { ok: false; response: Response }
> {
  const access = await getAccess(correlationId);
  if (!canAccess(access, "admin")) {
    const status = access.state === "signed-out" ? 401 : access.state === "unavailable" ? 503 : 403;
    const code = status === 401 ? "unauthenticated" : status === 503 ? "permissions_unavailable" : "forbidden";
    return { ok: false, response: errorResponse({ code, message: "Administrator access is required.", status }, correlationId) };
  }
  if (access.state === "authorized") {
    return { ok: true, actor: { principalId: access.principal.principal_id, entraObjectId: access.principal.entra_object_id! } };
  }
  const session = await auth();
  if (session?.identity?.provider !== "entra") throw new AdminError("forbidden", 403);
  return { ok: true, actor: { principalId: null, entraObjectId: session.identity.objectId } };
}

// request.url reflects the dev server's bind host (localhost), not the browser origin, so compare
// against the configured canonical AUTH_URL origin, as Feedback mutations do.
function mutationOrigin() {
  const configured = process.env.AUTH_URL;
  if (!configured) throw new Error("AUTH_URL is required for administration mutations");
  return new URL(configured).origin;
}

function tenantId() {
  const tenant = process.env.ENTRA_TENANT_ID;
  if (!tenant || !isGuid(tenant)) throw new Error("ENTRA_TENANT_ID is required");
  return tenant;
}

function positiveId(raw: string | null): number {
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AdminError("invalid_request", 400);
  return Number(raw);
}

export async function adminRoute(
  request: Request,
  section: AdminReadSection | "grant-form" | "access" | "issue-action",
): Promise<Response> {
  const correlationId = randomUUID();
  try {
    const gate = await requireAdmin(correlationId);
    if (!gate.ok) return gate.response;
    const headers = responseHeaders(correlationId);
    const meta = responseMeta(correlationId);
    // Mutation bodies cannot be submitted by cross-origin browser forms or simple fetches.
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if ((origin && origin !== mutationOrigin()) ||
        request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
        throw new AdminError("forbidden", 403);
      }
    }
    const pool = await getPortalSqlPool();
    if (section === "grant-form") {
      return Response.json({ meta, data: await grantFormData(pool, readAccessSettings()) }, { headers });
    }
    if (request.method !== "GET") {
      let body: unknown;
      try { body = await request.json(); } catch { throw new AdminError("invalid_request"); }
      if (section === "issue-action") {
        return Response.json({ meta, data: await applyIssueAction(pool, gate.actor, parseIssueInput(body), correlationId) }, { headers });
      }
      const input = parseGrantInput(body, section === "access" ? "legacy" : "create");
      const action = section === "access" ? input.action! : request.method === "DELETE" ? "revoke" : "grant";
      const data = await changeGrant(pool, gate.actor, tenantId(), input, action, readAccessSettings(), correlationId);
      return Response.json({ meta, data }, { status: action === "grant" ? 201 : 200, headers });
    }
    const params = new URL(request.url).searchParams;
    const page = parsePage(params);
    if (!page.ok) return errorResponse(page.failure, correlationId);
    if ((page.page.page - 1) * page.page.pageSize > 2147483647) throw new AdminError("invalid_request", 400);
    let rows: { total: number }[];
    switch (section) {
      case "principals":
        rows = await readPrincipals(pool, page.page, tenantId()); break;
      case "grants": {
        const principal = params.get("principalId");
        if (!principal || !isGuid(principal)) throw new AdminError("invalid_request", 400);
        rows = await readGrants(pool, page.page, principal, tenantId()); break;
      }
      case "audit": rows = await readAudit(pool, page.page); break;
      case "login-history": rows = await readLoginHistory(pool, page.page, positiveId(params.get("userId"))); break;
      case "issues": rows = await readIssues(pool, page.page); break;
      case "hierarchy": rows = await readHierarchy(pool, page.page); break;
      default: throw new AdminError("not_found", 404);
    }
    return Response.json({
      meta, data: rows.map((row) => {
        const data = { ...row };
        Reflect.deleteProperty(data, "total");
        return data;
      }),
      page: { ...page.page, totalItems: rows[0]?.total ?? 0 },
    }, { headers });
  } catch (error) {
    if (error instanceof AdminError) {
      return Response.json({ error: { code: error.code, message: `Admin request rejected: ${error.code}.`, correlationId } },
        { status: error.status, headers: responseHeaders(correlationId) });
    }
    process.stderr.write(`${JSON.stringify({ level: "error", event: "admin.request_failed", correlationId })}\n`);
    return errorResponse({ code: "internal_error", message: "The administration request could not be completed.", status: 503 }, correlationId);
  }
}
