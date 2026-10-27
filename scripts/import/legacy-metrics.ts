import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import {
  createMetricsBlobContainerClient,
  createMetricsSqlConfig,
  loadMetricsDay,
  type MetricsDayLoadInput,
  type MetricsDayLoadResult,
} from "../../functions/src/metrics/day-loader.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CONTAINER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const LEGACY_BLOB_PATTERN = /^(\d{4})\/(\d{2})\/raw\/UsageMetrics-(\d{2})-(\d{2})-(\d{4})\.json$/;
const STORAGE_ACCOUNT_HOST_PATTERN = /^[a-z0-9]{3,24}\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/;
const SQL_SERVER_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.database\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/;

export interface LegacyMetricsImportOptions {
  sourceAccountUrl: string;
  sourceContainer: string;
  archiveAccountUrl: string;
  archiveContainer: string;
  sqlServer: string;
  sqlDatabase: string;
  managedIdentityClientId: string;
  organizationId: number;
  organizationLogin: string;
  fromDay: string;
  toDay: string;
  execute: boolean;
}

export interface LegacyMetricsCandidate {
  blobName: string;
  reportDay: string;
}

export interface LegacyMetricsImportOutcome {
  reportDay: string;
  action: "skipped" | "would-import" | "published";
  sha256: string;
  result?: MetricsDayLoadResult;
}

export interface LegacyMetricsImportDependencies {
  listBlobNames(prefix: string): AsyncIterable<string>;
  downloadBlob(blobName: string): Promise<Uint8Array>;
  currentPublishedDigest(reportDay: string): Promise<string | undefined>;
  loadDay(input: MetricsDayLoadInput): Promise<MetricsDayLoadResult>;
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateHttpsAccountUrl(value: string, label: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new TypeError(`${label} must be a valid HTTPS account URL`, { cause: error });
  }
  if (endpoint.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  if (!STORAGE_ACCOUNT_HOST_PATTERN.test(endpoint.hostname) || endpoint.port ||
    endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
    endpoint.username || endpoint.password) {
    throw new TypeError(`${label} must be an Azure Blob account origin without credentials, port, path, query, or fragment`);
  }
}

function validateOptions(options: LegacyMetricsImportOptions): void {
  validateHttpsAccountUrl(options.sourceAccountUrl, "source account URL");
  validateHttpsAccountUrl(options.archiveAccountUrl, "archive account URL");
  if (new URL(options.sourceAccountUrl).origin.toLowerCase() === new URL(options.archiveAccountUrl).origin.toLowerCase() &&
    options.sourceContainer === options.archiveContainer) {
    throw new TypeError("source and archive containers must be different");
  }
  if (!CONTAINER_PATTERN.test(options.sourceContainer)) throw new TypeError("source container is invalid");
  if (!CONTAINER_PATTERN.test(options.archiveContainer)) throw new TypeError("archive container is invalid");
  if (!SQL_SERVER_HOST_PATTERN.test(options.sqlServer)) {
    throw new TypeError("SQL server must be an Azure SQL server DNS name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.sqlDatabase)) throw new TypeError("SQL database is invalid");
  if (!UUID_PATTERN.test(options.managedIdentityClientId)) throw new TypeError("managed identity client ID must be a UUID");
  if (!Number.isSafeInteger(options.organizationId) || options.organizationId <= 0) {
    throw new TypeError("organization ID must be a positive safe integer");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,254}$/.test(options.organizationLogin)) {
    throw new TypeError("organization login is invalid");
  }
  if (!isCalendarDate(options.fromDay) || !isCalendarDate(options.toDay)) {
    throw new TypeError("date bounds must be real ISO calendar dates");
  }
  if (options.fromDay > options.toDay) throw new TypeError("from date must not be after to date");
}

export function legacyRawBlobReportDay(blobName: string): string | undefined {
  if (!blobName.includes("/raw/")) return undefined;
  const match = LEGACY_BLOB_PATTERN.exec(blobName);
  if (!match) throw new Error(`Unsupported raw metrics blob name: ${blobName}`);
  const [, pathYear, pathMonth, day, month, year] = match;
  if (pathYear !== year || pathMonth !== month) {
    throw new Error(`Raw metrics blob path and filename disagree: ${blobName}`);
  }
  const reportDay = `${year}-${month}-${day}`;
  if (!isCalendarDate(reportDay)) throw new Error(`Raw metrics blob has an invalid report date: ${blobName}`);
  return reportDay;
}

function monthPrefixes(fromDay: string, toDay: string): string[] {
  const month = new Date(`${fromDay.slice(0, 7)}-01T00:00:00.000Z`);
  const end = new Date(`${toDay.slice(0, 7)}-01T00:00:00.000Z`);
  const prefixes: string[] = [];
  while (month <= end) {
    prefixes.push(`${String(month.getUTCFullYear()).padStart(4, "0")}/${String(month.getUTCMonth() + 1).padStart(2, "0")}/raw/`);
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
  return prefixes;
}

export async function discoverLegacyMetricsCandidates(
  fromDay: string,
  toDay: string,
  listBlobNames: LegacyMetricsImportDependencies["listBlobNames"],
): Promise<LegacyMetricsCandidate[]> {
  if (!isCalendarDate(fromDay) || !isCalendarDate(toDay) || fromDay > toDay) {
    throw new TypeError("a valid inclusive date range is required");
  }
  const byDay = new Map<string, string>();
  const seenNames = new Set<string>();
  for (const prefix of monthPrefixes(fromDay, toDay)) {
    for await (const blobName of listBlobNames(prefix)) {
      if (seenNames.has(blobName)) continue;
      seenNames.add(blobName);
      const reportDay = legacyRawBlobReportDay(blobName);
      if (reportDay === undefined || reportDay < fromDay || reportDay > toDay) continue;
      const existing = byDay.get(reportDay);
      if (existing !== undefined) {
        throw new Error(`Multiple raw metrics blobs found for ${reportDay}: ${existing} and ${blobName}`);
      }
      byDay.set(reportDay, blobName);
    }
  }
  return [...byDay].map(([reportDay, blobName]) => ({ reportDay, blobName }))
    .sort((left, right) => left.reportDay.localeCompare(right.reportDay));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function importLegacyMetricsRange(
  options: LegacyMetricsImportOptions,
  dependencies: LegacyMetricsImportDependencies,
): Promise<LegacyMetricsImportOutcome[]> {
  validateOptions(options);
  const candidates = await discoverLegacyMetricsCandidates(
    options.fromDay,
    options.toDay,
    dependencies.listBlobNames,
  );
  const outcomes: LegacyMetricsImportOutcome[] = [];
  for (const candidate of candidates) {
    const bytes = await dependencies.downloadBlob(candidate.blobName);
    const digest = sha256(bytes);
    const currentDigest = await dependencies.currentPublishedDigest(candidate.reportDay);
    if (currentDigest?.toLowerCase() === digest) {
      outcomes.push({ reportDay: candidate.reportDay, action: "skipped", sha256: digest });
      continue;
    }
    if (!options.execute) {
      outcomes.push({ reportDay: candidate.reportDay, action: "would-import", sha256: digest });
      continue;
    }
    const result = await dependencies.loadDay({
      reportDay: candidate.reportDay,
      organizationId: options.organizationId,
      organizationLogin: options.organizationLogin,
      content: bytes,
      runId: randomUUID(),
      correlationId: randomUUID(),
    });
    if (result.status !== "published") {
      throw new Error(`Import for ${candidate.reportDay} was quarantined (${result.rowsQuarantined} rows, ${result.issues} issues)`);
    }
    outcomes.push({ reportDay: candidate.reportDay, action: "published", sha256: digest, result });
  }
  return outcomes;
}

const OPTION_NAMES = [
  "source-account-url",
  "source-container",
  "archive-account-url",
  "archive-container",
  "sql-server",
  "sql-database",
  "managed-identity-client-id",
  "organization-id",
  "organization-login",
  "from",
  "to",
] as const;

export function parseLegacyMetricsImportArgs(args: readonly string[]): LegacyMetricsImportOptions {
  const values = new Map<string, string>();
  let execute = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--execute") {
      if (execute || dryRun) throw new TypeError("choose only one of --dry-run or --execute");
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (execute || dryRun) throw new TypeError("choose only one of --dry-run or --execute");
      dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new TypeError(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!(OPTION_NAMES as readonly string[]).includes(name)) throw new TypeError(`unknown option: ${arg}`);
    if (values.has(name)) throw new TypeError(`option may only be specified once: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`a value is required for ${arg}`);
    values.set(name, value);
    index++;
  }

  const required = (name: typeof OPTION_NAMES[number]): string => {
    const value = values.get(name);
    if (value === undefined) throw new TypeError(`--${name} is required`);
    return value;
  };
  const organizationIdText = required("organization-id");
  if (!/^[1-9]\d*$/.test(organizationIdText)) throw new TypeError("--organization-id must be a positive integer");
  const organizationId = Number(organizationIdText);
  if (!Number.isSafeInteger(organizationId)) throw new TypeError("--organization-id exceeds the safe integer range");
  const options: LegacyMetricsImportOptions = {
    sourceAccountUrl: required("source-account-url"),
    sourceContainer: required("source-container"),
    archiveAccountUrl: required("archive-account-url"),
    archiveContainer: required("archive-container"),
    sqlServer: required("sql-server"),
    sqlDatabase: required("sql-database"),
    managedIdentityClientId: required("managed-identity-client-id"),
    organizationId,
    organizationLogin: required("organization-login"),
    fromDay: required("from"),
    toDay: required("to"),
    execute,
  };
  validateOptions(options);
  return options;
}

function printUsage(): void {
  console.log([
    "Usage: npm run import:legacy-metrics -- [options] [--dry-run|--execute]",
    "Options:",
    ...OPTION_NAMES.map((name) => `  --${name} VALUE`),
    "The command defaults to dry-run. --execute is required to write to the archive and SQL.",
  ].join("\n"));
}

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    printUsage();
    return 0;
  }
  let options: LegacyMetricsImportOptions;
  try {
    options = parseLegacyMetricsImportArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 2;
  }

  const source = createMetricsBlobContainerClient(
    options.sourceAccountUrl,
    options.sourceContainer,
    options.managedIdentityClientId,
  );
  const archive = createMetricsBlobContainerClient(
    options.archiveAccountUrl,
    options.archiveContainer,
    options.managedIdentityClientId,
  );
  const pool = await new sql.ConnectionPool(
    createMetricsSqlConfig(options.sqlServer, options.sqlDatabase, options.managedIdentityClientId),
  ).connect();
  try {
    const outcomes = await importLegacyMetricsRange(options, {
      async *listBlobNames(prefix) {
        for await (const blob of source.listBlobsFlat({ prefix })) yield blob.name;
      },
      async downloadBlob(blobName) {
        return Uint8Array.from(await source.getBlockBlobClient(blobName).downloadToBuffer());
      },
      async currentPublishedDigest(reportDay) {
        const run = await pool.request()
          .input("scopeKey", sql.NVarChar(100), String(options.organizationId))
          .input("reportDay", sql.Date, reportDay)
          .query<{ run_id: string }>(`
            SELECT TOP (1) run_id
            FROM portal.IngestionRun
            WHERE source_kind = 'users_1_day' AND scope_key = @scopeKey AND report_day = @reportDay
              AND is_current = 1 AND status = 'published'`);
        const runId = run.recordset[0]?.run_id;
        if (!runId) return undefined;
        if (!UUID_PATTERN.test(runId)) throw new Error(`Published run ID for ${reportDay} is invalid`);
        const [year, month, day] = reportDay.split("-");
        const archivePath = `raw/users_1_day/${options.organizationLogin}/${year}/${month}/${day}/${runId}.ndjson`;
        try {
          const properties = await archive.getBlockBlobClient(archivePath).getProperties();
          const digest = properties.metadata?.sha256;
          return digest && SHA256_PATTERN.test(digest) ? digest : undefined;
        } catch (error) {
          if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404) {
            return undefined;
          }
          throw error;
        }
      },
      loadDay: (input) => loadMetricsDay(input, {
        sqlConfig: createMetricsSqlConfig(options.sqlServer, options.sqlDatabase, options.managedIdentityClientId),
        blobContainer: archive,
      }),
    });
    for (const outcome of outcomes) console.log(`${outcome.reportDay}: ${outcome.action} (${outcome.sha256})`);
    console.log(`Processed ${outcomes.length} day(s)${options.execute ? " in execute mode" : " in dry-run mode"}.`);
    return 0;
  } finally {
    await pool.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error: unknown) => {
      console.error(`Legacy metrics import failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
