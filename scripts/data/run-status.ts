// Operator tool, read-only: the metrics state of each day in a range, per organization scope. A day is
// `published` (with loaded and quarantined row counts), `failed` (attempts but no published run), `started`
// (a run in progress) or `gap` (no run at all). Published runs the loader did not write are flagged
// `synthetic` and listed by run ID so `data:remove-runs -- --synthetic` can clear them before a history import.
// Output is one JSON line of counts, days, scope keys and run IDs; no logins or report contents.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type sql from "mssql";
import { openDataPool, SYNTHETIC_METRICS_RUN } from "./runs";

export class RunStatusError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RunStatusArguments {
  from: string;
  to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

function validDay(value: string): boolean {
  return DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

export function yesterdayUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

export function parseRunStatusArguments(args: readonly string[], now: Date = new Date()): RunStatusArguments {
  let from: string | undefined;
  let to: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const [arg, value] = [args[index], args[index + 1]];
    if (value === undefined || !validDay(value)) throw new RunStatusError("invalid_arguments");
    if (arg === "--from" && from === undefined) from = value;
    else if (arg === "--to" && to === undefined) to = value;
    else throw new RunStatusError("invalid_arguments");
  }
  if (from === undefined) throw new RunStatusError("invalid_arguments");
  to ??= yesterdayUtc(now);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days >= MAX_DAYS) throw new RunStatusError("invalid_arguments");
  return { from, to };
}

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += 86_400_000) days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}

export type DayState = "published" | "failed" | "started" | "gap";

export interface RunRow {
  scope_key: string;
  report_day: string;
  status: string;
  is_current: boolean;
  rows_loaded: number | null;
  rows_quarantined: number | null;
  error_code: string | null;
  synthetic: boolean;
  run_id: string;
}

export interface DayStatus {
  day: string;
  scope: string;
  state: DayState;
  rowsLoaded: number;
  rowsQuarantined: number;
  failedAttempts: number;
  lastError?: string;
  synthetic?: true;
}

export interface RunStatusReport {
  from: string;
  to: string;
  scopes: number;
  totals: Record<DayState, number>;
  syntheticRunIds: string[];
  days: DayStatus[];
}

// Scopes are every organization the loader has ever run for, so a day with no run in range still shows as a gap.
// Rows arrive oldest attempt first per scope and day, so the last failed row carries the latest error.
export function summarizeRuns(input: RunStatusArguments, knownScopes: readonly string[], rows: readonly RunRow[]): RunStatusReport {
  const scopes = [...new Set([...knownScopes, ...rows.map((row) => row.scope_key)])].sort();
  const byKey = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = `${row.scope_key}|${row.report_day}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const totals: Record<DayState, number> = { published: 0, failed: 0, started: 0, gap: 0 };
  const syntheticRunIds: string[] = [];
  const days: DayStatus[] = [];
  for (const day of daysBetween(input.from, input.to)) {
    for (const scope of scopes) {
      const runs = byKey.get(`${scope}|${day}`) ?? [];
      const current = runs.find((run) => run.is_current);
      const failed = runs.filter((run) => run.status === "failed");
      const state: DayState = current ? "published"
        : runs.some((run) => !["failed", "cancelled", "published"].includes(run.status)) ? "started"
          : failed.length > 0 ? "failed" : "gap";
      const status: DayStatus = {
        day, scope, state,
        rowsLoaded: current?.rows_loaded ?? 0,
        rowsQuarantined: current?.rows_quarantined ?? 0,
        failedAttempts: failed.length,
      };
      const lastError = failed.at(-1)?.error_code;
      if (state === "failed" && lastError) status.lastError = lastError;
      if (current?.synthetic) status.synthetic = true;
      totals[state] += 1;
      days.push(status);
    }
  }
  for (const row of rows) if (row.synthetic) syntheticRunIds.push(row.run_id.toLowerCase());
  return { ...input, scopes: scopes.length, totals, syntheticRunIds, days };
}

export async function readRunStatus(pool: sql.ConnectionPool, input: RunStatusArguments): Promise<RunStatusReport> {
  const result = await pool.request()
    .input("from", input.from)
    .input("to", input.to)
    .query<RunRow>(`
      SELECT run.scope_key, CONVERT(CHAR(10), run.report_day, 23) AS report_day, run.status, run.is_current,
        run.rows_loaded, run.rows_quarantined, run.error_code, CONVERT(VARCHAR(36), run.run_id) AS run_id,
        CAST(CASE WHEN ${SYNTHETIC_METRICS_RUN} THEN 1 ELSE 0 END AS BIT) AS synthetic
      FROM portal.IngestionRun run
      WHERE run.source_kind = 'users_1_day' AND run.report_day BETWEEN @from AND @to
      ORDER BY run.scope_key, run.report_day, run.started_at, run.run_id`);
  const scopes = await pool.request().query<{ scope_key: string }>(`
    SELECT DISTINCT scope_key FROM portal.IngestionRun WHERE source_kind = 'users_1_day'`);
  return summarizeRuns(input, scopes.recordset.map((row) => row.scope_key), result.recordset);
}

async function main(args: readonly string[]): Promise<void> {
  const correlationId = randomUUID();
  let pool: sql.ConnectionPool | undefined;
  try {
    const input = parseRunStatusArguments(args);
    pool = await openDataPool();
    const report = await readRunStatus(pool, input);
    process.stdout.write(`${JSON.stringify({ event: "data.run_status", correlationId, ...report })}\n`);
  } catch (error) {
    const code = error instanceof RunStatusError ? error.code : "query_failed";
    process.stderr.write(`${JSON.stringify({ event: "data.run_status.failed", code, correlationId })}\n`);
    process.exitCode = 1;
  } finally {
    await pool?.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
