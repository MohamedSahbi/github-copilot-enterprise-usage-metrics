import { describe, expect, it } from "vitest";
import { connectionFromEnvironment } from "./connection";
import { ensureRuntimeUsers, parseRuntimeIdentities, PREFLIGHT_SQL, preflightSql, type SqlExecutor } from "./runtime-users";

const identities = parseRuntimeIdentities(JSON.stringify({
  portal: { name: "id-cmp-test-portal", principal_id: "00000000-0000-0000-0000-000000000001", client_id: "x" },
  ingestion: { name: "id-cmp-test-ingestion", principal_id: "00000000-0000-0000-0000-000000000002" },
  directory: { name: "id-cmp-test-directory", principal_id: "00000000-0000-0000-0000-000000000003" },
}));

function fakeDb(members: Set<string>, failOn?: RegExp): SqlExecutor & { batches: string[] } {
  const batches: string[] = [];
  return {
    batches,
    async batch(text) {
      batches.push(text);
      if (failOn?.test(text)) throw new Error("Ingestion identity inherits a role outside its one component role");
      const check = /IS_ROLEMEMBER\(N'([^']+)', N'([^']+)'\) AS member/.exec(text);
      if (check) return [{ member: members.has(`${check[1]}:${check[2]}`) ? 1 : 0 }];
      const add = /ALTER ROLE (\S+) ADD MEMBER \[([^\]]+)\]/.exec(text);
      if (add) members.add(`${add[1]}:${add[2]}`);
      return [];
    },
  };
}

const kind = (text: string) =>
  text.includes("CREATE USER") ? "create" :
  text.includes("IS_ROLEMEMBER(N'portal") && text.includes("AS member") ? "check" :
  text.startsWith("ALTER ROLE") ? "add" :
  text.includes("@require_component_membership bit = 0") ? "preflight-0" :
  text.includes("@require_component_membership bit = 1") ? "preflight-1" : "other";

describe("parseRuntimeIdentities", () => {
  it("rejects a missing component, an unsafe name or a non-GUID principal ID", () => {
    expect(() => parseRuntimeIdentities("{}")).toThrow(/portal/);
    const bad = (name: string, principal_id: string) => JSON.stringify({
      portal: { name, principal_id }, ingestion: { name: "a", principal_id }, directory: { name: "b", principal_id },
    });
    expect(() => parseRuntimeIdentities(bad("x'; DROP USER y;--", "00000000-0000-0000-0000-000000000001"))).toThrow();
    expect(() => parseRuntimeIdentities(bad("id-portal", "not-a-guid"))).toThrow();
  });
});

describe("preflightSql", () => {
  it("fills every parameter and impersonates through the variable", () => {
    const text = preflightSql("id-cmp-test-directory", "portal_directory_ingest", true);
    expect(text).not.toMatch(/\{\{|<[a-z-]+-identity-name>/);
    expect(text).toContain("DECLARE @identity_name sysname = N'id-cmp-test-directory';");
    expect(text).toContain("DECLARE @require_component_membership bit = 1;");
    expect(text).toContain("EXECUTE AS USER = @identity_name;");
    expect(PREFLIGHT_SQL.trimEnd().endsWith("REVERT;")).toBe(true);
  });
});

describe("ensureRuntimeUsers", () => {
  it("creates users, preflights ingestion identities before and after mapping, and maps the portal without one", async () => {
    const db = fakeDb(new Set());
    const failed = await ensureRuntimeUsers(db, identities, () => undefined);
    expect(failed).toEqual([]);
    expect(db.batches.map(kind)).toEqual([
      "create", "check", "add", "check", "add",
      "create", "check", "preflight-0", "add", "preflight-1",
      "create", "check", "preflight-0", "add", "preflight-1",
    ]);
    expect(db.batches.filter((b) => b.startsWith("ALTER ROLE"))).toEqual([
      "ALTER ROLE portal_reader ADD MEMBER [id-cmp-test-portal];",
      "ALTER ROLE portal_writer ADD MEMBER [id-cmp-test-portal];",
      "ALTER ROLE portal_metrics_ingest ADD MEMBER [id-cmp-test-ingestion];",
      "ALTER ROLE portal_directory_ingest ADD MEMBER [id-cmp-test-directory];",
    ]);
    expect(db.batches[0]).toContain("CAST('00000000-0000-0000-0000-000000000001' AS uniqueidentifier)");
    expect(db.batches[0]).toContain("TYPE = E");
  });

  it("re-runs without adding anything and only re-checks mapped ingestion identities", async () => {
    const db = fakeDb(new Set([
      "portal_reader:id-cmp-test-portal", "portal_writer:id-cmp-test-portal",
      "portal_metrics_ingest:id-cmp-test-ingestion", "portal_directory_ingest:id-cmp-test-directory",
    ]));
    expect(await ensureRuntimeUsers(db, identities, () => undefined)).toEqual([]);
    expect(db.batches.map(kind)).not.toContain("add");
    expect(db.batches.map(kind)).not.toContain("preflight-0");
  });

  it("stops an identity whose preflight throws, without mapping it, and still maps the others", async () => {
    const db = fakeDb(new Set(), /N'id-cmp-test-ingestion';\nDECLARE @component_role/);
    const log: string[] = [];
    expect(await ensureRuntimeUsers(db, identities, (m) => log.push(m))).toEqual(["ingestion"]);
    expect(db.batches).not.toContain("ALTER ROLE portal_metrics_ingest ADD MEMBER [id-cmp-test-ingestion];");
    expect(db.batches).toContain("ALTER ROLE portal_directory_ingest ADD MEMBER [id-cmp-test-directory];");
    expect(log.some((m) => m.startsWith("id-cmp-test-ingestion: stopped:"))).toBe(true);
  });
});

describe("connectionFromEnvironment", () => {
  it("uses an Entra access token when no connection string is set", () => {
    const config = connectionFromEnvironment({ SQL_SERVER: "sql.example", SQL_DATABASE: "portal", SQL_ACCESS_TOKEN: "t" });
    expect(config).toMatchObject({
      server: "sql.example", database: "portal",
      authentication: { type: "azure-active-directory-access-token", options: { token: "t" } },
      options: { encrypt: true, trustServerCertificate: false },
    });
  });

  it("refuses incomplete settings", () => {
    expect(() => connectionFromEnvironment({ SQL_SERVER: "sql.example", SQL_DATABASE: "portal" })).toThrow(/SQL_ACCESS_TOKEN/);
  });
});
