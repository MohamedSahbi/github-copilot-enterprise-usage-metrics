import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_COLUMNS } from "../../shared/src/rows";

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
  return parts.map((p) => p.trim()).filter((p) => p && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(p) && !/^\w+\s+AS\b/i.test(p)).map((p) => p.split(/\s+/)[0]!);
}

describe("shared row types match the migrations", () => {
  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    it(table, () => expect(columnsOf(table)).toEqual([...cols]));
  }
});
