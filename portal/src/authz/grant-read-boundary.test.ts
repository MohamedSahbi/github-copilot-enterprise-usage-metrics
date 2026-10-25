import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")
      ? [join(dir, entry.name)] : []);
}

const directGrantRead = /\b(?:from|join|apply)\s+(?:portal\s*\.\s*)?AccessGrant\b/i;
it("portal grant reads use only portal.v_active_grant, never the base AccessGrant table", () => {
  expect(directGrantRead.test("SELECT * FROM [portal].[AccessGrant]".replace(/[[\]"]/g, ""))).toBe(true);
  const violations = sources("portal/src").filter((file) =>
    directGrantRead.test(readFileSync(file, "utf8").replace(/[[\]"]/g, "")));
  expect(violations).toEqual([]);
});
