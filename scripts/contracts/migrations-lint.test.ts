import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES, ROLE_SCOPES } from "../../shared/src/access";
import { AUDIT_ACTIONS } from "../../shared/src/audit";
import { ISSUE_ACTIONS, ISSUE_TYPES } from "../../shared/src/issues";

const dir = join(__dirname, "..", "..", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
const NAME = /^(\d{14})\.do\.([a-z0-9-]+)\.sql$/;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

describe("migrations lint (D-34, §6.5)", () => {
  it("has at least one migration", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("uses yyyyMMddHHmmss.do.description.sql names with valid UTC timestamps", () => {
    for (const f of files) {
      const m = NAME.exec(f);
      expect(m, `bad name: ${f}`).not.toBeNull();
      const t = m![1]!;
      const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
      expect(Number.isNaN(Date.parse(iso)), `invalid timestamp: ${f}`).toBe(false);
    }
  });

  it("has unique, sorted versions", () => {
    const versions = files.map((f) => NAME.exec(f)?.[1] ?? f);
    expect(new Set(versions).size).toBe(versions.length);
    expect(files).toEqual([...files].sort());
  });

  it("never references dbo (D-34)", () => {
    for (const f of files) {
      const sql = stripComments(readFileSync(join(dir, f), "utf8"));
      expect(/\bdbo\s*\./i.test(sql), `${f} references dbo`).toBe(false);
      expect(/\b(db_owner|sysadmin|db_ddladmin)\b/i.test(sql), `${f} grants a privileged role`).toBe(false);
    }
  });

  it("creates and alters only portal objects", () => {
    const stmt = /\b(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+|CLUSTERED\s+|NONCLUSTERED\s+)*(TABLE|VIEW|PROCEDURE|FUNCTION)\s+(?:IF\s+EXISTS\s+)?([\w[\].]+)/gi;
    for (const f of files) {
      const sql = stripComments(readFileSync(join(dir, f), "utf8"));
      for (const m of sql.matchAll(stmt)) {
        expect(/^\[?portal\]?\./i.test(m[2]!), `${f}: ${m[1]} ${m[2]} is not in schema portal`).toBe(true);
      }
    }
  });

  it("names the single writer of every created table in a header comment", () => {
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf8");
      const header = raw.split(/\r?\n/).filter((l) => l.startsWith("--")).join("\n");
      const tables = [...stripComments(raw).matchAll(/\bCREATE\s+TABLE\s+(portal\.\w+)/gi)].map((m) => m[1]!);
      for (const t of tables) {
        const re = new RegExp(`^--\\s+${t.replace(".", "\\.")}\\s*:\\s*\\S+`, "im");
        expect(re.test(header), `${f}: no writer header for ${t}`).toBe(true);
        const count = [...header.matchAll(new RegExp(`^--\\s+${t.replace(".", "\\.")}\\s*:`, "gim"))].length;
        expect(count, `${f}: ${t} has more than one writer line`).toBe(1);
      }
    }
  });

  it("is idempotent: every CREATE TABLE is guarded", () => {
    for (const f of files) {
      const sql = stripComments(readFileSync(join(dir, f), "utf8"));
      const creates = [...sql.matchAll(/\bCREATE\s+TABLE\s+(portal\.\w+)/gi)];
      for (const m of creates) {
        const guard = new RegExp(`IF\\s+OBJECT_ID\\(N'${m[1]!.replace(".", "\\.")}'[^)]*\\)\\s+IS\\s+NULL`, "i");
        expect(guard.test(sql), `${f}: ${m[1]} is not guarded by IF OBJECT_ID ... IS NULL`).toBe(true);
      }
    }
  });
});

describe("access-model migrations agree with the shared contracts (issue #44)", () => {
  const all = files.map((f) => stripComments(readFileSync(join(dir, f), "utf8"))).join("\n");
  const quoted = (list: string): string[] => [...list.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!).sort();

  it("CK_AccessGrant_role_scope allows exactly the role/scope pairs of ROLE_SCOPES", () => {
    const body = /CK_AccessGrant_role_scope CHECK \(([\s\S]*?)\);\s*GO/i.exec(all)?.[1] ?? "";
    const pairs = [...body.matchAll(/role = '(\w+)' AND scope (?:= '(\w+)'|IN \(([^)]*)\))/g)]
      .flatMap((m) => (m[2] ? [`${m[1]}:${m[2]}`] : quoted(m[3]!).map((s) => `${m[1]}:${s}`)))
      .sort();
    const expected = ROLES.flatMap((r) => ROLE_SCOPES[r].map((s) => `${r}:${s}`)).sort();
    expect(pairs).toEqual(expected);
  });

  it("IngestionAuditEvent allows exactly the ingestion-written audit actions", () => {
    const list = /CK_IngestionAuditEvent_action CHECK \(action IN \(([^)]*)\)/i.exec(all)?.[1] ?? "";
    const expected = Object.entries(AUDIT_ACTIONS).filter(([, w]) => w === "ingestion").map(([a]) => a).sort();
    expect(quoted(list)).toEqual(expected);
  });

  it("IssueAction allows exactly the fixed action set of every issue type", () => {
    const list = /CK_IssueAction_action CHECK \(action IN \(([^)]*)\)/i.exec(all)?.[1] ?? "";
    expect(quoted(list)).toEqual([...new Set(Object.values(ISSUE_ACTIONS).flat())].sort());
  });

  it("ValidationIssue types and the quarantined run status match the shared types", () => {
    const types = /CK_ValidationIssue_type CHECK \(issue_type IS NULL OR issue_type IN \(([^)]*)\)/i.exec(all)?.[1] ?? "";
    expect(quoted(types)).toEqual([...ISSUE_TYPES].sort());
    expect(/CK_IngestionRun_status[\s\S]*?'quarantined'/i.test(all)).toBe(true);
  });

  it("makes grants impossible for a GitHub-only principal", () => {
    expect(/principal_entra_oid UNIQUEIDENTIFIER NOT NULL/i.test(all)).toBe(true);
    expect(/FOREIGN KEY \(principal_id, principal_entra_oid\) REFERENCES portal\.Principal \(principal_id, entra_object_id\)/i.test(all)).toBe(true);
  });

  it("keeps D-34: ingestion never writes portal-owned access tables and the new audit tables are append-only", () => {
    expect(/GRANT[^;]*\bON portal\.(Principal|PrincipalIdentity|AccessGrant|AuditLog|IssueAction)\b[^;]*TO portal_ingest/i.test(all.replace(/GRANT SELECT[^;]*;/gi, ""))).toBe(false);
    for (const t of ["GrantRevocation", "IssueAction", "IngestionAuditEvent"]) {
      expect(new RegExp(`DENY UPDATE, DELETE ON portal\\.${t}\\b`, "i").test(all), `${t} must be append-only`).toBe(true);
    }
  });

  it("unique indexes on the active Entra and GitHub link exist both ways", () => {
    expect(/UX_PrincipalLinkState_entra[\s\S]*?WHERE unlinked_at IS NULL/i.test(all)).toBe(true);
    expect(/UX_PrincipalLinkState_github[\s\S]*?WHERE unlinked_at IS NULL/i.test(all)).toBe(true);
  });
});
