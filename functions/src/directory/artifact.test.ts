import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const functionsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "functions");

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else files.push(name);
  }
  return files.sort();
}

async function buildAndInspect(outputDirectory: string): Promise<[string, string][]> {
  execFileSync(process.execPath, ["build-directory-artifact.mjs", outputDirectory], {
    cwd: functionsRoot,
    stdio: "ignore",
  });
  expect(await listFiles(outputDirectory)).toEqual(["dist/function.js", "host.json", "package.json"]);

  const manifest = JSON.parse(await readFile(path.join(outputDirectory, "package.json"), "utf8")) as {
    main: string;
    dependencies: Record<string, string>;
  };
  const workspaceManifest = JSON.parse(await readFile(path.join(functionsRoot, "package.json"), "utf8")) as {
    main: string;
  };
  const host = JSON.parse(await readFile(path.join(outputDirectory, "host.json"), "utf8")) as { version: string };
  const entrypointPath = path.join(outputDirectory, manifest.main);
  const entrypoint = await readFile(entrypointPath, "utf8");
  expect(manifest.main).toBe("dist/function.js");
  expect(path.posix.join("dist/artifact", manifest.main)).toBe(workspaceManifest.main);
  expect(host.version).toBe("2.0");
  expect(Object.keys(manifest.dependencies).sort()).toEqual([
    "@azure/functions", "@azure/identity", "mssql", "zod",
  ].sort());
  expect(entrypoint).toContain("directorySync");
  expect(entrypoint).toContain("%DIRECTORY_SYNC_SCHEDULE%");
  expect(entrypoint).not.toMatch(/day-loader|day-parser|metrics\/|@azure\/storage-blob/);

  return Promise.all((await listFiles(outputDirectory)).map(async (file) => [
    file,
    createHash("sha256").update(await readFile(path.join(outputDirectory, file))).digest("hex"),
  ]));
}

describe("directory Functions artifact", () => {
  it("contains only the registered directory host and emits byte-for-byte reproducible output", async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), "directory-artifact-a-"));
    const second = await mkdtemp(path.join(os.tmpdir(), "directory-artifact-b-"));
    try {
      expect(await buildAndInspect(first)).toEqual(await buildAndInspect(second));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("rejects a custom output path that is a symlink", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "directory-artifact-link-parent-"));
    const target = await mkdtemp(path.join(os.tmpdir(), "directory-artifact-link-target-"));
    const output = path.join(parent, "directory-artifact-symlink");
    try {
      await symlink(target, output, "dir");
      expect(() => execFileSync(process.execPath, ["build-directory-artifact.mjs", output], {
        cwd: functionsRoot,
        stdio: "ignore",
      })).toThrow();
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});
