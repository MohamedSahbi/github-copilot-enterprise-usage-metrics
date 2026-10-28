import sql from "mssql";
import { readAccessSettings } from "../auth/settings";
import { getPortalSqlPool } from "../db/pool";
import { resolveAccess } from "../authz/access";
import type { AccessResult, Identity } from "../authz/access";
import { SqlAccessRepository } from "../authz/sql-access";
import { validateBudgetLookupTarget } from "../../../shared/src/budget";
import type { ApiErrorCode, BudgetLookupRequest } from "../../../shared/src/api";

type BudgetAccessState = "unauthenticated" | "forbidden" | "permissions_unavailable";

export type BudgetLookupAccess =
  | { state: BudgetAccessState }
  | { state: "denied"; code: ApiErrorCode }
  | { state: "authorized"; userId: number; login: string };

interface LatestDirectoryRun {
  run_id: string;
  scope_key: string;
  status: string;
  error_code: string | null;
  started_at: Date;
  completed_at: Date | null;
}

interface DirectorySyncSource {
  source: string;
  last_success_at: Date | null;
  last_attempt_at: Date | null;
  last_error_code: string | null;
}

interface LinkedDirectoryUser {
  user_id: number | string | null;
  login: string | null;
  state: string | null;
}

export function logBudgetLookupAccessUnavailable(correlationId: string): void {
  process.stderr.write(`${JSON.stringify({
    level: "error",
    event: "portal.budget_lookup_permissions_unavailable",
    correlationId,
  })}\n`);
}

function readBudgetModuleEnabled(): boolean {
  const value = process.env.MODULE_BUDGET_LOOKUP;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("MODULE_BUDGET_LOOKUP must be true or false.");
}

async function rollback(transaction: sql.Transaction, correlationId: string): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    logBudgetLookupAccessUnavailable(correlationId);
  }
}

async function assertCompleteDirectoryPopulation(
  transaction: sql.Transaction,
  enterprise: string,
  sources: readonly string[],
  staleHours: number,
  now: Date,
): Promise<Date> {
  const latest = (await transaction.request()
    .query<LatestDirectoryRun>(`
      SELECT TOP (1) run_id, scope_key, status, error_code, started_at, completed_at
      FROM portal.IngestionRun WITH (INDEX(IX_IngestionRun_started), HOLDLOCK)
      WHERE source_kind = 'directory'
      ORDER BY started_at DESC, run_id DESC`)).recordset[0];
  if (!latest || latest.scope_key !== enterprise || latest.status !== "published" ||
      latest.error_code !== null || !latest.completed_at) {
    throw new Error("Latest directory run is not a complete publication for this deployment.");
  }
  const completedAt = latest.completed_at;
  const ageMs = now.getTime() - completedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < -500 || ageMs > staleHours * 3_600_000) {
    throw new Error("Latest directory publication is stale or has an invalid timestamp.");
  }

  const states = (await transaction.request()
    .query<DirectorySyncSource>(`
      SELECT source, last_success_at, last_attempt_at, last_error_code
      FROM portal.DirectorySyncState WITH (HOLDLOCK)`)).recordset;
  const bySource = new Map(states.map((state) => [state.source, state]));
  if (sources.some((source) => {
    const state = bySource.get(source);
    return !state || !state.last_success_at || !state.last_attempt_at ||
      state.last_error_code !== null ||
    state.last_success_at.getTime() !== completedAt.getTime() ||
    state.last_attempt_at.getTime() !== completedAt.getTime();
  })) {
    throw new Error("Configured directory sources do not match the latest complete publication.");
  }
  return completedAt;
}

async function readLinkedDirectoryUser(
  transaction: sql.Transaction,
  principalId: string,
  tenantId: string,
  objectId: string,
): Promise<LinkedDirectoryUser[]> {
  const result = await transaction.request()
    .input("principal", sql.UniqueIdentifier, principalId)
    .input("tenant", sql.UniqueIdentifier, tenantId)
    .input("oid", sql.UniqueIdentifier, objectId)
    .query<LinkedDirectoryUser>(`
      SELECT directory_user.user_id, directory_user.login, directory_user.state
      FROM portal.PrincipalLinkState AS link
        WITH (INDEX(UX_PrincipalLinkState_entra), HOLDLOCK)
      LEFT JOIN portal.dim_user AS directory_user WITH (HOLDLOCK)
        ON directory_user.user_id = link.github_user_id
      WHERE link.entra_tenant_id = @tenant
        AND link.entra_object_id = @oid
        AND link.unlinked_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM portal.Principal AS principal WITH (HOLDLOCK)
          WHERE principal.principal_id = @principal
            AND principal.status = 'active'
            AND principal.entra_tenant_id = @tenant
            AND principal.entra_object_id = @oid
        )`);
  return result.recordset;
}

async function readTargetDirectoryUser(
  transaction: sql.Transaction,
  userId: number,
): Promise<LinkedDirectoryUser[]> {
  const result = await transaction.request()
    .input("userId", sql.BigInt, userId)
    .query<LinkedDirectoryUser>(`
      SELECT user_id, login, state
      FROM portal.dim_user WITH (INDEX(PK_dim_user), HOLDLOCK)
      WHERE user_id = @userId`);
  return result.recordset;
}

async function assertUniqueCurrentLogin(
  transaction: sql.Transaction,
  userId: number,
  login: string,
): Promise<void> {
  const result = await transaction.request()
    .input("login", sql.NVarChar(39), login)
    .query<{ user_id: number | string }>(`
      SELECT TOP (2) user_id
      FROM portal.dim_user WITH (HOLDLOCK)
      WHERE state = 'active'
        AND LOWER(LTRIM(RTRIM(login))) = LOWER(@login)
      ORDER BY user_id`);
  if (result.recordset.length !== 1 || safeUserId(result.recordset[0]!.user_id) !== userId) {
    throw new Error("The current source login does not resolve uniquely to the authorized numeric identity.");
  }
}

function mapAccessState(access: Exclude<AccessResult, { state: "authorized" }>): BudgetLookupAccess {
  switch (access.state) {
    case "signed-out":
      return { state: "unauthenticated" };
    case "no-access":
      return { state: "forbidden" };
    case "unavailable":
      return { state: "permissions_unavailable" };
  }
}

function safeUserId(value: number | string | null): number | null {
  const id = typeof value === "number" ? value : value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function resolveBudgetLookupAccess(
  correlationId: string,
  identity: Identity | null,
  request: BudgetLookupRequest,
  now = new Date(),
): Promise<BudgetLookupAccess> {
  if (!identity) return { state: "unauthenticated" };

  let moduleEnabled: boolean;
  try {
    moduleEnabled = readBudgetModuleEnabled();
  } catch {
    logBudgetLookupAccessUnavailable(correlationId);
    return { state: "permissions_unavailable" };
  }
  if (!moduleEnabled) return { state: "denied", code: "module_disabled" };

  const enterprise = process.env.ENTERPRISE_SLUG;
  if (!enterprise) {
    logBudgetLookupAccessUnavailable(correlationId);
    return { state: "permissions_unavailable" };
  }

  let settings: ReturnType<typeof readAccessSettings>;
  let pool: Awaited<ReturnType<typeof getPortalSqlPool>>;
  try {
    settings = readAccessSettings();
    pool = await getPortalSqlPool();
  } catch {
    logBudgetLookupAccessUnavailable(correlationId);
    return { state: "permissions_unavailable" };
  }
  const transaction = new sql.Transaction(pool);
  let started = false;
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    await assertCompleteDirectoryPopulation(
      transaction,
      enterprise,
      settings.directorySources,
      settings.directoryStaleHours,
      now,
    );

    const repository = new SqlAccessRepository(transaction);
    const access = await resolveAccess(identity, repository, settings, now);
    if (access.state !== "authorized") {
      await transaction.commit();
      started = false;
      return mapAccessState(access);
    }

    const principal = access.principal;
    const tenantId = principal.entra_tenant_id;
    const objectId = principal.entra_object_id;
    if (!tenantId || !objectId) throw new Error("The authorized principal is missing immutable Entra identity.");
    const linkedUsers = await readLinkedDirectoryUser(
      transaction,
      principal.principal_id,
      tenantId,
      objectId,
    );
    if (linkedUsers.length === 0) {
      await transaction.commit();
      started = false;
      return { state: "forbidden" };
    }
    if (linkedUsers.length !== 1 || !linkedUsers[0]) {
      throw new Error("The authenticated principal does not have one unique active GitHub link.");
    }
    const linkedUser = linkedUsers[0];
    const selfUserId = safeUserId(linkedUser.user_id);
    if (!selfUserId || linkedUser.state !== "active" || !linkedUser.login ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})$/.test(linkedUser.login)) {
      throw new Error("The active immutable link does not resolve to a current source identity.");
    }
    const scopedUsers = await repository.readScopedUsers(objectId, access.grants);
    const target = validateBudgetLookupTarget(request, {
      moduleEnabled: true,
      perUserDetailEnabled: settings.perUserDetailEnabled,
      access: {
        state: "authorized",
        selfUserId,
        authorizedUserIds: [...new Set(scopedUsers.map(({ user_id }) => user_id))],
      },
    });
    if (!target.ok) {
      await transaction.commit();
      started = false;
      return { state: "denied", code: target.code };
    }

    const targetUsers = target.userId === selfUserId
      ? [linkedUser]
      : await readTargetDirectoryUser(transaction, target.userId);
    const targetUser = targetUsers[0];
    if (targetUsers.length !== 1 || !targetUser || targetUser.state !== "active") {
      throw new Error("The authorized numeric target is not a unique active directory user.");
    }
    const targetLogin = targetUser.login;
    if (!targetLogin || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})$/.test(targetLogin)) {
      throw new Error("The authorized numeric target does not resolve to a current source identity.");
    }
    await assertUniqueCurrentLogin(transaction, target.userId, targetLogin);

    await transaction.commit();
    started = false;
    return {
      state: "authorized",
      userId: target.userId,
      login: targetLogin,
    };
  } catch {
    if (started) await rollback(transaction, correlationId);
    logBudgetLookupAccessUnavailable(correlationId);
    return { state: "permissions_unavailable" };
  }
}
