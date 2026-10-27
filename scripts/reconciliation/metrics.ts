import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertPublicSummary, parseEvidenceManifest } from "../../shared/src/reconciliation.js";
import { createManifest, reconcileMetricsRange } from "../../functions/src/reconciliation/report.js";
import { createMetricsReconciliationReader } from "../../functions/src/reconciliation/reader.js";
import { createMetricsBlobContainerClient, createMetricsSqlConfig } from "../../functions/src/metrics/day-loader.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const text = z.string().trim().min(1);
const absolutePath = text.refine(isAbsolute);
const privateOutputSchema = z.strictObject({ directory: absolutePath, approvalRef: text.max(200) });
const common = {
  organizationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  privateOutput: privateOutputSchema,
};
const configSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...common, mode: z.literal("manifest"), localRawFile: absolutePath, reportDay: text,
    provenance: z.strictObject({ sourceLabel: text.max(100), retrievedAt: z.iso.datetime(), approvalRef: text.max(200), toolVersion: text.max(64) }),
    includePerUser: z.boolean().default(false),
  }),
  z.strictObject({
    ...common, mode: z.literal("report"), from: text, to: text,
    manifestFiles: z.array(z.strictObject({ reportDay: text, path: absolutePath })), publicSummaryFile: absolutePath,
    sql: z.strictObject({
      server: z.string().regex(/^[a-z0-9-]+\.database\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/),
      database: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), managedIdentityClientId: z.uuid(),
    }),
    archive: z.strictObject({
      accountUrl: z.string().regex(/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)\/?$/),
      container: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    }),
  }),
]);
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
export async function guardPrivateOutput(value: unknown): Promise<string> {
  try {
    const { directory } = privateOutputSchema.parse(value);
    const canonical = await realpath(directory);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 || within(repositoryRoot, canonical)) throw new Error("invalid target");
    return canonical;
  } catch {
    throw new Error("reconciliation_private_output_invalid");
  }
}
export async function writePrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  if (!/^[A-Za-z0-9-]+\.json$/.test(name)) throw new Error("reconciliation_private_write_failed");
  try {
    await writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch {
    throw new Error("reconciliation_private_write_failed");
  }
}
export async function writePublicSummary(
  path: string, value: unknown,
  write: typeof writeFile = writeFile,
): Promise<void> {
  const summary = assertPublicSummary(value);
  try {
    await write(path, JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("reconciliation_public_write_failed");
  }
}
async function localFile(path: string): Promise<Buffer> {
  try {
    if (!isAbsolute(path)) throw new Error("invalid input");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("invalid input");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("reconciliation_local_input_failed");
  }
}
export async function runMetricsReconciliationCommand(value: unknown): Promise<void> {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error("reconciliation_config_invalid");
  const config = parsed.data;
  const directory = await guardPrivateOutput(config.privateOutput);
  const correlationId = randomUUID();
  const logger = {
    info: (event: Readonly<Record<string, string | number>>) => console.info(JSON.stringify(event)),
    error: (event: Readonly<Record<string, string | number>>) => console.error(JSON.stringify(event)),
  };
  if (config.mode === "manifest") {
    const manifest = createManifest(await localFile(config.localRawFile), config);
    await writePrivateJson(directory, `manifest-${correlationId}.json`, manifest);
    logger.info({ event: "reconciliation_manifest_created", correlationId, days: 1 });
    if (manifest.availability !== "available") throw new Error("reconciliation_manifest_incomplete");
    return;
  }
  const publicParent = await realpath(dirname(config.publicSummaryFile));
  const publicPath = resolve(publicParent, config.publicSummaryFile.slice(config.publicSummaryFile.lastIndexOf(sep) + 1));
  if (within(directory, publicPath) || config.manifestFiles.some((file) => resolve(file.path) === publicPath)) {
    throw new Error("reconciliation_public_output_invalid");
  }
  const manifests: unknown[] = [];
  for (const { path, reportDay } of config.manifestFiles) {
    let value: unknown;
    try {
      value = JSON.parse((await localFile(path)).toString("utf8"));
    } catch {
      logger.error({ event: "reconciliation_manifest_input_failed", correlationId });
      value = { reportDay };
    }
    // Keep invalid-but-day-addressable manifests for an explicit incomplete day result.
    const parsedManifest = parseEvidenceManifest(value);
    if (!parsedManifest.ok || parsedManifest.manifest.reportDay !== reportDay) {
      logger.error({ event: "reconciliation_manifest_invalid", correlationId });
      manifests.push({ reportDay });
    } else {
      manifests.push(parsedManifest.manifest);
    }
  }
  const read = createMetricsReconciliationReader(
    createMetricsSqlConfig(config.sql.server, config.sql.database, config.sql.managedIdentityClientId),
    createMetricsBlobContainerClient(config.archive.accountUrl, config.archive.container, config.sql.managedIdentityClientId),
  );
  const result = await reconcileMetricsRange({ ...config, correlationId, manifests }, { read, logger });
  await writePrivateJson(directory, `detail-${correlationId}.json`, {
    privateOutputApproval: { approvalRef: config.privateOutput.approvalRef, verification: "operator_declaration_only" },
    days: result.details,
  });
  await writePublicSummary(config.publicSummaryFile, result.summary);
  if (result.summary.status !== "matched" && result.summary.status !== "explained") throw new Error("reconciliation_not_matched");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") throw new Error("invalid command");
    const config: unknown = JSON.parse((await localFile(process.argv[3]!)).toString("utf8"));
    await runMetricsReconciliationCommand(config);
  } catch {
    console.error(JSON.stringify({ event: "reconciliation_failed" }));
    process.exitCode = 1;
  }
}
