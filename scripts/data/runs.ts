// Shared pieces of the data operator tools: the SQL connection they use and how they tell a loader-written
// metrics run from a synthetic one. Output from these tools is counts, days, scope keys and run IDs only.
import sql from "mssql";
import { getPortalSqlPool } from "../../portal/src/db/pool";
import { connectionFromEnvironment } from "../db/connection";

// A pipeline passes its own Entra token (SQL_ACCESS_TOKEN), like scripts/deploy-db.sh. Without one the tools
// use Azure default credentials (`az login` or AZURE_CLIENT_ID), as before.
export async function openDataPool(env: NodeJS.ProcessEnv = process.env): Promise<sql.ConnectionPool> {
  if (env.SQL_ACCESS_TOKEN?.trim() || env.SQL_CONNECTION_STRING?.trim()) {
    return new sql.ConnectionPool(connectionFromEnvironment(env)).connect();
  }
  return getPortalSqlPool();
}

// The metrics loader archives every published day at raw/users_1_day/<org>/<yyyy>/<mm>/<dd>/<run_id>.ndjson and
// records that path in SourceArtifact (functions/src/metrics/day-loader.ts). A published users_1_day run without
// such an artifact was not written by the loader: seed or hand-loaded data.
export const SYNTHETIC_METRICS_RUN = `
  run.source_kind = 'users_1_day' AND run.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM portal.SourceArtifact artifact
    WHERE artifact.run_id = run.run_id
      AND artifact.blob_path LIKE N'raw/users[_]1[_]day/%/' + LOWER(CONVERT(NVARCHAR(36), run.run_id)) + N'.ndjson'
  )`;

export async function findSyntheticMetricsRuns(request: sql.Request): Promise<string[]> {
  const result = await request.query<{ run_id: string }>(`
    SELECT run.run_id FROM portal.IngestionRun run WITH (UPDLOCK)
    WHERE ${SYNTHETIC_METRICS_RUN}
    ORDER BY run.report_day, run.run_id`);
  return result.recordset.map((row) => String(row.run_id).toLowerCase());
}
