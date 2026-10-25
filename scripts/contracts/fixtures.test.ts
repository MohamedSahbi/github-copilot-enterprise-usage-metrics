import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiCreditCsv, invalidUsersDayLines, usersDayNdjson } from "./synthetic";

const dir = join(__dirname, "..", "..", "fixtures", "synthetic");

describe("synthetic fixtures", () => {
  it("match the generator (run npx tsx scripts/contracts/generate-fixtures.ts to refresh)", () => {
    expect(readFileSync(join(dir, "users-1-day.ndjson"), "utf8")).toBe(usersDayNdjson());
    expect(readFileSync(join(dir, "users-1-day.invalid.ndjson"), "utf8")).toBe(invalidUsersDayLines().join("\n") + "\n");
    expect(readFileSync(join(dir, "ai-credit.csv"), "utf8")).toBe(aiCreditCsv());
  });

  it("contain only synthetic identifiers", () => {
    const text = readFileSync(join(dir, "users-1-day.ndjson"), "utf8") + readFileSync(join(dir, "ai-credit.csv"), "utf8");
    expect(text).not.toMatch(/@|https?:|secret/i);
    for (const m of text.matchAll(/"user_login":"([^"]+)"/g)) expect(m[1]).toMatch(/^example-user-\d{3}$/);
  });
});
