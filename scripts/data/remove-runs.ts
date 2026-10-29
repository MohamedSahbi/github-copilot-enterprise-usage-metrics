// Operator tool: removes named metrics/AI-credit ingestion runs (for example the sandbox's synthetic
// seed) and everything that points at them, in one transaction. Dry run by default: it performs the
// deletes, reports the row counts and rolls back. `--execute` commits only when the fact-row count
// matches `--expect-fact-rows` from the dry run. Output is counts only; no logins or report contents.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sql from "mssql";
import { getPortalSqlPool } from "../../portal/src/db/pool";

export class RemoveRunsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RemoveRunsArguments {
  runIds: string[];
  userIds: number[];
  organizationIds: number[];
  execute: boolean;
  expectFactRows?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[1-9][0-9]{0,17}$/;

export function parseRemoveRunsArguments(args: readonly string[]): RemoveRunsArguments {
  const result: RemoveRunsArguments = { runIds: [], userIds: [], organizationIds: [], execute: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--execute" && !result.execute) {
      result.execute = true;
      continue;
    }
    if (value === undefined || value.startsWith("--")) throw new RemoveRunsError("invalid_arguments");
    index += 1;
    if (arg === "--run-id" && UUID.test(value)) result.runIds.push(value.toLowerCase());
    else if (arg === "--user-id" && ID.test(value)) result.userIds.push(Number(value));
    else if (arg === "--organization-id" && ID.test(value)) result.organizationIds.push(Number(value));
    else if (arg === "--expect-fact-rows" && result.expectFactRows === undefined && /^(0|[1-9][0-9]*)$/.test(value)) {
      result.expectFactRows = Number(value);
    } else throw new RemoveRunsError("invalid_arguments");
  }
  for (const list of [result.runIds, result.userIds, result.organizationIds] as Array<readonly unknown[]>) {
    if (new Set(list).size !== list.length) throw new RemoveRunsError("invalid_arguments");
  }
  if (result.runIds.length === 0) throw new RemoveRunsError("invalid_arguments");
  if (result.execute !== (result.expectFactRows !== undefined)) throw new RemoveRunsError("invalid_arguments");
  return result;
}

// Children first. Breakdown/family rows cascade from daily usage but are deleted explicitly so they are counted.
const RUN_TABLES = [
  "fact_usage_breakdown",
  "fact_usage_family_count",
  "fact_user_daily_usage",
  "fact_ai_credit_line",
  "agg_daily_usage",
  "agg_ai_credit_daily",
  "stg_user_breakdown",
  "stg_user_family_count",
  "stg_user_daily",
  "stg_ai_credit_line",
  "IngestionAuditEvent",
] as const;
const FACT_TABLES = new Set<string>(["fact_user_daily_usage", "fact_ai_credit_line"]);

export interface RemoveRunsResult {
  committed: boolean;
  runs: number;
  factRows: number;
  deleted: Record<string, number>;
}

function inList(request: sql.Request, prefix: string, values: readonly (string | number)[]): string {
  return values.map((value, index) => {
    if (typeof value === "string") request.input(`${prefix}${index}`, sql.UniqueIdentifier, value);
    else request.input(`${prefix}${index}`, sql.BigInt, value);
    return `@${prefix}${index}`;
  }).join(", ");
}

export async function removeRuns(pool: sql.ConnectionPool, input: RemoveRunsArguments): Promise<RemoveRunsResult> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const deleted: Record<string, number> = {};
  const run = async (key: string, query: (request: sql.Request) => string): Promise<sql.IResult<Record<string, unknown>>> => {
    const request = new sql.Request(transaction);
    const result = await request.query(query(request));
    deleted[key] = (deleted[key] ?? 0) + (result.rowsAffected.at(-1) ?? 0);
    return result;
  };
  try {
    const lookup = new sql.Request(transaction);
    const found = (await lookup.query(`
      SELECT source_kind, COUNT(*) AS n FROM portal.IngestionRun WITH (UPDLOCK)
      WHERE run_id IN (${inList(lookup, "r", input.runIds)}) GROUP BY source_kind`)).recordset as Array<{ source_kind: string; n: number }>;
    if (found.reduce((sum, row) => sum + Number(row.n), 0) !== input.runIds.length) throw new RemoveRunsError("run_not_found");
    if (found.some((row) => row.source_kind !== "users_1_day" && row.source_kind !== "ai_credit")) {
      throw new RemoveRunsError("unsupported_source_kind");
    }
    const checkpoint = new sql.Request(transaction);
    const referenced = (await checkpoint.query(`
      SELECT COUNT(*) AS n FROM portal.SourceCheckpoint
      WHERE last_run_id IN (${inList(checkpoint, "r", input.runIds)})`)).recordset[0] as { n: number };
    if (Number(referenced.n) > 0) throw new RemoveRunsError("checkpoint_references_run");

    for (const table of RUN_TABLES) {
      await run(table, (request) => `DELETE FROM portal.${table} WHERE run_id IN (${inList(request, "r", input.runIds)})`);
    }
    await run("IssueAction", (request) => `
      DELETE action FROM portal.IssueAction action
      JOIN portal.ValidationIssue issue ON issue.issue_id = action.issue_id
      WHERE issue.run_id IN (${inList(request, "r", input.runIds)})`);
    await run("ValidationIssue", (request) => `DELETE FROM portal.ValidationIssue WHERE run_id IN (${inList(request, "r", input.runIds)})`);
    await run("SourceArtifact", (request) => `DELETE FROM portal.SourceArtifact WHERE run_id IN (${inList(request, "r", input.runIds)})`);
    await run("IngestionRun", (request) => `DELETE FROM portal.IngestionRun WHERE run_id IN (${inList(request, "r", input.runIds)})`);

    // Synthetic users and organizations go only when no facts from any other run still use them.
    // Any other reference (grants, scopes, directory links) makes the delete fail and rolls everything back.
    if (input.userIds.length > 0) {
      const check = new sql.Request(transaction);
      const users = inList(check, "u", input.userIds);
      const inUse = (await check.query(`
        SELECT COUNT(*) AS n FROM portal.fact_user_daily_usage WHERE user_id IN (${users})`)).recordset[0] as { n: number };
      if (Number(inUse.n) > 0) throw new RemoveRunsError("user_still_referenced");
      await run("dim_user_login_history", (request) => `DELETE FROM portal.dim_user_login_history WHERE user_id IN (${inList(request, "u", input.userIds)})`);
      await run("dim_user", (request) => `DELETE FROM portal.dim_user WHERE user_id IN (${inList(request, "u", input.userIds)})`);
      if (deleted.dim_user !== input.userIds.length) throw new RemoveRunsError("user_not_found");
    }
    if (input.organizationIds.length > 0) {
      const check = new sql.Request(transaction);
      const orgs = inList(check, "o", input.organizationIds);
      const inUse = (await check.query(`
        SELECT COUNT(*) AS n FROM portal.fact_user_daily_usage WHERE organization_id IN (${orgs})`)).recordset[0] as { n: number };
      if (Number(inUse.n) > 0) throw new RemoveRunsError("organization_still_referenced");
      await run("dim_organization", (request) => `DELETE FROM portal.dim_organization WHERE organization_id IN (${inList(request, "o", input.organizationIds)})`);
      if (deleted.dim_organization !== input.organizationIds.length) throw new RemoveRunsError("organization_not_found");
    }

    const factRows = [...FACT_TABLES].reduce((sum, table) => sum + (deleted[table] ?? 0), 0);
    const commit = input.execute && input.expectFactRows === factRows;
    if (commit) await transaction.commit();
    else await transaction.rollback();
    if (input.execute && !commit) throw new RemoveRunsError("fact_row_count_mismatch");
    return { committed: commit, runs: input.runIds.length, factRows, deleted };
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // Already rolled back (or aborted by SQL Server).
    }
    throw error;
  }
}

async function main(args: readonly string[]): Promise<void> {
  const correlationId = randomUUID();
  let pool: sql.ConnectionPool | undefined;
  try {
    const input = parseRemoveRunsArguments(args);
    pool = await getPortalSqlPool();
    const result = await removeRuns(pool, input);
    process.stdout.write(`${JSON.stringify({ event: "data.remove_runs", correlationId, ...result })}\n`);
  } catch (error) {
    const code = error instanceof RemoveRunsError ? error.code : "transaction_failed";
    process.stderr.write(`${JSON.stringify({ event: "data.remove_runs.failed", code, correlationId })}\n`);
    process.exitCode = 1;
  } finally {
    await pool?.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
