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

const authorized = (namesVisible = false) => ({
  state: "authorized",
  breakGlass: false,
  principal: { principal_id: "p", entra_tenant_id: "t", entra_object_id: "o", github_user_id: null, status: "active" },
  grants: [{ role: "admin", scope: "company", scope_value: "" }],
  namesVisible,
});

describe("usage API route restrictions", () => {
  beforeEach(() => vi.clearAllMocks());

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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getPortalSqlPool).not.toHaveBeenCalled();
  });

  it.each([
    ["signed-out", 401],
    ["no-access", 403],
    ["unavailable", 503],
  ] as const)("preserves %s authorization responses before route denial", async (state, status) => {
    getAccess.mockResolvedValue({ state, breakGlass: false });
    const handlers = [
      [overview, "/api/usage/overview?from=invalid"],
      [breakdown, "/api/usage/breakdown?kind=invalid"],
      [users, "/api/users?pageSize=invalid"],
    ] as const;

    for (const [handler, url] of handlers) {
      const response = await handler(new NextRequest(`http://localhost${url}`));
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(getPortalSqlPool).not.toHaveBeenCalled();
    expect(resolveUsageRange).not.toHaveBeenCalled();
    expect(getUsageOverview).not.toHaveBeenCalled();
    expect(getUsageBreakdown).not.toHaveBeenCalled();
    expect(getUserUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["overview default", overview, "/api/usage/overview", false],
    ["overview arbitrary dates", overview, "/api/usage/overview?from=invalid&to=invalid", false],
    ["overview duplicate params", overview, "/api/usage/overview?period=last_7_days&period=calendar_month&month=bad", false],
    ["overview scope and organization variants", overview, "/api/usage/overview?scope=department%3Aunknown&org=unknown&organizationIds=1%2C2", false],
    ["breakdown default", breakdown, "/api/usage/breakdown", false],
    ["breakdown invalid kind and page", breakdown, "/api/usage/breakdown?period=bad&kind=feature&page=0", false],
    ["breakdown empty kind and repeated periods", breakdown, "/api/usage/breakdown?kind=&period=day&period=month&scope=team%3Ateam-1", false],
    ["breakdown organization and page-size variants", breakdown, "/api/usage/breakdown?organizationIds=1,2&kind=ide&pageSize=999", false],
    ["users with details disabled", users, "/api/users", false],
    ["users scope and organization variants", users, "/api/users?scope=self%3Aself&org=unknown&organizationIds=1%2C2", false],
    ["users with details enabled", users, "/api/users?from=bad&to=bad&page=0", true],
  ])("returns the same no-store 404 for authorized %s requests before querying usage", async (_name, handler, url, namesVisible) => {
    getAccess.mockResolvedValue(authorized(namesVisible));

    const response = await handler(new NextRequest(`http://localhost${url}`));
    const body = await response.json() as { error: { code: string; message: string; correlationId: string } };

    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({
      code: "not_found",
      message: "The requested resource is not available.",
    });
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get("X-Correlation-ID")).toBe(body.error.correlationId);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getPortalSqlPool).not.toHaveBeenCalled();
    expect(getUsageOverview).not.toHaveBeenCalled();
    expect(getUsageBreakdown).not.toHaveBeenCalled();
    expect(getUserUsage).not.toHaveBeenCalled();
    expect(resolveUsageRange).not.toHaveBeenCalled();
  });
});
