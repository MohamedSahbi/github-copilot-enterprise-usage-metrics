import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as overview } from "./overview/route";
import { GET as breakdown } from "./breakdown/route";
import { GET as users } from "../users/route";

const { getAccess, getPortalSqlPool, getUsageOverview, getUsageBreakdown, getUserUsage, resolveUsageRange } = vi.hoisted(() => ({
  getAccess: vi.fn(),
  getPortalSqlPool: vi.fn(),
  getUsageOverview: vi.fn(),
  getUsageBreakdown: vi.fn(),
  getUserUsage: vi.fn(),
  resolveUsageRange: vi.fn(),
}));

vi.mock("../../../authz/server", () => ({ getAccess }));
vi.mock("../../../db/pool", () => ({ getPortalSqlPool }));
vi.mock("../../../usage/sql-usage", () => ({ getUsageOverview, getUsageBreakdown, getUserUsage, resolveUsageRange }));

describe("scoped usage API route gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveUsageRange.mockResolvedValue({ ok: true, range: { from: "2026-02-24", to: "2026-03-02" } });
  });

  it.each([
    ["overview", overview, "/api/usage/overview?period=last_7_days"],
    ["breakdown", breakdown, "/api/usage/breakdown?period=last_7_days&kind=feature"],
    ["users", users, "/api/users?period=last_7_days"],
  ])("returns 401 with a correlation ID for unauthenticated %s requests", async (_name, handler, url) => {
    getAccess.mockResolvedValue({ state: "signed-out", breakGlass: false });
    const response = await handler(new NextRequest(`http://localhost${url}`));
    const body = await response.json() as { error: { code: string; correlationId: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get("X-Correlation-ID")).toBe(body.error.correlationId);
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("checks signed-in status before validating request parameters", async () => {
    getAccess.mockResolvedValue({ state: "signed-out", breakGlass: false });
    const response = await overview(new NextRequest("http://localhost/api/usage/overview?from=nope"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  });

  it("denies a signed-in persona with no grants before opening a usage-data connection", async () => {
    getAccess.mockResolvedValue({ state: "no-access", breakGlass: false });
    const response = await overview(new NextRequest("http://localhost/api/usage/overview?from=2026-03-01&to=2026-03-02"));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("denies per-user detail unless the deployment setting permits it", async () => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "user", scope: "self", scope_value: "" }],
      namesVisible: false,
    });
    const response = await users(new NextRequest("http://localhost/api/users?from=2026-03-01&to=2026-03-02"));
    const body = await response.json() as { error: { code: string; correlationId: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("per_user_detail_disabled");
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("validates date range and paging without opening a usage-data connection", async () => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "user", scope: "self", scope_value: "" }],
      namesVisible: false,
    });
    const response = await breakdown(new NextRequest("http://localhost/api/usage/breakdown?period=last_7_days&kind=feature&pageSize=101"));

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("page_size_too_large");
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get("X-Correlation-ID")).toBe(body.error.correlationId);
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("rejects arbitrary date ranges before opening a usage-data connection", async () => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "user", scope: "self", scope_value: "" }],
      namesVisible: false,
    });
    const response = await overview(new NextRequest("http://localhost/api/usage/overview?from=2026-03-01&to=2026-03-02"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("rejects a calendar month that is not yet complete", async () => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "user", scope: "self", scope_value: "" }],
      namesVisible: false,
    });
    getPortalSqlPool.mockResolvedValue({});
    resolveUsageRange.mockResolvedValue({ ok: false });
    const response = await overview(new NextRequest("http://localhost/api/usage/overview?period=calendar_month&month=2026-03"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("keeps IDE requests scoped to server grants and fixed periods without overriding suppression or returning names", async () => {
    const access = {
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "executive", scope: "department", scope_value: "app-test" }],
      namesVisible: false,
    };
    getAccess.mockResolvedValue(access);
    const pool = {};
    getPortalSqlPool.mockResolvedValue(pool);
    getUsageBreakdown.mockResolvedValue({
      rows: [{ suppressed: true, userCount: null, value: null }], totalItems: 1,
    });

    const response = await breakdown(new NextRequest(
      "http://localhost/api/usage/breakdown?period=last_7_days&kind=ide&organizationIds=119",
    ));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(resolveUsageRange).toHaveBeenCalledWith(pool, {
      ok: true, period: "last_7_days", organizationIds: [119], kind: "ide", page: 1, pageSize: 50,
    });
    expect(getUsageBreakdown).toHaveBeenCalledWith(pool, access, {
      from: "2026-02-24", to: "2026-03-02", kind: "ide", page: 1, pageSize: 50,
    }, expect.any(String));
    expect(body.data).toEqual([{ suppressed: true, userCount: null, value: null }]);
    expect(body.meta.minGroupSize).toBe(5);
  });

  it.each([
    ["overview", overview, "/api/usage/overview?period=last_7_days", getUsageOverview, {
      series: [],
      adoption: { suppressed: false, userCount: 5, value: {} },
    }],
    ["breakdown", breakdown, "/api/usage/breakdown?period=last_7_days&kind=feature", getUsageBreakdown, []],
    ["users", users, "/api/users?period=last_7_days", getUserUsage, []],
  ])("includes response metadata and a correlation ID for successful %s responses", async (_name, handler, url, query, data) => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "user", scope: "self", scope_value: "" }],
      namesVisible: true,
    });
    getPortalSqlPool.mockResolvedValue({});
    query.mockResolvedValue(_name === "overview" ? data : { rows: data, totalItems: 0 });

    const response = await handler(new NextRequest(`http://localhost${url}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get("X-Correlation-ID")).toBe(body.meta.correlationId);
    expect(body.meta.minGroupSize).toBe(5);
  });

  it("serializes exact user credit aggregate text unchanged in the /api/users response", async () => {
    const access = {
      state: "authorized",
      breakGlass: false,
      principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
      grants: [{ role: "user", scope: "self", scope_value: "" }],
      namesVisible: true,
    };
    getAccess.mockResolvedValue(access);
    const pool = {};
    getPortalSqlPool.mockResolvedValue(pool);
    getUserUsage.mockResolvedValue({
      rows: [{
        userId: 42,
        login: "{login}",
        daysActive: 2,
        interactions: 7,
        aiCreditsUsed: "1999999999.999999998",
      }],
      totalItems: 1,
    });

    const response = await users(new NextRequest("http://localhost/api/users?period=last_7_days"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(resolveUsageRange).toHaveBeenCalledWith(pool, { ok: true, period: "last_7_days" });
    expect(getUserUsage).toHaveBeenCalledWith(
      pool,
      access,
      { from: "2026-02-24", to: "2026-03-02", page: 1, pageSize: 50 },
      expect.any(String),
    );
    expect(body.data[0].aiCreditsUsed).toBe("1999999999.999999998");
    expect(typeof body.data[0].aiCreditsUsed).toBe("string");
  });
});
