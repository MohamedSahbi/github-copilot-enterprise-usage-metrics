import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const functionsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "functions");

async function buildAndInspect(output: string): Promise<string[]> {
  execFileSync(process.execPath, ["build-artifact.mjs", "metrics", output], { cwd: functionsRoot, stdio: "pipe" });
  expect((await readdir(output)).sort()).toEqual(["dist", "host.json", "package.json"]);
  expect(await readdir(path.join(output, "dist"))).toEqual(["function.js"]);
  const manifest = JSON.parse(await readFile(path.join(output, "package.json"), "utf8")) as {
    name: string; main: string; dependencies: Record<string, string>;
  };
  expect(manifest.name).toBe("@cmp/functions-metrics");
  expect(manifest.main).toBe("dist/function.js");
  expect(Object.keys(manifest.dependencies).sort()).toEqual([
    "@azure/functions", "@azure/identity", "@azure/storage-blob", "mssql", "zod",
  ]);
  const content = await readFile(path.join(output, manifest.main), "utf8");
  expect(content).toContain("metricsSync");
  expect(content).toContain("%METRICS_SYNC_SCHEDULE%");
  expect(content).toContain("metrics_day_started");
  expect(content).toContain("users-1-day?day=");
  expect(content).not.toMatch(/directorySync|GITHUB_DIRECTORY_PAT|graph\.microsoft\.com|SCIM/);
  return Promise.all(["dist/function.js", "host.json", "package.json"].map(async (file) =>
    createHash("sha256").update(await readFile(path.join(output, file))).digest("hex")));
}

describe("isolated metrics Functions artifact", () => {
  it("emits the real registered acquisition and loader component reproducibly without directory secrets or handlers", async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), "metrics-artifact-a-"));
    const second = await mkdtemp(path.join(os.tmpdir(), "metrics-artifact-b-"));
    try {
      expect(await buildAndInspect(first)).toEqual(await buildAndInspect(second));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
});
