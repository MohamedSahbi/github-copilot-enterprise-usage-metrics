import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
