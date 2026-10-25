import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "sql-changed.sh");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function changed(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sql-changed-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "x\n");
    git(dir, "add", f);
  }
  git(dir, "commit", "-q", "--allow-empty", "-m", "change");
  const result = spawnSync("bash", [script, base, "HEAD"], { cwd: dir, encoding: "utf8" });
  return result.stdout.trim();
}

describe("sql-changed.sh", () => {
  it.each(["db/migrations/20300101000000.do.x.sql", "scripts/db/migrate.ts", "scripts/db/compose.local.yml"])("is true for %s", (file) => {
    expect(changed([file])).toBe("true");
  });

  it("is false for unrelated files", () => {
    expect(changed(["docs/readme.md", "scripts/ci.sh"])).toBe("false");
  });
});
