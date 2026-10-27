import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessResult } from "../authz/access";
import { adminRoute, requireAdmin } from "./server";
import { GET as grantsGet, POST as grantsPost, DELETE as grantsDelete } from "../app/api/admin/grants/route";
import { POST as legacyPost } from "../app/api/admin/access/route";
import { GET as principalsGet } from "../app/api/admin/principals/route";
import { GET as formGet } from "../app/api/admin/grant-form/route";
import { GET as auditGet } from "../app/api/admin/audit/route";
import { GET as historyGet } from "../app/api/admin/login-history/route";
import { GET as hierarchyGet } from "../app/api/admin/hierarchy/route";
import { GET as issuesGet } from "../app/api/admin/issues/route";
import { POST as issuePost } from "../app/api/admin/issues/actions/route";

const mocks = vi.hoisted(() => ({ access: vi.fn(), pool: vi.fn(), auth: vi.fn() }));
vi.mock("../authz/server", () => ({ getAccess: mocks.access }));
vi.mock("../db/pool", () => ({ getPortalSqlPool: mocks.pool }));
vi.mock("../auth/config", () => ({ auth: mocks.auth }));
const principal = { principal_id: "00000000-0000-4000-8000-000000000001", entra_object_id: "00000000-0000-4000-8000-000000000002",
  entra_tenant_id: "00000000-0000-4000-8000-000000000003", github_user_id: null, status: "active" } as const;
const routes = [
  ["grants read", grantsGet, "GET"], ["grant create", grantsPost, "POST"], ["grant revoke", grantsDelete, "DELETE"],
  ["legacy changes", legacyPost, "POST"], ["principals", principalsGet, "GET"], ["form", formGet, "GET"],
  ["audit", auditGet, "GET"], ["login history", historyGet, "GET"], ["hierarchy", hierarchyGet, "GET"],
  ["inbox", issuesGet, "GET"], ["inbox action", issuePost, "POST"],
] as const;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pool.mockResolvedValue({});
});
describe.each(routes)("%s authorization", (_name, route, method) => {
  it.each([
    [{ state: "signed-out", breakGlass: false }, 401],
    [{ state: "no-access", breakGlass: false }, 403],
    [{ state: "unavailable", breakGlass: false }, 503],
    [{ state: "authorized", breakGlass: false, principal, grants: [{ role: "user", scope: "self", scope_value: "" }], namesVisible: false }, 403],
    [{ state: "authorized", breakGlass: false, principal, grants: [{ role: "manager", scope: "team", scope_value: "" }], namesVisible: false }, 403],
  ])("rejects unauthorized access before any admin SQL is opened", async (access, status) => {
    mocks.access.mockResolvedValue(access);
    const response = await route(new Request("http://localhost/api/admin/test", { method }));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.correlationId).toBe(response.headers.get("X-Correlation-ID"));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
});
describe("admin actor boundary", () => {
  it("accepts a current SQL admin and attributes the immutable actor", async () => {
    mocks.access.mockResolvedValue({ state: "authorized", breakGlass: false, principal,
      grants: [{ role: "admin", scope: "company", scope_value: "" }], namesVisible: false } satisfies AccessResult);
    expect(await requireAdmin("correlation")).toEqual({ ok: true, actor: { principalId: principal.principal_id, entraObjectId: principal.entra_object_id } });
  });
  it("permits verified break-glass on admin without manufacturing a Principal", async () => {
    mocks.access.mockResolvedValue({ state: "unavailable", breakGlass: true });
    mocks.auth.mockResolvedValue({ identity: { provider: "entra", objectId: principal.entra_object_id } });
    expect(await requireAdmin("correlation")).toEqual({ ok: true, actor: { principalId: null, entraObjectId: principal.entra_object_id } });
  });
  it("rejects cross-origin mutations and surfaces malformed input as typed 422", async () => {
    mocks.access.mockResolvedValue({ state: "authorized", breakGlass: false, principal, grants: [{ role: "admin" }] });
    const forbidden = await adminRoute(new Request("http://localhost/api/admin/grants", {
      method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json" }, body: "{}",
    }), "grants");
    expect(forbidden.status).toBe(403);
    const malformed = await adminRoute(new Request("http://localhost/api/admin/grants", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), "grants");
    expect(malformed.status).toBe(422);
    expect((await malformed.json()).error.code).toBe("invalid_request");
  });
  it("never exposes SQL failures as empty or successful responses", async () => {
    mocks.access.mockResolvedValue({ state: "authorized", breakGlass: false, principal, grants: [{ role: "admin" }] });
    mocks.pool.mockRejectedValue(new Error("sensitive SQL diagnostic"));
    const response = await adminRoute(new Request("http://localhost/api/admin/audit"), "audit");
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive SQL diagnostic");
  });
});
