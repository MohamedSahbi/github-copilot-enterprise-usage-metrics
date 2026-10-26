import { createHash, randomBytes, randomUUID } from "node:crypto";
import sql from "mssql";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate";
import { localConnectionString } from "../stack/config";
import { loadMetricsDay } from "../../functions/src/metrics/day-loader";

const database = `metrics_loader_${process.pid}`;
const testConnection = localConnectionString(process.env, database);
const orgId = 800_000_000 + process.pid;
const userIds = [1_000_000_000 + process.pid * 10 + 1, 1_000_000_000 + process.pid * 10 + 2];
const sourceUserIds = [userIds[0]!, userIds[1]!, userIds[1]! + 1, userIds[1]! + 2];
const orgLogin = "example-metrics-org";
const scopeKey = String(orgId);
const reportDay = "2026-03-02";
const containerName = `metrics-loader-${process.pid}`;
const blobService = BlobServiceClient.fromConnectionString("UseDevelopmentStorage=true");
const blobContainer = blobService.getContainerClient(containerName);
const sqlConfig = sql.ConnectionPool.parseConnectionString(testConnection);

let pool: sql.ConnectionPool;
let runIds: string[] = [];
let blobPaths: string[] = [];

function ndjson(ids: readonly number[], extra: Record<string, unknown> = {}): Uint8Array {
  const lines = ids.map((user_id) => JSON.stringify({
    day: reportDay,
    organization_id: String(orgId),
    user_id,
    user_login: `example-user-${user_id}`,
    user_initiated_interaction_count: 2,
    code_generation_activity_count: 1,
    code_acceptance_activity_count: 0,
    loc_suggested_to_add_sum: 3,
    loc_suggested_to_delete_sum: 0,
    loc_added_sum: 1,
    loc_deleted_sum: 0,
    used_cli: true,
    totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 1 }],
    ...extra,
  }));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function ndjsonWithAiCredits(userId: number, numericToken: string): Uint8Array {
  const line = Buffer.from(ndjson([userId])).toString("utf8").trimEnd();
  return Buffer.from(`${line.slice(0, -1)},"ai_credits_used":${numericToken}}\n`, "utf8");
}

function newInput(content: Uint8Array, runId = randomUUID()) {
  runIds.push(runId);
  blobPaths.push(`raw/users_1_day/${orgLogin}/${reportDay.replaceAll("-", "/")}/${runId}.ndjson`);
  return { reportDay, organizationId: orgId, organizationLogin: orgLogin, content, runId, correlationId: randomUUID() };
}

async function count(
  query: string,
  name: string,
  type: sql.ISqlType | (() => sql.ISqlType),
  value: string | number,
): Promise<number> {
  const result = await pool.request().input(name, type, value).query<{ count: number }>(query);
  return Number(result.recordset[0]?.count ?? 0);
}

describe("metrics day loader (SQL Server + Azurite)", () => {
  beforeAll(async () => {
    const master = await new sql.ConnectionPool(localConnectionString(process.env, "master")).connect();
    try {
      await master.batch(`IF DB_ID(N'${database}') IS NULL CREATE DATABASE [${database}]`);
    } finally {
      await master.close();
    }
    await migrate({ connectionString: testConnection });
    await blobContainer.createIfNotExists();
    pool = await new sql.ConnectionPool(testConnection).connect();
  }, 240_000);

  afterEach(async () => {
    if (pool) {
      await pool.request()
        .input("organizationId", sql.BigInt, orgId)
        .input("user1", sql.BigInt, userIds[0])
        .input("user2", sql.BigInt, userIds[1])
        .input("user3", sql.BigInt, sourceUserIds[2])
        .input("user4", sql.BigInt, sourceUserIds[3])
        .query(`
        DELETE FROM portal.agg_daily_usage WHERE organization_id = @organizationId;
        DELETE FROM portal.fact_user_daily_usage WHERE organization_id = @organizationId;
        DELETE FROM portal.dim_user_login_history WHERE user_id IN (@user1, @user2, @user3, @user4);
        DELETE FROM portal.dim_user WHERE user_id IN (@user1, @user2, @user3, @user4);
        DELETE FROM portal.dim_organization WHERE organization_id = @organizationId`);
      await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
        .query("DELETE FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey");
      for (const runId of runIds) {
        await pool.request().input("runId", sql.UniqueIdentifier, runId).query(`
          DELETE FROM portal.stg_user_family_count WHERE run_id = @runId;
          DELETE FROM portal.stg_user_breakdown WHERE run_id = @runId;
          DELETE FROM portal.stg_user_daily WHERE run_id = @runId;
          DELETE FROM portal.ValidationIssue WHERE run_id = @runId;
          DELETE FROM portal.SourceArtifact WHERE run_id = @runId;
          DELETE FROM portal.IngestionRun WHERE run_id = @runId`);
      }
    }
    for (const path of blobPaths) await blobContainer.getBlockBlobClient(path).deleteIfExists();
    runIds = [];
    blobPaths = [];
  });

  afterAll(async () => {
    await pool?.close();
    await blobContainer.deleteIfExists();
    const master = await new sql.ConnectionPool(localConnectionString(process.env, "master")).connect();
    try {
      await master.batch(`IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`);
    } finally {
      await master.close();
    }
  }, 120_000);

  it("archives immutable raw bytes with SourceArtifact hash and lineage, then publishes once on replay", async () => {
    const payload = ndjson(userIds);
    const first = newInput(payload);
    const firstResult = await loadMetricsDay(first, { sqlConfig, blobContainer });
    const second = newInput(payload);
    const secondResult = await loadMetricsDay(second, { sqlConfig, blobContainer });

    expect(firstResult.status).toBe("published");
    expect(secondResult.status).toBe("published");
    expect(secondResult.blobPath).toMatch(new RegExp(`^raw/users_1_day/${orgLogin}/${reportDay.replaceAll("-", "/")}/`));
    const artifact = (await pool.request().input("runId", sql.UniqueIdentifier, second.runId).query<{
      artifact_id: number; sha256: string; blob_path: string; row_count: number;
    }>("SELECT artifact_id, sha256, blob_path, row_count FROM portal.SourceArtifact WHERE run_id = @runId")).recordset[0]!;
    expect(artifact.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(Number(artifact.row_count)).toBe(userIds.length);
    expect(await blobContainer.getBlobClient(artifact.blob_path).downloadToBuffer()).toEqual(Buffer.from(payload));
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(userIds.length);
    const lineage = await pool.request()
      .input("runId", sql.UniqueIdentifier, second.runId)
      .input("artifactId", sql.BigInt, artifact.artifact_id)
      .query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE run_id = @runId AND source_artifact_id = @artifactId",
      );
    expect(Number(lineage.recordset[0]?.count)).toBe(userIds.length);
    const currentRuns = await pool.request()
      .input("scopeKey", sql.NVarChar(100), scopeKey)
      .input("reportDay", sql.Date, reportDay)
      .query<{ count: number }>("SELECT COUNT(*) AS count FROM portal.IngestionRun WHERE scope_key = @scopeKey AND report_day = @reportDay AND is_current = 1");
    expect(Number(currentRuns.recordset[0]?.count)).toBe(1);
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(second.runId);
  });

  it.each(["123456789.123456789", "999999999.999999999"])(
    "preserves exact ai_credits_used %s through staging, facts, and aggregate",
    async (creditToken) => {
      const input = newInput(ndjsonWithAiCredits(userIds[0]!, creditToken));
      const result = await loadMetricsDay(input, { sqlConfig, blobContainer });

      expect(result.status).toBe("published");
      const staging = await pool.request()
        .input("runId", sql.UniqueIdentifier, input.runId)
        .query<{ amount: string }>(
          "SELECT CONVERT(VARCHAR(40), ai_credits_used) AS amount FROM portal.stg_user_daily WHERE run_id = @runId",
        );
      const fact = await pool.request()
        .input("runId", sql.UniqueIdentifier, input.runId)
        .query<{ amount: string }>(
          "SELECT CONVERT(VARCHAR(40), ai_credits_used) AS amount FROM portal.fact_user_daily_usage WHERE run_id = @runId",
        );
      const aggregate = await pool.request()
        .input("runId", sql.UniqueIdentifier, input.runId)
        .query<{ amount: string }>(
          "SELECT CONVERT(VARCHAR(40), ai_credits_used) AS amount FROM portal.agg_daily_usage WHERE run_id = @runId",
        );

      expect(staging.recordset[0]?.amount).toBe(creditToken);
      expect(fact.recordset[0]?.amount).toBe(creditToken);
      expect(aggregate.recordset[0]?.amount).toBe(creditToken);
    },
  );

  it("round-trips source metrics independently through staging and curated facts", async () => {
    const sourceRows = [
      { version: "v".repeat(64), cli: 5, app: 7, vscode: 8 },
      { version: "v2", cli: 0, app: 0, vscode: 0 },
      { version: undefined, cli: undefined, app: undefined, vscode: undefined },
      { version: null, cli: null, app: null, vscode: null },
    ];
    const payload = Buffer.from(`${sourceRows.map((source, index) => {
      const line = JSON.stringify({
        day: reportDay,
        organization_id: String(orgId),
        user_id: sourceUserIds[index],
        user_login: `example-user-${sourceUserIds[index]}`,
        user_initiated_interaction_count: 2,
        code_generation_activity_count: 1,
        code_acceptance_activity_count: 0,
        loc_suggested_to_add_sum: 3,
        loc_suggested_to_delete_sum: 0,
        loc_added_sum: 1,
        loc_deleted_sum: 0,
        used_cli: true,
        ai_credits_used: 0,
        ai_adoption_phase: { phase_number: 2, phase: "Agent first", ...(source.version === undefined ? {} : { version: source.version }) },
        totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 1 }],
        totals_by_cli: { session_count: 3, request_count: 4, ...(source.cli === undefined ? {} : { prompt_count: source.cli }) },
        totals_by_copilot_app: { session_count: 6, ...(source.app === undefined ? {} : { prompt_count: source.app }) },
        totals_by_vscode_agent: {
          ...(source.vscode === undefined ? {} : { total_user_messages: source.vscode }),
          token_usage: { prompt_tokens_sum: 9, output_tokens_sum: 10 },
        },
      });
      return index === 0 ? line.replace('"ai_credits_used":0', '"ai_credits_used":123456789.123456789') : line;
    }).join("\n")}\n`, "utf8");
    const input = newInput(payload);
    const result = await loadMetricsDay(input, { sqlConfig, blobContainer });
    expect(result.status).toBe("published");
    for (const table of ["stg_user_daily", "fact_user_daily_usage"] as const) {
      const stored = await pool.request().input("runId", sql.UniqueIdentifier, input.runId).query(`
        SELECT user_id, ai_adoption_phase_version, ai_adoption_phase_number, ai_adoption_phase,
          interaction_count, code_generation_count, loc_added, CONVERT(VARCHAR(40), ai_credits_used) AS credits
        FROM portal.${table} WHERE run_id = @runId ORDER BY user_id`);
      expect(stored.recordset).toEqual(sourceRows.map((source, index) => ({
        user_id: String(sourceUserIds[index]),
        ai_adoption_phase_version: source.version ?? null, ai_adoption_phase_number: 2, ai_adoption_phase: "Agent first",
        interaction_count: 2, code_generation_count: 1, loc_added: "1",
        credits: index === 0 ? "123456789.123456789" : "0.000000000",
      })));
    }
    for (const table of ["stg_user_breakdown", "fact_usage_breakdown"] as const) {
      const userColumn = table === "stg_user_breakdown" ? "d.user_id" : "b.user_id";
      const dailyJoin = table === "stg_user_breakdown"
        ? `JOIN portal.stg_user_daily AS d
             ON d.run_id = b.run_id AND d.artifact_id = b.artifact_id AND d.line_number = b.line_number`
        : "";
      const stored = await pool.request().input("runId", sql.UniqueIdentifier, input.runId).query(`
        SELECT ${userColumn} AS user_id, b.key_1, b.prompt_count, b.total_user_messages, b.session_count, b.request_count,
          b.prompt_tokens, b.output_tokens, b.code_generation_count
        FROM portal.${table} AS b
        ${dailyJoin}
        WHERE b.run_id = @runId AND b.breakdown_kind = 'client' ORDER BY user_id, b.key_1`);
      expect(stored.recordset).toEqual(sourceRows.flatMap((source, index) => [
        {
          user_id: String(sourceUserIds[index]), key_1: "copilot_app", prompt_count: source.app ?? null, total_user_messages: null,
          session_count: 6, request_count: null, prompt_tokens: null, output_tokens: null, code_generation_count: 0,
        },
        {
          user_id: String(sourceUserIds[index]), key_1: "copilot_cli", prompt_count: source.cli ?? null, total_user_messages: null,
          session_count: 3, request_count: 4, prompt_tokens: null, output_tokens: null, code_generation_count: 0,
        },
        {
          user_id: String(sourceUserIds[index]), key_1: "vscode_agent", prompt_count: null, total_user_messages: source.vscode ?? null,
          session_count: null, request_count: null, prompt_tokens: "9", output_tokens: "10", code_generation_count: 0,
        },
      ]));
    }
  });

  it("rejects phase versions the target VARCHAR collation cannot round-trip", async () => {
    const valid = newInput(ndjson([userIds[0]!], {
      ai_adoption_phase: { phase_number: 2, phase: "Agent first", version: "café" },
    }));
    expect((await loadMetricsDay(valid, { sqlConfig, blobContainer })).status).toBe("published");
    const validStaged = await pool.request().input("runId", sql.UniqueIdentifier, valid.runId).query(`
      SELECT ai_adoption_phase_version FROM portal.stg_user_daily WHERE run_id = @runId`);
    expect(validStaged.recordset).toEqual([{ ai_adoption_phase_version: "café" }]);
    const validStored = await pool.request().input("runId", sql.UniqueIdentifier, valid.runId).query(`
      SELECT ai_adoption_phase_version FROM portal.fact_user_daily_usage WHERE run_id = @runId`);
    expect(validStored.recordset).toEqual([{ ai_adoption_phase_version: "café" }]);

    const invalid = newInput(ndjson([userIds[0]!], {
      ai_adoption_phase: { phase_number: 2, phase: "Agent first", version: "A😀B" },
    }));
    const result = await loadMetricsDay(invalid, { sqlConfig, blobContainer });
    expect(result.status).toBe("quarantined");
    const issue = (await pool.request().input("runId", sql.UniqueIdentifier, invalid.runId).query(`
      SELECT severity, error_code, field_path
      FROM portal.ValidationIssue WHERE run_id = @runId`)).recordset[0];
    expect(issue).toEqual({
      severity: "fatal", error_code: "unsupported_schema", field_path: "ai_adoption_phase.version",
    });
    expect(await count(
      "SELECT COUNT(*) AS count FROM portal.stg_user_daily WHERE run_id = @runId",
      "runId", sql.UniqueIdentifier, invalid.runId,
    )).toBe(0);
    const fact = (await pool.request()
      .input("organizationId", sql.BigInt, orgId)
      .input("userId", sql.BigInt, userIds[0])
      .input("reportDay", sql.Date, reportDay)
      .query(`
      SELECT ai_adoption_phase_version FROM portal.fact_user_daily_usage
      WHERE organization_id = @organizationId AND user_id = @userId AND usage_day = @reportDay`)).recordset[0];
    expect(fact).toEqual({ ai_adoption_phase_version: "café" });
  });

  it("quarantines invalid source counters without replacing facts or advancing the checkpoint", async () => {
    const baseline = newInput(ndjson(userIds));
    expect((await loadMetricsDay(baseline, { sqlConfig, blobContainer })).status).toBe("published");
    const malformed = newInput(ndjson([userIds[0]!], { totals_by_cli: { prompt_count: "5" } }));
    const result = await loadMetricsDay(malformed, { sqlConfig, blobContainer });

    expect(result.status).toBe("quarantined");
    const issue = (await pool.request().input("runId", sql.UniqueIdentifier, malformed.runId).query(`
      SELECT severity, error_code, field_path
      FROM portal.ValidationIssue WHERE run_id = @runId`)).recordset[0];
    expect(issue).toEqual({ severity: "reject", error_code: "negative_count", field_path: "totals_by_cli.prompt_count" });
    expect(await count(
      "SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @organizationId",
      "organizationId", sql.BigInt, orgId,
    )).toBe(userIds.length);
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(baseline.runId);
  });

  it("publishes with the portal_ingest role's SourceArtifact permissions", async () => {
    const login = `metrics_ingest_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("base64url");
    const master = await new sql.ConnectionPool(localConnectionString(process.env, "master")).connect();
    let loginCreated = false;
    let userCreated = false;
    try {
      await master.request().query(`CREATE LOGIN [${login}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
      loginCreated = true;
      await pool.request().query(`
        CREATE USER [${login}] FOR LOGIN [${login}];
        ALTER ROLE portal_ingest ADD MEMBER [${login}]`);
      userCreated = true;
      const input = newInput(ndjson([userIds[0]!]));
      const restrictedConfig: sql.config = { ...sqlConfig, user: login, password, pool: { min: 1, max: 1 } };
      const result = await loadMetricsDay(input, { sqlConfig: restrictedConfig, blobContainer });

      expect(result.status).toBe("published");
      const artifact = (await pool.request().input("runId", sql.UniqueIdentifier, input.runId).query<{ row_count: number }>(
        "SELECT row_count FROM portal.SourceArtifact WHERE run_id = @runId",
      )).recordset[0];
      expect(Number(artifact?.row_count)).toBe(1);
    } finally {
      if (userCreated) {
        await pool.request().query(`ALTER ROLE portal_ingest DROP MEMBER [${login}]; DROP USER [${login}]`);
      }
      if (loginCreated) await master.request().query(`DROP LOGIN [${login}]`);
      await master.close();
    }
  });

  it("quarantines duplicate user records as a fatal file and leaves the checkpoint unchanged", async () => {
    const single = ndjson([userIds[0]!]);
    const published = newInput(single);
    await loadMetricsDay(published, { sqlConfig, blobContainer });
    const duplicate = newInput(ndjson([userIds[1]!, userIds[1]!]));
    const duplicateResult = await loadMetricsDay(duplicate, { sqlConfig, blobContainer });

    expect(duplicateResult.status).toBe("quarantined");
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM portal.stg_user_daily WHERE run_id = @value", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(0);
    const duplicateIssue = (await pool.request().input("runId", sql.UniqueIdentifier, duplicate.runId).query<{ error_code: string; issue_type: string }>(
      "SELECT TOP (1) error_code, issue_type FROM portal.ValidationIssue WHERE run_id = @runId ORDER BY issue_id DESC",
    )).recordset[0];
    expect(duplicateIssue).toEqual({ error_code: "duplicate_file", issue_type: "duplicate_file" });
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(published.runId);
  });

  it.each([true, false])("quarantines duplicate identities with invalid-count row first: %s", async (invalidFirst) => {
    const original = newInput(ndjson([userIds[0]!]));
    await loadMetricsDay(original, { sqlConfig, blobContainer });
    const valid = ndjson([userIds[1]!]);
    const invalid = ndjson([userIds[1]!], { user_initiated_interaction_count: -1 });
    const duplicate = newInput(Buffer.concat(invalidFirst ? [invalid, valid] : [valid, invalid]));
    const result = await loadMetricsDay(duplicate, { sqlConfig, blobContainer });

    expect(result.status).toBe("quarantined");
    expect(await count("SELECT COUNT(*) AS count FROM portal.stg_user_daily WHERE run_id = @value", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE run_id = @value", "value", sql.UniqueIdentifier, original.runId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE run_id = @value", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.ValidationIssue WHERE run_id = @value AND error_code = 'duplicate_file'", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(1);
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(original.runId);
  });

  it.each([true, false])("quarantines duplicate identities with an invalid client counter first: %s", async (invalidFirst) => {
    const original = newInput(ndjson([userIds[0]!]));
    await loadMetricsDay(original, { sqlConfig, blobContainer });
    const valid = ndjson([userIds[1]!], { totals_by_cli: { prompt_count: 5 } });
    const invalid = ndjson([userIds[1]!], { totals_by_cli: { prompt_count: "5" } });
    const duplicate = newInput(Buffer.concat(invalidFirst ? [invalid, valid] : [valid, invalid]));
    const result = await loadMetricsDay(duplicate, { sqlConfig, blobContainer });

    expect(result.status).toBe("quarantined");
    expect(await count("SELECT COUNT(*) AS count FROM portal.stg_user_daily WHERE run_id = @value", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE run_id = @value", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.ValidationIssue WHERE run_id = @value AND error_code = 'duplicate_file'", "value", sql.UniqueIdentifier, duplicate.runId)).toBe(1);
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(original.runId);
  });

  it("blocks a smaller replacement and preserves the current complete day", async () => {
    const first = newInput(ndjson(userIds));
    await loadMetricsDay(first, { sqlConfig, blobContainer });
    const replacement = newInput(ndjson([userIds[0]!]));
    const rejected = await loadMetricsDay(replacement, { sqlConfig, blobContainer });

    expect(rejected.status).toBe("quarantined");
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(2);
    const issue = (await pool.request().input("runId", sql.UniqueIdentifier, replacement.runId).query<{ error_code: string; issue_type: string }>(
      "SELECT TOP (1) error_code, issue_type FROM portal.ValidationIssue WHERE run_id = @runId ORDER BY issue_id DESC",
    )).recordset[0];
    expect(issue).toEqual({ error_code: "smaller_day_blocked", issue_type: "smaller_day" });
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(first.runId);
  });

  it("does not replace the complete day when a required source count is null", async () => {
    const original = newInput(ndjson(userIds));
    await loadMetricsDay(original, { sqlConfig, blobContainer });
    const incompletePayload = Buffer.concat([
      ndjson([userIds[0]!], { user_initiated_interaction_count: null }),
      ndjson([userIds[1]!]),
    ]);
    const replacement = newInput(incompletePayload);
    const result = await loadMetricsDay(replacement, { sqlConfig, blobContainer });

    expect(result.status).toBe("quarantined");
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(2);
    const issue = (await pool.request().input("runId", sql.UniqueIdentifier, replacement.runId).query<{ error_code: string }>(
      "SELECT TOP (1) error_code FROM portal.ValidationIssue WHERE run_id = @runId AND error_code = 'negative_count' ORDER BY issue_id DESC",
    )).recordset[0];
    expect(issue?.error_code).toBe("negative_count");
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(original.runId);
  });

  it("publishes valid rows from a partial report without advancing the complete-day checkpoint", async () => {
    const validRow = Buffer.from(ndjson([userIds[0]!])).toString("utf8");
    const invalidRow = Buffer.from(validRow.replace(/"user_id":\d+/, '"user_id":null'));
    const partialInput = newInput(Buffer.concat([ndjson([userIds[0]!]), invalidRow]));
    const partialResult = await loadMetricsDay(partialInput, { sqlConfig, blobContainer });

    expect(partialResult.status).toBe("published");
    expect(partialResult.rowsLoaded).toBe(1);
    expect(partialResult.rowsQuarantined).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM portal.SourceCheckpoint WHERE scope_key = @value", "value", sql.NVarChar(100), scopeKey)).toBe(0);

    const completeInput = newInput(ndjson(userIds));
    await loadMetricsDay(completeInput, { sqlConfig, blobContainer });
    const replacementInput = newInput(Buffer.concat([
      ndjson(userIds),
      invalidRow,
    ]));
    const replacementResult = await loadMetricsDay(replacementInput, { sqlConfig, blobContainer });

    expect(replacementResult.status).toBe("published");
    expect(replacementResult.rowsLoaded).toBe(userIds.length);
    expect(replacementResult.rowsQuarantined).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(userIds.length);
    const checkpoint = (await pool.request().input("scopeKey", sql.NVarChar(100), scopeKey)
      .query<{ last_run_id: string }>("SELECT last_run_id FROM portal.SourceCheckpoint WHERE scope_key = @scopeKey")).recordset[0];
    expect(checkpoint?.last_run_id?.toLowerCase()).toBe(completeInput.runId);
  });

  it("quarantines a non-empty report with no accepted rows without publishing or advancing the checkpoint", async () => {
    const input = newInput(Buffer.from("not JSON\n", "utf8"));
    const result = await loadMetricsDay(input, { sqlConfig, blobContainer });

    expect(result.status).toBe("quarantined");
    expect(result.rowsLoaded).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.stg_user_daily WHERE run_id = @value", "value", sql.UniqueIdentifier, input.runId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.SourceCheckpoint WHERE scope_key = @value", "value", sql.NVarChar(100), scopeKey)).toBe(0);
    const run = (await pool.request().input("runId", sql.UniqueIdentifier, input.runId)
      .query<{ status: string; rows_loaded: number; error_code: string }>(
        "SELECT status, rows_loaded, error_code FROM portal.IngestionRun WHERE run_id = @runId",
      )).recordset[0];
    expect(run).toEqual({ status: "quarantined", rows_loaded: 0, error_code: "malformed_json" });
  });

  it("seeds language and model dimensions from their respective keys", async () => {
    const model = `example-model-${process.pid}`;
    const input = newInput(ndjson([userIds[0]!], {
      totals_by_language_model: [{ language: "typescript", model, code_generation_activity_count: 1 }],
    }));
    await loadMetricsDay(input, { sqlConfig, blobContainer });
    const dimensions = (await pool.request()
      .input("model", sql.NVarChar(128), model)
      .input("language", sql.NVarChar(128), "typescript")
      .query<{ model_count: number; language_as_model_count: number; language_count: number }>(`
        SELECT
          (SELECT COUNT(*) FROM portal.dim_model WHERE model_key = @model) AS model_count,
          (SELECT COUNT(*) FROM portal.dim_model WHERE model_key = @language) AS language_as_model_count,
          (SELECT COUNT(*) FROM portal.dim_language WHERE language_key = @language) AS language_count`))
      .recordset[0];

    expect(dimensions).toEqual({ model_count: 1, language_as_model_count: 0, language_count: 1 });
  });

  it("rolls back fact publication and checkpoint changes after a real SQL failure", async () => {
    const triggerName = `trg_metrics_loader_fail_${process.pid}`;
    await pool.request().query(`
      CREATE TRIGGER portal.[${triggerName}] ON portal.agg_daily_usage AFTER INSERT
      AS BEGIN THROW 51000, 'controlled integration failure', 1; END`);
    const events: Record<string, string | number>[] = [];
    try {
      const input = newInput(ndjson([userIds[0]!], { private_marker: "example-private-marker@example.invalid" }));
      await expect(loadMetricsDay(input, { sqlConfig, blobContainer, logger: { info: (event) => events.push(event), error: (event) => events.push(event) } }))
        .rejects.toThrow();
      expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(0);
      expect(await count("SELECT COUNT(*) AS count FROM portal.SourceCheckpoint WHERE scope_key = @value", "value", sql.NVarChar(100), scopeKey)).toBe(0);
      const run = (await pool.request().input("runId", sql.UniqueIdentifier, input.runId)
        .query<{ status: string }>("SELECT status FROM portal.IngestionRun WHERE run_id = @runId")).recordset[0];
      expect(run?.status).toBe("failed");
      const auditRows = await count("SELECT COUNT(*) AS count FROM portal.IngestionAuditEvent WHERE run_id = @value", "value", sql.UniqueIdentifier, input.runId);
      expect(auditRows).toBe(0);
      expect(JSON.stringify(events)).not.toContain("example-private-marker@example.invalid");
    } finally {
      await pool.request().query(`DROP TRIGGER portal.[${triggerName}]`);
    }
  });

  it("quarantines invalid UTF-8 without altering or publishing the archived bytes", async () => {
    const payload = Buffer.from(ndjson([userIds[0]!]));
    const loginIndex = payload.indexOf(Buffer.from(`example-user-${userIds[0]}`));
    expect(loginIndex).toBeGreaterThanOrEqual(0);
    payload[loginIndex] = 0xff;
    const input = newInput(payload);
    const result = await loadMetricsDay(input, { sqlConfig, blobContainer });

    expect(result.status).toBe("quarantined");
    expect(await blobContainer.getBlobClient(result.blobPath).downloadToBuffer()).toEqual(payload);
    const artifact = (await pool.request().input("runId", sql.UniqueIdentifier, input.runId).query<{ sha256: string }>(
      "SELECT sha256 FROM portal.SourceArtifact WHERE run_id = @runId",
    )).recordset[0];
    expect(artifact?.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    const issue = (await pool.request().input("runId", sql.UniqueIdentifier, input.runId).query<{ severity: string; error_code: string }>(
      "SELECT TOP (1) severity, error_code FROM portal.ValidationIssue WHERE run_id = @runId ORDER BY issue_id DESC",
    )).recordset[0];
    expect(issue).toEqual({ severity: "fatal", error_code: "malformed_json" });
    expect(await count("SELECT COUNT(*) AS count FROM portal.fact_user_daily_usage WHERE organization_id = @value", "value", sql.BigInt, orgId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM portal.SourceCheckpoint WHERE scope_key = @value", "value", sql.NVarChar(100), scopeKey)).toBe(0);
  });

  it("fails fast on the SQL per-day application lock without advancing the checkpoint", async () => {
    const resource = `ingest:users_1_day:${orgId}:${reportDay}`;
    const holder = await new sql.ConnectionPool({ ...sqlConfig, pool: { min: 1, max: 1 } }).connect();
    try {
      const acquired = await holder.request().input("resource", sql.NVarChar(255), resource).query<{ result: number }>(`
        DECLARE @result INT;
        EXEC @result = sys.sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
        SELECT @result AS result`);
      expect(Number(acquired.recordset[0]?.result)).toBeGreaterThanOrEqual(0);
      const input = newInput(ndjson([userIds[0]!]));
      await expect(loadMetricsDay(input, { sqlConfig, blobContainer })).rejects.toThrow("DAY_LOCK_TIMEOUT");
      expect(await count("SELECT COUNT(*) AS count FROM portal.SourceCheckpoint WHERE scope_key = @value", "value", sql.NVarChar(100), scopeKey)).toBe(0);
      expect(await count("SELECT COUNT(*) AS count FROM portal.SourceArtifact WHERE run_id = @value", "value", sql.UniqueIdentifier, input.runId)).toBe(0);
      expect(await count("SELECT COUNT(*) AS count FROM portal.stg_user_daily WHERE run_id = @value", "value", sql.UniqueIdentifier, input.runId)).toBe(0);
      const run = (await pool.request().input("runId", sql.UniqueIdentifier, input.runId)
        .query<{ status: string; error_code: string }>("SELECT status, error_code FROM portal.IngestionRun WHERE run_id = @runId")).recordset[0];
      expect(run).toEqual({ status: "failed", error_code: "day_lock_timeout" });
    } finally {
      await holder.request().input("resource", sql.NVarChar(255), resource)
        .query("EXEC sys.sp_releaseapplock @Resource = @resource, @LockOwner = 'Session'");
      await holder.close();
    }
  });
});
