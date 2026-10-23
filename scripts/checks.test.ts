import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const scripts = path.resolve(import.meta.dirname);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "checks-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function run(script: string, cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [path.join(scripts, script), ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("check-denylist.sh", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });

  const commitFile = (name: string, content: string) => {
    git(repo, "checkout", "-q", "-B", "topic", "main");
    writeFileSync(path.join(repo, name), content);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "change");
  };

  it("fails on a match without printing the term", () => {
    commitFile("notes.md", "we work with Zebracorp daily\n");
    const result = run("check-denylist.sh", repo, ["main", "topic"], { PRIVATE_TERMS_DENYLIST: "unrelated\nzebracorp\n" });
    expect(result.status).toBe(1);
    expect(result.output.toLowerCase()).not.toContain("zebracorp");
  });

  it("fails when the term is only in a file path, withholding the path", () => {
    commitFile("zebracorp-notes.md", "clean\n");
    const result = run("check-denylist.sh", repo, ["main", "topic"], { PRIVATE_TERMS_DENYLIST: "zebracorp" });
    expect(result.status).toBe(1);
    expect(result.output.toLowerCase()).not.toContain("zebracorp");
  });

  it("detects a match on the first line of a very large diff and history", () => {
    git(repo, "checkout", "-q", "-B", "topic", "main");
    writeFileSync(path.join(repo, "big.txt"), `zebracorp\n${"filler line\n".repeat(400_000)}`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", `zebracorp\n\n${"body line\n".repeat(50_000)}`);
    const result = run("check-denylist.sh", repo, ["main", "topic"], { PRIVATE_TERMS_DENYLIST: "zebracorp" });
    expect(result.status).toBe(1);
    expect(result.output.match(/::error/g)?.length).toBe(2);
  });

  it("fails closed when the list contains no usable terms", () => {
    commitFile("notes.md", "x\n");
    expect(run("check-denylist.sh", repo, ["main", "topic"], { PRIVATE_TERMS_DENYLIST: "  \n\n" }).status).toBe(1);
  });

  it("passes when no term appears", () => {
    commitFile("notes.md", "nothing sensitive\n");
    expect(run("check-denylist.sh", repo, ["main", "topic"], { PRIVATE_TERMS_DENYLIST: "zebracorp" }).status).toBe(0);
  });

  it("fails closed when the secret is missing unless explicitly allowed", () => {
    commitFile("notes.md", "x\n");
    expect(run("check-denylist.sh", repo, ["main", "topic"]).status).toBe(1);
    expect(run("check-denylist.sh", repo, ["main", "topic"], { DENYLIST_ALLOW_MISSING: "1" }).status).toBe(0);
  });
});

describe("check-upstream-boundary.sh", () => {
  it("allows moving the pinned commit but rejects regular files under the path", () => {
    const sub = makeRepo();
    const repo = makeRepo();
    mkdirSync(path.join(repo, "portal"), { recursive: true });
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "portal/upstream");
    git(repo, "commit", "-q", "-m", "add submodule");
    expect(run("check-upstream-boundary.sh", repo, ["HEAD~1", "HEAD"]).status).toBe(0);

    git(repo, "checkout", "-q", "-b", "bump");
    writeFileSync(path.join(sub, "new.txt"), "x\n");
    git(sub, "add", "-A");
    git(sub, "commit", "-q", "-m", "next");
    git(path.join(repo, "portal/upstream"), "-c", "protocol.file.allow=always", "pull", "-q", "origin", "HEAD");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "bump");
    expect(run("check-upstream-boundary.sh", repo, ["main", "bump"]).status).toBe(0);

    git(repo, "checkout", "-q", "-b", "vendored", "main");
    git(repo, "rm", "-q", "-f", "portal/upstream");
    mkdirSync(path.join(repo, "portal/upstream"), { recursive: true });
    writeFileSync(path.join(repo, "portal/upstream/file.ts"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "vendor");
    expect(run("check-upstream-boundary.sh", repo, ["main", "vendored"]).status).toBe(1);
  });
});
