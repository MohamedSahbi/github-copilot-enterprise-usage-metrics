// Local-stack-only data. This module is deliberately isolated from deployment, function, and Terraform code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sql from "mssql";
import { AUTH_OBJECTS_BY_PERSONA, AUTH_PRINCIPALS_BY_PERSONA, seedAuth } from "../integration/auth-seed";
import type {
  StgAiCreditLineRow,
  StgUserBreakdownRow,
  StgUserDailyRow,
  StgUserFamilyCountRow,
} from "../../shared/src/rows";
import { mapUsersDayLine, parseAiCreditCsv, createStagingContext } from "../contracts/reference/staging";
import { ORGS, WINDOW } from "../contracts/synthetic";
import { assertLocalHost, FIXTURE_BLOB_CONTAINER, sha256Hex } from "./config";

const FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "synthetic");
const USAGE_FIXTURE = "users-1-day.ndjson";
const AI_CREDIT_FIXTURE = "ai-credit.csv";
const TRANSFORM_VERSION = "1";

export const TEST_CURATED_RUN_IDS = {
  usage: "00000000-0000-4000-8000-0000000000c2",
  aiCredits: "00000000-0000-4000-8000-0000000000c3",
} as const;

export const TEST_CURATED_DIRECTORY_SYNC_SOURCES = ["scim", "graph", "seats", "csv"] as const;

export const TEST_CURATED_EXPECTED_COUNTS = {
  users: 9,
  organizations: 2,
  usageFacts: 45,
  aiCreditFacts: 18,
  smallGroupUsers: 2,
  minimumGroupSize: 5,
} as const;

export const TEST_CURATED_SCOPE_ASSIGNMENTS: Readonly<Record<number, {
  managerUserId: number | null;
  department: string;
  businessArea: string;
}>> = {
  1000001: { managerUserId: null, department: "department-a", businessArea: "business-area-a" },
  1000003: { managerUserId: 1000001, department: "department-a", businessArea: "business-area-a" },
  1000004: { managerUserId: null, department: "department-small", businessArea: "business-area-small" },
  1000006: { managerUserId: null, department: "department-b", businessArea: "business-area-b" },
  1000007: { managerUserId: 1000003, department: "department-a", businessArea: "business-area-a" },
  1000008: { managerUserId: null, department: "department-small", businessArea: "business-area-small" },
  1000009: { managerUserId: null, department: "department-a", businessArea: "business-area-a" },
  1000011: { managerUserId: null, department: "department-a", businessArea: "business-area-a" },
  1000012: { managerUserId: null, department: "department-b", businessArea: "business-area-b" },
};

const legacyPersonaPrincipalIds = {
  admin: "30000000-0000-4000-8000-000000000001",
  manager: "30000000-0000-4000-8000-000000000002",
  member: "30000000-0000-4000-8000-000000000003",
  "no-access": "30000000-0000-4000-8000-000000000004",
} as const;

export const TEST_CURATED_PERSONAS = {
  admin: { principalId: AUTH_PRINCIPALS_BY_PERSONA.admin, entraObjectId: AUTH_OBJECTS_BY_PERSONA.admin, userId: 1000004, role: "admin", scope: "company" },
  manager: { principalId: AUTH_PRINCIPALS_BY_PERSONA.manager, entraObjectId: AUTH_OBJECTS_BY_PERSONA.manager, userId: 1000001, role: "manager", scope: "team" },
  member: { principalId: AUTH_PRINCIPALS_BY_PERSONA.member, entraObjectId: AUTH_OBJECTS_BY_PERSONA.member, userId: 1000006, role: "user", scope: "self" },
  "no-access": { principalId: AUTH_PRINCIPALS_BY_PERSONA["no-access"], entraObjectId: AUTH_OBJECTS_BY_PERSONA["no-access"], userId: 1000012, scope: "none" },
} as const;

const personaObjectIdsByUserId = new Map<number, string>(
  Object.values(TEST_CURATED_PERSONAS).map((persona) => [persona.userId, persona.entraObjectId]),
);

export interface TestCuratedSeedResult {
  usageFacts: number;
  breakdownFacts: number;
  familyFacts: number;
  usageAggregates: number;
  aiCreditFacts: number;
  aiCreditAggregates: number;
  users: number;
  organizations: number;
}

interface UserDirectoryRow {
  user_id: number;
  login: string | null;
  organization_id: number;
  first_seen_day: string;
  last_seen_day: string;
}

interface SeedArtifact {
  runId: string;
  artifactId: number;
}

function entraObjectId(userId: number): string {
  return personaObjectIdsByUserId.get(userId) ?? `10000000-0000-4000-8000-${String(userId).padStart(12, "0")}`;
}

function readFixture(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), "utf8");
}

function insertPlaceholders(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `@${prefix}${index}`).join(", ");
}

async function createRunAndArtifact(
  tx: sql.Transaction,
  runId: string,
  sourceKind: "users_1_day" | "ai_credit",
  file: string,
  contents: string,
  rowCount: number,
): Promise<SeedArtifact> {
  const runRequest = new sql.Request(tx)
    .input("run", sql.UniqueIdentifier, runId)
    .input("source", sql.VarChar(40), sourceKind)
    .input("scope", sql.NVarChar(100), "example-enterprise")
    .input("start", sql.Date, WINDOW.start)
    .input("end", sql.Date, WINDOW.end)
    .input("version", sql.VarChar(32), TRANSFORM_VERSION)
    .input("rows", sql.Int, rowCount);
  await runRequest.query(`
    INSERT INTO portal.IngestionRun
      (run_id, source_kind, scope_key, range_start, range_end, status, is_current, transform_version,
       rows_read, rows_loaded, rows_quarantined, completed_at)
    VALUES (@run, @source, @scope, @start, @end, 'published', 0, @version, @rows, @rows, 0, SYSUTCDATETIME())`);

  const artifactRequest = new sql.Request(tx)
    .input("run", sql.UniqueIdentifier, runId)
    .input("container", sql.NVarChar(63), FIXTURE_BLOB_CONTAINER)
    .input("path", sql.NVarChar(600), `test-only/curated/${file}`)
    .input("sha", sql.Char(64), sha256Hex(contents))
    .input("size", sql.BigInt, Buffer.byteLength(contents))
    .input("rows", sql.Int, rowCount);
  const artifact = await artifactRequest.query<{ artifact_id: number }>(`
    INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes, row_count)
    OUTPUT INSERTED.artifact_id
    VALUES (@run, @container, @path, @sha, @size, @rows)`);
  const artifactId = Number(artifact.recordset[0]?.artifact_id);
  if (!Number.isSafeInteger(artifactId)) throw new Error(`Could not create test-only artifact for ${file}`);
  return { runId, artifactId };
}

async function insertJsonRows(
  tx: sql.Transaction,
  table: string,
  columns: string,
  schema: string,
  rows: readonly object[],
): Promise<void> {
  if (rows.length === 0) return;
  await new sql.Request(tx)
    .input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
    .query(`INSERT INTO portal.${table} (${columns}) SELECT ${columns} FROM OPENJSON(@rows) WITH (${schema})`);
}

async function clearPreviousSeed(tx: sql.Transaction): Promise<void> {
  const usage = TEST_CURATED_RUN_IDS.usage;
  const credits = TEST_CURATED_RUN_IDS.aiCredits;
  const syncRequest = new sql.Request(tx);
  TEST_CURATED_DIRECTORY_SYNC_SOURCES.forEach((source, index) => syncRequest.input(`source${index}`, sql.VarChar(16), source));
  await syncRequest.query(`DELETE FROM portal.DirectorySyncState WHERE source IN (${insertPlaceholders(
    TEST_CURATED_DIRECTORY_SYNC_SOURCES.length, "source",
  )})`);
  for (const table of ["agg_daily_usage", "agg_ai_credit_daily", "fact_usage_family_count", "fact_usage_breakdown", "fact_user_daily_usage", "fact_ai_credit_line"] as const) {
    await new sql.Request(tx)
      .input("usage", sql.UniqueIdentifier, usage)
      .input("credits", sql.UniqueIdentifier, credits)
      .query(`DELETE FROM portal.${table} WHERE run_id IN (@usage, @credits)`);
  }

  const principalIds = Object.values(legacyPersonaPrincipalIds);
  const principalRequest = new sql.Request(tx);
  principalIds.forEach((id, index) => principalRequest.input(`p${index}`, sql.UniqueIdentifier, id));
  const principals = insertPlaceholders(principalIds.length, "p");
  await principalRequest.query(`DELETE FROM portal.AccessGrant WHERE principal_id IN (${principals})`);
  const identityRequest = new sql.Request(tx);
  principalIds.forEach((id, index) => identityRequest.input(`p${index}`, sql.UniqueIdentifier, id));
  await identityRequest.query(`DELETE FROM portal.PrincipalIdentity WHERE principal_id IN (${principals})`);
  const principalDeleteRequest = new sql.Request(tx);
  principalIds.forEach((id, index) => principalDeleteRequest.input(`p${index}`, sql.UniqueIdentifier, id));
  await principalDeleteRequest.query(`DELETE FROM portal.Principal WHERE principal_id IN (${principals})`);

  const userIds = Object.keys(TEST_CURATED_SCOPE_ASSIGNMENTS).map(Number);
  const userRequest = new sql.Request(tx);
  userIds.forEach((id, index) => userRequest.input(`u${index}`, sql.BigInt, id));
  const users = insertPlaceholders(userIds.length, "u");
  await userRequest.query(`DELETE FROM portal.dim_user_login_history WHERE user_id IN (${users})`);
  await userRequest.query(`DELETE FROM portal.dim_user WHERE user_id IN (${users})`);

  const orgRequest = new sql.Request(tx);
  ORGS.forEach((org, index) => orgRequest.input(`o${index}`, sql.BigInt, Number(org.id)));
  await orgRequest.query(`DELETE FROM portal.dim_organization WHERE organization_id IN (${insertPlaceholders(ORGS.length, "o")})`);
  await new sql.Request(tx)
    .input("usage", sql.UniqueIdentifier, usage)
    .input("credits", sql.UniqueIdentifier, credits)
    .query("DELETE FROM portal.SourceArtifact WHERE run_id IN (@usage, @credits)");
  await new sql.Request(tx)
    .input("usage", sql.UniqueIdentifier, usage)
    .input("credits", sql.UniqueIdentifier, credits)
    .query("DELETE FROM portal.IngestionRun WHERE run_id IN (@usage, @credits)");
}

export async function seedTestOnlyCuratedData(connectionString: string): Promise<TestCuratedSeedResult> {
  assertLocalHost(connectionString);
  const usageContents = readFixture(USAGE_FIXTURE);
  const creditContents = readFixture(AI_CREDIT_FIXTURE);
  const usageLines = usageContents.split("\n").filter(Boolean);
  if (usageLines.length === 0) throw new Error("The test-only usage fixture is empty");

  const pool = await new sql.ConnectionPool(connectionString).connect();
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    try {
      await clearPreviousSeed(tx);
      const usageArtifact = await createRunAndArtifact(
        tx, TEST_CURATED_RUN_IDS.usage, "users_1_day", USAGE_FIXTURE, usageContents, usageLines.length,
      );
      const usageContext = createStagingContext(usageArtifact.runId, WINDOW);
      const usageRows: StgUserDailyRow[] = [];
      const breakdownRows: Array<StgUserBreakdownRow & Pick<StgUserDailyRow, "organization_id" | "user_id" | "usage_day">> = [];
      const familyRows: Array<StgUserFamilyCountRow & Pick<StgUserDailyRow, "organization_id" | "user_id" | "usage_day">> = [];
      for (const [index, line] of usageLines.entries()) {
        const mapped = mapUsersDayLine(line, index + 1, usageContext, usageArtifact.artifactId);
        if (!mapped.loaded || !mapped.daily) {
          const codes = mapped.issues.map((issue) => issue.error_code).join(", ");
          throw new Error(`The test-only usage fixture contains a rejected line (${index + 1}: ${codes})`);
        }
        usageRows.push(mapped.daily);
        breakdownRows.push(...mapped.breakdown.map((row) => ({
          ...row,
          organization_id: mapped.daily!.organization_id,
          user_id: mapped.daily!.user_id,
          usage_day: mapped.daily!.usage_day,
        })));
        familyRows.push(...mapped.families.map((row) => ({
          ...row,
          organization_id: mapped.daily!.organization_id,
          user_id: mapped.daily!.user_id,
          usage_day: mapped.daily!.usage_day,
        })));
      }

      const creditPreview = parseAiCreditCsv(creditContents, TEST_CURATED_RUN_IDS.aiCredits, 1);
      if (creditPreview.issues.length > 0 || creditPreview.rows.length === 0) {
        throw new Error(`The test-only AI Credits fixture could not be parsed (${creditPreview.issues.length} issues)`);
      }
      const creditArtifact = await createRunAndArtifact(
        tx, TEST_CURATED_RUN_IDS.aiCredits, "ai_credit", AI_CREDIT_FIXTURE, creditContents, creditPreview.rows.length,
      );
      const creditResult = parseAiCreditCsv(creditContents, creditArtifact.runId, creditArtifact.artifactId);

      const usersById = new Map<number, UserDirectoryRow>();
      const organizationIds = new Set<number>();
      for (const row of usageRows) {
        organizationIds.add(row.organization_id);
        const current = usersById.get(row.user_id);
        if (current) {
          if (current.organization_id !== row.organization_id || current.login !== row.user_login) {
            throw new Error(`Synthetic user ${row.user_id} has inconsistent fixture dimensions`);
          }
          if (row.usage_day < current.first_seen_day) current.first_seen_day = row.usage_day;
          if (row.usage_day > current.last_seen_day) current.last_seen_day = row.usage_day;
        } else {
          usersById.set(row.user_id, {
            user_id: row.user_id,
            login: row.user_login,
            organization_id: row.organization_id,
            first_seen_day: row.usage_day,
            last_seen_day: row.usage_day,
          });
        }
      }
      if (Object.keys(TEST_CURATED_SCOPE_ASSIGNMENTS).some((id) => !usersById.has(Number(id)))) {
        throw new Error("The test-only fixture user set no longer matches its curated scope plan");
      }
      if ([...organizationIds].sort().join(",") !== ORGS.map((org) => Number(org.id)).sort().join(",")) {
        throw new Error("The test-only fixture organizations no longer match the curated seed plan");
      }

      for (const organization of ORGS) {
        await new sql.Request(tx)
          .input("id", sql.BigInt, Number(organization.id))
          .input("login", sql.NVarChar(255), organization.login)
          .query("INSERT INTO portal.dim_organization (organization_id, login) VALUES (@id, @login)");
      }

      for (const user of usersById.values()) {
        const assignment = TEST_CURATED_SCOPE_ASSIGNMENTS[user.user_id];
        if (!assignment || user.login === null) throw new Error(`Synthetic user ${user.user_id} is missing a scope assignment or login`);
        const managerId = assignment.managerUserId;
        await new sql.Request(tx)
          .input("id", sql.BigInt, user.user_id)
          .input("login", sql.NVarChar(255), user.login)
          .input("entra", sql.UniqueIdentifier, entraObjectId(user.user_id))
          .input("manager", sql.UniqueIdentifier, managerId === null ? null : entraObjectId(managerId))
          .input("managerEmail", sql.NVarChar(320), managerId === null ? null : `manager-${managerId}@example.com`)
          .input("department", sql.NVarChar(100), assignment.department)
          .input("area", sql.NVarChar(50), assignment.businessArea)
          .input("first", sql.Date, user.first_seen_day)
          .input("last", sql.Date, user.last_seen_day)
          .query(`
            INSERT INTO portal.dim_user
              (user_id, login, entra_object_id, manager_entra_object_id, manager_email, department, business_area,
               first_seen_day, last_seen_day)
            VALUES (@id, @login, @entra, @manager, @managerEmail, @department, @area, @first, @last)`);
        await new sql.Request(tx)
          .input("id", sql.BigInt, user.user_id)
          .input("login", sql.NVarChar(255), user.login)
          .input("first", sql.Date, user.first_seen_day)
          .input("last", sql.Date, user.last_seen_day)
          .query(`
            INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day)
            VALUES (@id, @login, @first, @last)`);
      }

      await seedAuth(tx);
      for (const source of TEST_CURATED_DIRECTORY_SYNC_SOURCES) {
        await new sql.Request(tx)
          .input("source", sql.VarChar(16), source)
          .query(`
            UPDATE portal.DirectorySyncState
            SET last_success_at = DATEADD(second, -1, SYSUTCDATETIME()), last_attempt_at = SYSUTCDATETIME(), last_error_code = NULL
            WHERE source = @source;
            IF @@ROWCOUNT = 0
              INSERT INTO portal.DirectorySyncState (source, last_success_at, last_attempt_at, last_error_code)
              VALUES (@source, DATEADD(second, -1, SYSUTCDATETIME()), SYSUTCDATETIME(), NULL);`);
      }

      const userFactRows = usageRows.map((row) => ({
        organization_id: row.organization_id,
        user_id: row.user_id,
        usage_day: row.usage_day,
        interaction_count: row.interaction_count,
        code_generation_count: row.code_generation_count,
        code_acceptance_count: row.code_acceptance_count,
        loc_suggested_to_add: row.loc_suggested_to_add,
        loc_suggested_to_delete: row.loc_suggested_to_delete,
        loc_added: row.loc_added,
        loc_deleted: row.loc_deleted,
        used_agent: row.used_agent,
        used_chat: row.used_chat,
        used_cli: row.used_cli,
        used_coding_agent: row.used_coding_agent,
        used_cloud_agent: row.used_cloud_agent,
        used_copilot_app: row.used_copilot_app,
        used_vscode_agent: row.used_vscode_agent,
        used_code_review_active: row.used_code_review_active,
        used_code_review_passive: row.used_code_review_passive,
        ai_credits_used: row.ai_credits_used,
        ai_adoption_phase_number: row.ai_adoption_phase_number,
        ai_adoption_phase: row.ai_adoption_phase,
        extra_json: row.extra_json,
        run_id: usageArtifact.runId,
        source_artifact_id: usageArtifact.artifactId,
        transform_version: TRANSFORM_VERSION,
      }));
      await insertJsonRows(tx, "fact_user_daily_usage",
        "organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli, used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active, used_code_review_passive, ai_credits_used, ai_adoption_phase_number, ai_adoption_phase, extra_json, run_id, source_artifact_id, transform_version",
        "organization_id BIGINT, user_id BIGINT, usage_day DATE, interaction_count INT, code_generation_count INT, code_acceptance_count INT, loc_suggested_to_add BIGINT, loc_suggested_to_delete BIGINT, loc_added BIGINT, loc_deleted BIGINT, used_agent BIT, used_chat BIT, used_cli BIT, used_coding_agent BIT, used_cloud_agent BIT, used_copilot_app BIT, used_vscode_agent BIT, used_code_review_active BIT, used_code_review_passive BIT, ai_credits_used DECIMAL(18,9), ai_adoption_phase_number TINYINT, ai_adoption_phase VARCHAR(64), extra_json NVARCHAR(MAX), run_id UNIQUEIDENTIFIER, source_artifact_id BIGINT, transform_version VARCHAR(32)",
        userFactRows);

      const breakdownFactRows = breakdownRows.map((row) => ({
        organization_id: row.organization_id,
        user_id: row.user_id,
        usage_day: row.usage_day,
        breakdown_kind: row.breakdown_kind,
        key_1: row.key_1,
        key_2: row.key_2,
        interaction_count: row.interaction_count,
        code_generation_count: row.code_generation_count,
        code_acceptance_count: row.code_acceptance_count,
        loc_suggested_to_add: row.loc_suggested_to_add,
        loc_suggested_to_delete: row.loc_suggested_to_delete,
        loc_added: row.loc_added,
        loc_deleted: row.loc_deleted,
        session_count: row.session_count,
        request_count: row.request_count,
        prompt_tokens: row.prompt_tokens,
        output_tokens: row.output_tokens,
        version_info: row.version_info,
        run_id: usageArtifact.runId,
        source_artifact_id: usageArtifact.artifactId,
        transform_version: TRANSFORM_VERSION,
      }));
      await insertJsonRows(tx, "fact_usage_breakdown",
        "organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, session_count, request_count, prompt_tokens, output_tokens, version_info, run_id, source_artifact_id, transform_version",
        "organization_id BIGINT, user_id BIGINT, usage_day DATE, breakdown_kind VARCHAR(24), key_1 NVARCHAR(128), key_2 NVARCHAR(128), interaction_count INT, code_generation_count INT, code_acceptance_count INT, loc_suggested_to_add BIGINT, loc_suggested_to_delete BIGINT, loc_added BIGINT, loc_deleted BIGINT, session_count INT, request_count INT, prompt_tokens BIGINT, output_tokens BIGINT, version_info NVARCHAR(1000), run_id UNIQUEIDENTIFIER, source_artifact_id BIGINT, transform_version VARCHAR(32)",
        breakdownFactRows);

      const familyFactRows = familyRows.map((row) => ({
        organization_id: row.organization_id,
        user_id: row.user_id,
        usage_day: row.usage_day,
        family: row.family,
        item_name: row.item_name,
        interaction_count: row.interaction_count,
        run_id: usageArtifact.runId,
        source_artifact_id: usageArtifact.artifactId,
        transform_version: TRANSFORM_VERSION,
      }));
      await insertJsonRows(tx, "fact_usage_family_count",
        "organization_id, user_id, usage_day, family, item_name, interaction_count, run_id, source_artifact_id, transform_version",
        "organization_id BIGINT, user_id BIGINT, usage_day DATE, family VARCHAR(16), item_name NVARCHAR(256), interaction_count INT, run_id UNIQUEIDENTIFIER, source_artifact_id BIGINT, transform_version VARCHAR(32)",
        familyFactRows);

      const creditFactRows: Array<Record<string, string | number | null>> = creditResult.rows.map((row: StgAiCreditLineRow) => {
        const user = [...usersById.values()].find((candidate) => candidate.login === row.username);
        return {
          usage_date: row.usage_date,
          organization_login: row.organization,
          username: row.username,
          model: row.model,
          cost_center_name: row.cost_center_name,
          repository: row.repository,
          app_client_id: row.app_client_id,
          organization_id: user?.organization_id ?? null,
          user_id: user?.user_id ?? null,
          product: row.product,
          sku: row.sku,
          quantity: row.quantity,
          unit_type: row.unit_type,
          applied_cost_per_quantity: row.applied_cost_per_quantity,
          gross_amount: row.gross_amount,
          discount_amount: row.discount_amount,
          net_amount: row.net_amount,
          total_monthly_quota: row.total_monthly_quota,
          aic_quantity: row.aic_quantity,
          aic_gross_amount: row.aic_gross_amount,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          cache_read_tokens: row.cache_read_tokens,
          cache_write_tokens: row.cache_write_tokens,
          run_id: creditArtifact.runId,
          source_artifact_id: creditArtifact.artifactId,
          transform_version: TRANSFORM_VERSION,
        };
      });
      await insertJsonRows(tx, "fact_ai_credit_line",
        "usage_date, organization_login, username, model, cost_center_name, repository, app_client_id, organization_id, user_id, product, sku, quantity, unit_type, applied_cost_per_quantity, gross_amount, discount_amount, net_amount, total_monthly_quota, aic_quantity, aic_gross_amount, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, run_id, source_artifact_id, transform_version",
        "usage_date DATE, organization_login NVARCHAR(255), username NVARCHAR(255), model NVARCHAR(128), cost_center_name NVARCHAR(255), repository NVARCHAR(255), app_client_id NVARCHAR(128), organization_id BIGINT, user_id BIGINT, product NVARCHAR(64), sku NVARCHAR(128), quantity DECIMAL(18,9), unit_type NVARCHAR(32), applied_cost_per_quantity DECIMAL(18,9), gross_amount DECIMAL(18,9), discount_amount DECIMAL(18,9), net_amount DECIMAL(18,9), total_monthly_quota DECIMAL(18,9), aic_quantity DECIMAL(18,9), aic_gross_amount DECIMAL(18,9), input_tokens BIGINT, output_tokens BIGINT, cache_read_tokens BIGINT, cache_write_tokens BIGINT, run_id UNIQUEIDENTIFIER, source_artifact_id BIGINT, transform_version VARCHAR(32)",
        creditFactRows);

      await new sql.Request(tx).input("run", sql.UniqueIdentifier, usageArtifact.runId).query(`
        INSERT INTO portal.dim_date (date_key, year_num, month_num, day_of_month, iso_week, day_of_week, month_start)
        SELECT source.usage_day, YEAR(source.usage_day), MONTH(source.usage_day), DAY(source.usage_day),
               DATEPART(ISO_WEEK, source.usage_day), (DATEDIFF(DAY, CONVERT(DATE, '19000101'), source.usage_day) % 7) + 1,
               DATEFROMPARTS(YEAR(source.usage_day), MONTH(source.usage_day), 1)
        FROM (SELECT DISTINCT usage_day FROM portal.fact_user_daily_usage WHERE run_id = @run) AS source
        WHERE NOT EXISTS (SELECT 1 FROM portal.dim_date AS d WHERE d.date_key = source.usage_day)`);

      await new sql.Request(tx).input("run", sql.UniqueIdentifier, usageArtifact.runId).query(`
        INSERT INTO portal.dim_feature (feature_key, label, is_chat, is_agent, is_cli, is_known)
        SELECT DISTINCT key_1, key_1,
          CONVERT(BIT, CASE WHEN key_1 LIKE N'chat[_]%' THEN 1 ELSE 0 END),
          CONVERT(BIT, CASE WHEN key_1 LIKE N'%agent%' THEN 1 ELSE 0 END),
          CONVERT(BIT, CASE WHEN key_1 = N'copilot_cli' THEN 1 ELSE 0 END), 1
        FROM portal.fact_usage_breakdown AS b
        WHERE run_id = @run AND breakdown_kind = 'feature'
          AND NOT EXISTS (SELECT 1 FROM portal.dim_feature f WHERE f.feature_key = b.key_1)`);
      await new sql.Request(tx).input("run", sql.UniqueIdentifier, usageArtifact.runId).query(`
        INSERT INTO portal.dim_model (model_key, label, is_known)
        SELECT model_key, model_key, 1 FROM (
          SELECT key_1 AS model_key FROM portal.fact_usage_breakdown WHERE run_id = @run AND breakdown_kind = 'model_feature'
          UNION
          SELECT key_2 FROM portal.fact_usage_breakdown WHERE run_id = @run AND breakdown_kind = 'language_model'
        ) AS models
        WHERE NOT EXISTS (SELECT 1 FROM portal.dim_model m WHERE m.model_key = models.model_key)`);
      await new sql.Request(tx).input("run", sql.UniqueIdentifier, usageArtifact.runId).query(`
        INSERT INTO portal.dim_language (language_key, label)
        SELECT DISTINCT b.key_1, b.key_1 FROM portal.fact_usage_breakdown AS b
        WHERE b.run_id = @run AND b.breakdown_kind IN ('language_feature', 'language_model')
          AND NOT EXISTS (SELECT 1 FROM portal.dim_language l WHERE l.language_key = b.key_1)`);

      // The real metrics loader (#73) owns these definitions; test data must not encode approximations.
      await new sql.Request(tx)
        .input("run", sql.UniqueIdentifier, usageArtifact.runId)
        .input("version", sql.VarChar(32), TRANSFORM_VERSION)
        .query(`
        INSERT INTO portal.agg_daily_usage
          (organization_id, usage_day, group_kind, group_key, metric_version, user_count, interaction_count,
           code_generation_count, code_acceptance_count, loc_added, loc_deleted, chat_users, agent_users, cli_users,
           cloud_agent_users, vscode_agent_users, app_users, code_review_users, advanced_users, completion_only_users,
           ai_credits_used, run_id, transform_version)
        SELECT organization_id, usage_day, 'organization', N'', 1, COUNT(DISTINCT user_id), SUM(interaction_count),
          SUM(code_generation_count), SUM(code_acceptance_count), SUM(loc_added), SUM(loc_deleted),
          SUM(CONVERT(INT, used_chat)), SUM(CONVERT(INT, used_agent)), SUM(CONVERT(INT, used_cli)),
          SUM(CONVERT(INT, used_cloud_agent)), SUM(CONVERT(INT, used_vscode_agent)), SUM(CONVERT(INT, used_copilot_app)),
          SUM(CONVERT(INT, CASE WHEN used_code_review_active = 1 OR used_code_review_passive = 1 THEN 1 ELSE 0 END)),
          0, 0,
          SUM(ai_credits_used), @run, @version
        FROM portal.fact_user_daily_usage
        WHERE run_id = @run
        GROUP BY organization_id, usage_day`);
      await new sql.Request(tx)
        .input("run", sql.UniqueIdentifier, usageArtifact.runId)
        .input("version", sql.VarChar(32), TRANSFORM_VERSION)
        .query(`
          INSERT INTO portal.agg_daily_usage
            (organization_id, usage_day, group_kind, group_key, metric_version, user_count, interaction_count,
             code_generation_count, code_acceptance_count, loc_added, loc_deleted, chat_users, agent_users, cli_users,
             cloud_agent_users, vscode_agent_users, app_users, code_review_users, advanced_users, completion_only_users,
             ai_credits_used, run_id, transform_version)
          SELECT b.organization_id, b.usage_day,
            CASE WHEN b.breakdown_kind = 'language_feature' THEN 'language'
                 WHEN b.breakdown_kind = 'model_feature' THEN 'model'
                 ELSE b.breakdown_kind END,
            b.key_1,
            1, COUNT(DISTINCT b.user_id), SUM(b.interaction_count), SUM(b.code_generation_count),
            SUM(b.code_acceptance_count), SUM(b.loc_added), SUM(b.loc_deleted),
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, @run, @version
          FROM portal.fact_usage_breakdown AS b
          WHERE b.run_id = @run AND b.breakdown_kind <> 'language_model'
          GROUP BY b.organization_id, b.usage_day,
            CASE WHEN b.breakdown_kind = 'language_feature' THEN 'language'
                 WHEN b.breakdown_kind = 'model_feature' THEN 'model'
                 ELSE b.breakdown_kind END,
            b.key_1`);

      await new sql.Request(tx)
        .input("run", sql.UniqueIdentifier, creditArtifact.runId)
        .input("version", sql.VarChar(32), TRANSFORM_VERSION)
        .query(`
          INSERT INTO portal.agg_ai_credit_daily
            (organization_login, usage_date, model, cost_center_name, metric_version, user_count,
             aic_quantity, aic_gross_amount, net_amount, run_id, transform_version)
          SELECT organization_login, usage_date, model, cost_center_name, 1, COUNT(DISTINCT user_id),
                 SUM(COALESCE(aic_quantity, 0)), SUM(COALESCE(aic_gross_amount, 0)),
                 SUM(COALESCE(net_amount, 0)), @run, @version
          FROM portal.fact_ai_credit_line
          WHERE run_id = @run
          GROUP BY organization_login, usage_date, model, cost_center_name`);

      await tx.commit();
      const usageAggregates = await new sql.Request(pool)
        .input("run", sql.UniqueIdentifier, usageArtifact.runId)
        .query<{ n: number }>("SELECT COUNT(*) AS n FROM portal.agg_daily_usage WHERE run_id = @run");
      const aiAggregates = await new sql.Request(pool)
        .input("run", sql.UniqueIdentifier, creditArtifact.runId)
        .query<{ n: number }>("SELECT COUNT(*) AS n FROM portal.agg_ai_credit_daily WHERE run_id = @run");
      return {
        usageFacts: usageRows.length,
        breakdownFacts: breakdownRows.length,
        familyFacts: familyRows.length,
        usageAggregates: Number(usageAggregates.recordset[0]?.n ?? 0),
        aiCreditFacts: creditResult.rows.length,
        aiCreditAggregates: Number(aiAggregates.recordset[0]?.n ?? 0),
        users: usersById.size,
        organizations: ORGS.length,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  } finally {
    await pool.close();
  }
}
