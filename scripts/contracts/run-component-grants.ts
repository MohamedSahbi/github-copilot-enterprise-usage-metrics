import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const mode = process.argv[2] ?? "component";
if (!["restoration", "component", "runtime-permissions"].includes(mode)) throw new Error("invalid_component_grants_mode");
const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] !== 22 || (nodeVersion[1] ?? 0) < 12) throw new Error("component_grants_runner_requires_node22_12");
for (const key of [
  "DATABASE_URL", "DB_URL", "DB_HOST", "DB_SERVER", "DB_CONNECTION_STRING",
  "SQL_URL", "SQL_HOST", "SQL_SERVER", "SQL_DATABASE", "SQL_CONNECTION_STRING",
  "AZURE_SQL_CONNECTION_STRING", "MSSQL_CONNECTION_STRING", "SQLSERVER_CONNECTION_STRING",
]) {
  if (process.env[key]) throw new Error(`refusing_inherited_sql_target:${key}`);
}
const owner = randomBytes(8).toString("hex");
const directory = mkdtempSync(join(tmpdir(), "portal-component-grants-"));
const manifest = join(directory, "container.json");
const schema = z.object({
  owner: z.literal(owner),
  containerName: z.string().regex(/^portal-component-grants-[0-9]+-[a-f0-9]{16}$/),
  testPid: z.number().int().positive().optional(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
});

async function cleanup(): Promise<void> {
  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(JSON.parse(readFileSync(manifest, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  // An interruption between docker run and manifest capture is resolved only
  // through this invocation's exact name and owner label, never a name search.
  const inspected = spawnSync("docker", ["inspect", "--format",
    '{{.Id}} {{index .Config.Labels "portal.component-grants-owner"}} {{index .Config.Labels "portal.component-grants-pid"}}',
    data.containerId ?? data.containerName],
  { encoding: "utf8" });
  if (inspected.status === 0) {
    const [id, label, pid] = inspected.stdout.trim().split(" ");
    if (!id || !/^[a-f0-9]{64}$/.test(id) || label !== owner ||
        !data.testPid || pid !== String(data.testPid) ||
        (data.containerId !== undefined && data.containerId !== id)) {
      throw new Error("refusing_unowned_component_container_cleanup");
    }
    execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    const remaining = execFileSync("docker", ["ps", "-aq", "--no-trunc", "--filter", `id=${id}`], { encoding: "utf8" }).trim();
    if (remaining !== "") throw new Error("component_container_still_present");
  } else {
    const remaining = execFileSync("docker", ["ps", "-aq", "--filter", `name=^/${data.containerName}$`], { encoding: "utf8" }).trim();
    if (remaining !== "") throw new Error("component_container_inspection_failed");
  }
  if (data.port !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(data.port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
    });
  }
  console.info(`component_cleanup=verified owner=${owner} container=${data.containerId ?? "not-captured"} port=${data.port ?? "not-captured"}`);
}

let child: ChildProcess | undefined;
let interrupted = false;
let interruptTimer: ReturnType<typeof setTimeout> | undefined;
function interrupt(): void {
  interrupted = true;
  child?.kill("SIGTERM");
  interruptTimer ??= setTimeout(() => child?.kill("SIGKILL"), 10_000);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const deadline = setTimeout(interrupt, 12 * 60_000);
async function main(): Promise<void> {
  try {
    const selector = mode === "restoration"
      ? "upgrades populated restoration tables without fabrication and accepts nullable bounded storage"
      : mode === "runtime-permissions"
        ? "access model and runtime permissions"
        : "component runtime grants";
    child = spawn(process.execPath, [
      join("node_modules", "vitest", "vitest.mjs"), "run", "--project", "unit",
      "scripts/contracts/sql-container.test.ts", "-t", selector, "--maxWorkers", "1", "--pool", "threads",
    ], {
      stdio: "inherit",
      env: {
        ...process.env, RUN_SQL_TESTS: "1", COMPONENT_GRANTS_OWNER: owner,
        COMPONENT_GRANTS_MANIFEST: manifest,
      },
    });
    const test = child;
    const code = await new Promise<number>((resolve, reject) => {
      test.once("error", reject);
      test.once("exit", (result) => resolve(result ?? 1));
    });
    console.info(`component_runner_mode=${mode} node=${process.execPath} test_exec=${process.execPath} runner_pid=${process.pid} test_pid=${child.pid ?? "not-started"} test_exit=${code}`);
    process.exitCode = interrupted ? 130 : code;
  } finally {
    clearTimeout(deadline);
    if (interruptTimer) clearTimeout(interruptTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    try {
      await cleanup();
      rmSync(manifest, { force: true });
      rmdirSync(directory);
    } catch (error) {
      console.error("component_cleanup_failed", error instanceof Error ? error.message : "unknown_error");
      process.exitCode = 1;
    }
  }
}
void main().catch((error: unknown) => {
  console.error("component_runner_failed", error instanceof Error ? error.message : "unknown_error");
  process.exitCode = 1;
});
