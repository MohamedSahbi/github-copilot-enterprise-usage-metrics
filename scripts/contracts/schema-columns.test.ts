import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { TABLE_COLUMNS, type DimUserRow, type IsoDateTime } from "../../shared/src/rows";

const dir = join(__dirname, "..", "..", "db", "migrations");
const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
  .replace(/--.*$/gm, "");

function columnsOf(table: string): string[] {
  const start = sql.search(new RegExp(`CREATE TABLE ${table.replace(".", "\\.")}\\s*\\(`, "i"));
  if (start < 0) throw new Error(`no CREATE TABLE ${table}`);
  let depth = 0;
  let i = sql.indexOf("(", start);
  const from = i;
  for (; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    if (sql[i] === ")" && --depth === 0) break;
  }
  const body = sql.slice(from + 1, i);
  const parts: string[] = [];
  let d = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") d++;
    if (ch === ")") d--;
    if (ch === "," && d === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const created = parts.map((p) => p.trim()).filter((p) => p && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(p) && !/^\w+\s+AS\b/i.test(p)).map((p) => p.split(/\s+/)[0]!);
  const added = [...sql.matchAll(new RegExp(`ALTER TABLE ${table.replace(".", "\\.")}\\s+ADD\\s+(?!CONSTRAINT\\b)(\\w+)`, "gi"))].map((m) => m[1]!);
  return [...created, ...added];
}

describe("shared row types match the migrations", () => {
  it("requires per-user manager resolution evidence", () => {
    expect(TABLE_COLUMNS["portal.dim_user"].slice(-2)).toEqual(["manager_resolved", "manager_checked_at"]);
    expectTypeOf<DimUserRow["manager_resolved"]>().toEqualTypeOf<boolean>();
    expectTypeOf<DimUserRow["manager_checked_at"]>().toEqualTypeOf<IsoDateTime | null>();
    expectTypeOf<Pick<DimUserRow, "manager_resolved" | "manager_checked_at">>()
      .toEqualTypeOf<{ manager_resolved: boolean; manager_checked_at: IsoDateTime | null }>();
  });

  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    it(table, () => expect(columnsOf(table)).toEqual([...cols]));
  }
});
