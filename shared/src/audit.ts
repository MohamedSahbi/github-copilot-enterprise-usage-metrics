// Audit row types (issue #44 items 4, 8, 9, 10). The writer follows D-34: the portal appends to portal.AuditLog,
// ingestion (which cannot write AuditLog) appends to portal.IngestionAuditEvent. The Admin audit view reads both.

export type AuditWriter = "portal" | "ingestion";

export const AUDIT_ACTIONS = {
  "grant.created": "portal",
  "grant.revoked": "portal",
  "issue.action_applied": "portal",
  "day.replace_forced": "portal",
  "grant.revoked_by_directory_sync": "ingestion",
  "principal.unlinked_by_directory_sync": "ingestion",
  "login_history.purged": "ingestion",
} as const satisfies Record<string, AuditWriter>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
