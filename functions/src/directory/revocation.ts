import sql from "mssql";
import type { DirectoryProfile } from "./providers.js";

export type RevocationReason = "entra_disabled" | "entra_deleted";

export interface RevocationCandidate {
  entra_object_id: string;
  reason: RevocationReason;
  /** The user was active before this run, so this is a new disable even if an older revocation exists. */
  transitioned: boolean;
}

/** Directory users Entra reports as disabled or deleted, with whether this run is the transition. */
export function revocationCandidates(
  users: readonly DirectoryProfile[],
  previousStates: ReadonlyMap<number, string>,
): RevocationCandidate[] {
  const candidates = new Map<string, RevocationCandidate>();
  for (const { user } of users) {
    if (!user.entra_object_id || user.state === "active") continue;
    const reason: RevocationReason = user.state === "deleted" ? "entra_deleted" : "entra_disabled";
    candidates.set(user.entra_object_id.toLowerCase(), {
      entra_object_id: user.entra_object_id,
      reason,
      transitioned: previousStates.get(user.user_id) === "active",
    });
  }
  return [...candidates.values()];
}

export async function readPreviousStates(
  transaction: sql.Transaction,
  users: readonly DirectoryProfile[],
): Promise<Map<number, string>> {
  const ids = users.filter(({ user }) => user.state !== "active").map(({ user }) => user.user_id);
  if (ids.length === 0) return new Map();
  const result = await transaction.request()
    .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids))
    .query<{ user_id: number | string; state: string }>(`
      SELECT u.user_id, u.state FROM portal.dim_user AS u WITH (UPDLOCK, HOLDLOCK)
      WHERE u.user_id IN (SELECT user_id FROM OPENJSON(@ids) WITH (user_id BIGINT '$'))`);
  return new Map(result.recordset.map(({ user_id, state }) => [Number(user_id), state]));
}

/**
 * Soft revocation (#76): unlinks the active Entra <-> GitHub link and appends a GrantRevocation for each
 * disabled or deleted Entra identity. Nothing is deleted and Principal/AccessGrant are never read;
 * v_active_grant hides every grant with a lower event_seq, so a re-enabled account needs a new grant.
 * A revocation is appended on the active -> disabled transition, or once if none exists yet.
 */
export async function applyDirectoryRevocations(
  transaction: sql.Transaction,
  input: { candidates: readonly RevocationCandidate[]; tenantId: string; runId: string; correlationId: string | null },
): Promise<{ unlinked: number; revoked: number }> {
  if (input.candidates.length === 0) return { unlinked: 0, revoked: 0 };
  const result = await transaction.request()
    .input("candidates", sql.NVarChar(sql.MAX), JSON.stringify(input.candidates.map((candidate) => ({
      oid: candidate.entra_object_id, reason: candidate.reason, transitioned: candidate.transitioned ? 1 : 0,
    }))))
    .input("tenantId", sql.UniqueIdentifier, input.tenantId)
    .input("runId", sql.UniqueIdentifier, input.runId)
    .input("correlationId", sql.VarChar(64), input.correlationId)
    .query<{ unlinked: number; revoked: number }>(`
      DECLARE @candidate TABLE (entra_object_id UNIQUEIDENTIFIER PRIMARY KEY, reason VARCHAR(16), transitioned BIT);
      INSERT INTO @candidate (entra_object_id, reason, transitioned)
      SELECT oid, reason, transitioned
      FROM OPENJSON(@candidates) WITH (oid UNIQUEIDENTIFIER '$.oid', reason VARCHAR(16) '$.reason', transitioned BIT '$.transitioned');

      DECLARE @unlinked TABLE (link_id BIGINT, reason VARCHAR(16));
      UPDATE s SET unlinked_at = SYSUTCDATETIME(), unlink_seq = NEXT VALUE FOR portal.seq_access_event, unlink_reason = c.reason
      OUTPUT inserted.link_id, inserted.unlink_reason INTO @unlinked (link_id, reason)
      FROM portal.PrincipalLinkState AS s WITH (UPDLOCK, HOLDLOCK)
      INNER JOIN @candidate AS c ON c.entra_object_id = s.entra_object_id
      WHERE s.entra_tenant_id = @tenantId AND s.unlinked_at IS NULL;

      DECLARE @revoked TABLE (revocation_id BIGINT, reason VARCHAR(16));
      INSERT INTO portal.GrantRevocation (entra_tenant_id, entra_object_id, reason, run_id)
      OUTPUT inserted.revocation_id, inserted.reason INTO @revoked (revocation_id, reason)
      SELECT @tenantId, c.entra_object_id, c.reason, @runId
      FROM @candidate AS c
      WHERE c.transitioned = 1 OR NOT EXISTS (
        SELECT 1 FROM portal.GrantRevocation AS r WITH (UPDLOCK, HOLDLOCK)
        WHERE r.entra_tenant_id = @tenantId AND r.entra_object_id = c.entra_object_id);

      -- Audit detail allowlist (#50 L5): only the reason; no IDs, logins, emails or source payloads.
      INSERT INTO portal.IngestionAuditEvent (action, run_id, target_type, target_id, outcome, correlation_id, detail_json)
      SELECT 'principal.unlinked_by_directory_sync', @runId, 'principal_link', CONVERT(NVARCHAR(128), link_id),
        'success', @correlationId, (SELECT reason FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
      FROM @unlinked;
      INSERT INTO portal.IngestionAuditEvent (action, run_id, target_type, target_id, outcome, correlation_id, detail_json)
      SELECT 'grant.revoked_by_directory_sync', @runId, 'grant_revocation', CONVERT(NVARCHAR(128), revocation_id),
        'success', @correlationId, (SELECT reason FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
      FROM @revoked;

      SELECT (SELECT COUNT(*) FROM @unlinked) AS unlinked, (SELECT COUNT(*) FROM @revoked) AS revoked;`);
  const counts = result.recordset[0];
  return { unlinked: Number(counts?.unlinked ?? 0), revoked: Number(counts?.revoked ?? 0) };
}
