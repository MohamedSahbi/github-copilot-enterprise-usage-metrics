import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createDirectoryRuntimeHandler, readDirectoryRuntimeConfig, createDirectoryTransport } from "./runtime.js";
import type { DirectoryCommit } from "./sync.js";

const clientId = "00000000-0000-0000-0000-000000000001";
const env = {
  DIRECTORY_PROVIDER: "entra", ENTERPRISE_SLUG: "fixture-enterprise", ORGANIZATIONS: "fixture-org",
  DIRECTORY_DEPARTMENT_ATTRIBUTE: "department", DIRECTORY_BUSINESS_AREA_ATTRIBUTE: "",
  SQL_SERVER: "fixture.database.windows.net", SQL_DATABASE: "fixture-database", AZURE_CLIENT_ID: clientId,
  GITHUB_DIRECTORY_PAT: "fixture-secret",
};

describe("fail-closed directory runtime configuration", () => {
  it("reads the existing deployment bindings without a schedule default or new configuration source", () => {
    expect(readDirectoryRuntimeConfig(env)).toMatchObject({
      provider: "entra", enterprise: "fixture-enterprise", organizations: ["fixture-org"],
      sqlServer: "fixture.database.windows.net", sqlDatabase: "fixture-database", managedIdentityClientId: clientId,
      attributes: { departmentAttribute: "department", businessAreaAttribute: "" },
    });
    expect(Object.keys(readDirectoryRuntimeConfig(env))).not.toContain("schedule");
  });

  it("reads the Entra tenant for soft revocation, and leaves it off when unset", () => {
    expect(readDirectoryRuntimeConfig(env).entraTenantId).toBeNull();
    expect(readDirectoryRuntimeConfig({ ...env, ENTRA_TENANT_ID: clientId }).entraTenantId).toBe(clientId);
  });

  it.each(["DIRECTORY_PROVIDER", "ENTERPRISE_SLUG", "ORGANIZATIONS", "SQL_SERVER", "SQL_DATABASE", "AZURE_CLIENT_ID", "GITHUB_DIRECTORY_PAT"])(
    "rejects absent %s without exposing environment values", (key) => {
      expect(() => readDirectoryRuntimeConfig({ ...env, [key]: undefined })).toThrow("directory_configuration_invalid");
    },
  );

  it.each([
    { GITHUB_DIRECTORY_PAT: "@Microsoft.KeyVault(SecretUri=https://fixture.invalid/secrets/unresolved)" },
    { AZURE_CLIENT_ID: "not-an-immutable-guid" },
    { ORGANIZATIONS: "fixture-org,fixture-org" },
    { DIRECTORY_DEPARTMENT_ATTRIBUTE: "department;$select=mail" },
    { DIRECTORY_PROVIDER: "auto" },
    { ENTRA_TENANT_ID: "not-a-tenant-guid" },
  ])("rejects invalid configuration instead of falling back", (override) => {
    expect(() => readDirectoryRuntimeConfig({ ...env, ...override })).toThrow("directory_configuration_invalid");
  });
});

describe("injected directory HTTP transport", () => {
  it("bounds destinations and sends secrets only to the selected fixed origin, with redirects disabled", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"total_seats":0,"seats":[]}', { status: 200 }));
    const get = createDirectoryTransport("github", async () => "fixture-secret", fetcher);
    expect(await get("/orgs/fixture-org/copilot/billing/seats?per_page=100&page=1"))
      .toMatchObject({ status: 200, body: { total_seats: 0 } });
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      redirect: "error", method: "GET", headers: expect.objectContaining({ Authorization: "Bearer fixture-secret" }),
    }));
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/^https:\/\/api.github.com\//);
    await expect(get("//other.invalid/path")).rejects.toThrow("source_read_failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not infer authoritative no-manager from a Graph 404 or retain an error body", async () => {
    const get = createDirectoryTransport("graph", async () => "fixture-token",
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"message":"person@example.invalid"}}', { status: 404 })));
    expect(await get(`/v1.0/users/${clientId}/manager`)).toEqual({ status: 404, body: null });
  });

  it("classifies only the exact Graph manager not-found fixture without retaining its body", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/graph/manager-404-request-resource-not-found.json", import.meta.url), "utf8")) as {
      status: number;
      body: unknown;
    };
    const get = createDirectoryTransport("graph", async () => "fixture-token",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture.body), { status: fixture.status })));

    expect(await get(`/v1.0/users/${clientId}/manager?$select=id,mail,userPrincipalName`)).toEqual({
      status: 404, body: null, authoritativeNoManager: true,
    });
  });

  it("parses the successful manager fixture without marking it as manager absence", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/graph/manager-success.json", import.meta.url), "utf8")) as {
      status: number;
      body: unknown;
    };
    const get = createDirectoryTransport("graph", async () => "fixture-token",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture.body), { status: fixture.status })));

    expect(await get(`/v1.0/users/${clientId}/manager?$select=id,mail,userPrincipalName`)).toEqual({
      status: 200, body: fixture.body,
    });
  });

  it("keeps the negative 404 fixture incomplete", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/graph/manager-404-other-code.json", import.meta.url), "utf8")) as {
      status: number;
      body: unknown;
    };
    const get = createDirectoryTransport("graph", async () => "fixture-token",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture.body), { status: fixture.status })));

    expect(await get(`/v1.0/users/${clientId}/manager?$select=id,mail,userPrincipalName`)).toEqual({
      status: 404, body: null,
    });
  });

  it.each([
    ["different error code", 404, new Response('{"error":{"code":"Authorization_RequestDenied"}}', { status: 404 }), `/v1.0/users/${clientId}/manager`],
    ["missing error code", 404, new Response('{"error":{"message":"not found"}}', { status: 404 }), `/v1.0/users/${clientId}/manager`],
    ["malformed error body", 404, new Response("{", { status: 404 }), `/v1.0/users/${clientId}/manager`],
    ["non-manager endpoint", 404, new Response('{"error":{"code":"Request_ResourceNotFound"}}', { status: 404 }), `/v1.0/users/${clientId}`],
    ["forbidden response", 403, new Response('{"error":{"code":"Request_ResourceNotFound"}}', { status: 403 }), `/v1.0/users/${clientId}/manager`],
    ["throttled response", 429, new Response('{"error":{"code":"Request_ResourceNotFound"}}', { status: 429 }), `/v1.0/users/${clientId}/manager`],
    ["server error", 500, new Response('{"error":{"code":"Request_ResourceNotFound"}}', { status: 500 }), `/v1.0/users/${clientId}/manager`],
  ])("does not classify %s as authoritative no-manager", async (_name, status, response, path) => {
    const get = createDirectoryTransport("graph", async () => "fixture-token",
      vi.fn<typeof fetch>().mockResolvedValue(response));

    expect(await get(path)).toEqual({ status, body: null });
  });

  it.each(["network", "parse", "token"] as const)("sanitizes %s errors", async (failure) => {
    const fetcher = failure === "network"
      ? vi.fn<typeof fetch>().mockRejectedValue(new Error("person@example.invalid"))
      : vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid-private-json", { status: 200 }));
    const get = createDirectoryTransport("graph", async () => {
      if (failure === "token") throw new Error("secret-token");
      return "fixture-token";
    }, fetcher);
    await expect(get(`/v1.0/users/${clientId}`)).rejects.toThrow("source_read_failed");
  });
});

describe("production handler composition using injected side-effect boundaries", () => {
  it("wires real HTTP adapters and use case into the transactional writer seam without live calls", async () => {
    const commits: DirectoryCommit[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes("/scim/") ? { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{
        externalId: clientId, active: true, profileUrl: "https://github.com/fixture-user",
      }] } : url.includes("/seats?") ? { total_seats: 1, seats: [{ assignee: { id: 42, login: "fixture-user" } }] }
        : url.includes("/manager?") ? { id: "00000000-0000-0000-0000-000000000002", mail: "manager@example.invalid" }
          : { id: clientId, accountEnabled: true, mail: "profile@example.invalid", department: "engineering" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const handler = createDirectoryRuntimeHandler(env, {
      fetch: fetcher, graphToken: async () => "fixture-graph-token",
      writer: { commit: async (command) => { commits.push(command); } },
      now: () => new Date("2026-10-26T12:00:00Z"),
    });
    const context = { invocationId: "00000000-0000-0000-0000-000000000003", info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await handler({}, context);
    expect(commits[0]?.run.status).toBe("published");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get("X-Correlation-ID") === context.invocationId)).toBe(true);
    expect(commits[0]?.users[0]?.user.manager_email).toBe("manager@example.invalid");
    expect(JSON.stringify(context.info.mock.calls)).not.toContain("profile@example.invalid");
  });

  it("clears cached manager adjacency and advances source freshness for the exact no-manager fixture", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/graph/manager-404-request-resource-not-found.json", import.meta.url), "utf8")) as {
      status: number;
      body: unknown;
    };
    const commits: DirectoryCommit[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/scim/")) {
        return new Response(JSON.stringify({ totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{
          externalId: clientId, active: true, profileUrl: "https://github.com/fixture-user",
        }] }), { status: 200 });
      }
      if (url.includes("/seats?")) {
        return new Response(JSON.stringify({ total_seats: 1, seats: [{ assignee: { id: 42, login: "fixture-user" } }] }), { status: 200 });
      }
      if (url.includes("/manager?")) return new Response(JSON.stringify(fixture.body), { status: fixture.status });
      return new Response(JSON.stringify({ id: clientId, accountEnabled: true, mail: "profile@example.invalid" }), { status: 200 });
    });
    const handler = createDirectoryRuntimeHandler(env, {
      fetch: fetcher, graphToken: async () => "fixture-graph-token",
      writer: { commit: async (command) => { commits.push(command); } },
      now: () => new Date("2026-10-26T12:00:00Z"),
    });
    const context = { invocationId: "00000000-0000-0000-0000-000000000003", info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handler({}, context);

    expect(commits[0]?.run).toMatchObject({ status: "published", rows_loaded: 1, error_code: null });
    expect(commits[0]?.users[0]).toMatchObject({
      managerResolved: true, errorCode: null,
      user: { manager_entra_object_id: null, manager_email: null },
    });
    expect(commits[0]?.sync).toHaveLength(3);
    expect(commits[0]?.sync.every((state) => state.last_success_at === "2026-10-26T12:00:00.000Z" && state.last_error_code === null)).toBe(true);
    expect(context.error).not.toHaveBeenCalled();
  });

  it("fails closed for configured CSV without an explicit byte source rather than fetching Graph", () => {
    expect(() => createDirectoryRuntimeHandler({ ...env, DIRECTORY_PROVIDER: "csv" }))
      .toThrow("directory_csv_source_required");
  });
});
