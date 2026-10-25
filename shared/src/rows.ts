// SQL row shapes for the portal schema (db/migrations). Dates are ISO strings (YYYY-MM-DD or UTC ISO-8601);
// BIGINT ids are numbers (GitHub IDs stay below 2^53); DECIMAL(18,9) SQL rows keep exact strings, numbers are display-only.

export type IsoDate = string;
export type IsoDateTime = string;
export type Guid = string;

export type SourceKind = "users_1_day" | "ai_credit" | "directory" | "organization";
export type RunStatus = "started" | "staged" | "validated" | "published" | "failed" | "cancelled" | "quarantined";
export type IssueSeverity = "reject" | "warn" | "fatal";

export type BreakdownKind =
  | "ide"
  | "feature"
  | "language_feature"
  | "language_model"
  | "model_feature"
  | "client";
export type UsageFamily = "skill" | "custom_agent" | "mcp" | "slash_cmd" | "plugin";

export interface IngestionRunRow {
  run_id: Guid;
  source_kind: SourceKind;
  scope_key: string;
  report_day: IsoDate | null;
  range_start: IsoDate | null;
  range_end: IsoDate | null;
  status: RunStatus;
  is_current: boolean;
  transform_version: string;
  attempt: number;
  rows_read: number | null;
  rows_loaded: number | null;
  rows_quarantined: number | null;
  error_code: string | null;
  correlation_id: string | null;
  started_at: IsoDateTime;
  completed_at: IsoDateTime | null;
}

export interface SourceArtifactRow {
  artifact_id: number;
  run_id: Guid;
  blob_container: string;
  blob_path: string;
  sha256: string;
  size_bytes: number;
  row_count: number | null;
  received_at: IsoDateTime;
}

export interface ValidationIssueRow {
  issue_id: number;
  run_id: Guid;
  artifact_id: number | null;
  line_number: number | null;
  raw_row_sha256: string | null;
  severity: IssueSeverity;
  error_code: ValidationErrorCode;
  field_path: string | null;
  message: string | null;
  created_at: IsoDateTime;
  issue_type: "duplicate_file" | "smaller_day" | null;
  report_day: IsoDate | null;
  handled_at: IsoDateTime | null;
}

export const VALIDATION_ERROR_CODES = {
  reject: ["missing_user_id", "invalid_day", "missing_organization_id", "negative_count", "duplicate_key", "malformed_json"],
  warn: ["unknown_field", "unknown_enum_value", "unresolved_billing_login", "extra_nested_item", "attribute_empty_share"],
  fatal: ["unsupported_schema", "hash_mismatch", "duplicate_file", "duplicate_nested_name", "smaller_day_blocked"],
} as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[IssueSeverity][number];

export interface StgUserDailyRow {
  run_id: Guid;
  artifact_id: number;
  line_number: number;
  organization_id: number;
  enterprise_id: number | null;
  user_id: number;
  user_login: string | null;
  usage_day: IsoDate;
  interaction_count: number;
  code_generation_count: number;
  code_acceptance_count: number;
  loc_suggested_to_add: number;
  loc_suggested_to_delete: number;
  loc_added: number;
  loc_deleted: number;
  used_agent: boolean;
  used_chat: boolean;
  used_cli: boolean;
  used_coding_agent: boolean;
  used_cloud_agent: boolean;
  used_copilot_app: boolean;
  used_vscode_agent: boolean;
  used_code_review_active: boolean;
  used_code_review_passive: boolean;
  ai_credits_used: string;
  ai_adoption_phase_number: number | null;
  ai_adoption_phase: string | null;
  extra_json: string | null;
}

export interface StgUserBreakdownRow {
  run_id: Guid;
  artifact_id: number;
  line_number: number;
  item_number: number;
  breakdown_kind: BreakdownKind;
  key_1: string;
  key_2: string;
  interaction_count: number;
  code_generation_count: number;
  code_acceptance_count: number;
  loc_suggested_to_add: number;
  loc_suggested_to_delete: number;
  loc_added: number;
  loc_deleted: number;
  session_count: number | null;
  request_count: number | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  version_info: string | null;
}

export interface StgUserFamilyCountRow {
  run_id: Guid;
  artifact_id: number;
  line_number: number;
  item_number: number;
  family: UsageFamily;
  item_name: string;
  interaction_count: number;
}

export interface AiCreditLineValues {
  usage_date: IsoDate;
  model: string;
  product: string | null;
  sku: string | null;
  quantity: string | null;
  unit_type: string | null;
  applied_cost_per_quantity: string | null;
  gross_amount: string | null;
  discount_amount: string | null;
  net_amount: string | null;
  total_monthly_quota: string | null;
  aic_quantity: string | null;
  aic_gross_amount: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  repository: string;
  app_client_id: string;
  cost_center_name: string;
}

export interface StgAiCreditLineRow extends AiCreditLineValues {
  run_id: Guid;
  artifact_id: number;
  line_number: number;
  username: string;
  organization: string;
}

export interface DimUserRow {
  user_id: number;
  login: string | null;
  email: string | null;
  display_name: string | null;
  entra_object_id: Guid | null;
  state: "active" | "deleted" | "suspended";
  first_seen_day: IsoDate | null;
  last_seen_day: IsoDate | null;
  deleted_at: IsoDateTime | null;
  pii_purged_at: IsoDateTime | null;
  updated_at: IsoDateTime;
  manager_entra_object_id: Guid | null;
  manager_email: string | null;
  department: string | null;
  business_area: string | null;
}

export interface FactUserDailyUsageRow extends Omit<StgUserDailyRow, "run_id" | "line_number" | "enterprise_id" | "user_login"> {
  run_id: Guid;
  source_artifact_id: number;
  transform_version: string;
  loaded_at: IsoDateTime;
}

export interface FactAiCreditLineRow extends AiCreditLineValues {
  organization_login: string;
  username: string;
  organization_id: number | null;
  user_id: number | null;
  run_id: Guid;
  source_artifact_id: number;
  transform_version: string;
}

export interface AuditLogRow {
  audit_id: number;
  occurred_at: IsoDateTime;
  actor_principal_id: Guid | null;
  actor_entra_oid: Guid | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: "allowed" | "denied" | "success" | "failure";
  correlation_id: string | null;
  detail_json: string | null;
}

export type Role = "user" | "manager" | "executive" | "admin";
export type Scope = "self" | "team" | "department" | "business_area" | "company";

export interface PrincipalRow {
  principal_id: Guid;
  entra_tenant_id: Guid | null;
  entra_object_id: Guid | null;
  github_user_id: number | null;
  status: "active" | "disabled";
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  permissions_verified_at: IsoDateTime | null;
}

export interface AccessGrantRow {
  grant_id: number;
  principal_id: Guid;
  role: Role;
  scope: Scope;
  scope_value: string;
  granted_by: Guid | null;
  granted_at: IsoDateTime;
  revoked_at: IsoDateTime | null;
  principal_entra_oid: Guid;
  // Position from portal.seq_access_event; orders grants against revocations and unlinks (timestamps can tie).
  event_seq: number;
}

export type UnlinkReason = "entra_disabled" | "entra_deleted" | "github_removed";

export interface PrincipalLinkStateRow {
  link_id: number;
  entra_tenant_id: Guid;
  entra_object_id: Guid;
  github_user_id: number;
  linked_at: IsoDateTime;
  unlinked_at: IsoDateTime | null;
  unlink_seq: number | null;
  unlink_reason: UnlinkReason | null;
  run_id: Guid | null;
}

export interface GrantRevocationRow {
  revocation_id: number;
  entra_tenant_id: Guid;
  entra_object_id: Guid;
  revoked_at: IsoDateTime;
  event_seq: number;
  reason: UnlinkReason;
  run_id: Guid | null;
}

export interface IssueActionRow {
  action_id: number;
  issue_id: number;
  action: "retry" | "accept_last" | "accept_first" | "reject" | "force" | "discard";
  actor_entra_oid: Guid;
  requested_at: IsoDateTime;
  correlation_id: string | null;
}

export interface IngestionAuditEventRow {
  event_id: number;
  occurred_at: IsoDateTime;
  action: "grant.revoked_by_directory_sync" | "principal.unlinked_by_directory_sync" | "login_history.purged";
  run_id: Guid | null;
  target_type: string | null;
  target_id: string | null;
  outcome: "success" | "failure";
  correlation_id: string | null;
  detail_json: string | null;
}

// Column registries: the contract test compares these with the CREATE TABLE statements in db/migrations.
export const TABLE_COLUMNS = {
  "portal.IngestionRun": [
    "run_id", "source_kind", "scope_key", "report_day", "range_start", "range_end", "status", "is_current",
    "transform_version", "attempt", "rows_read", "rows_loaded", "rows_quarantined", "error_code", "correlation_id",
    "started_at", "completed_at",
  ] as const satisfies readonly (keyof IngestionRunRow)[],
  "portal.SourceArtifact": [
    "artifact_id", "run_id", "blob_container", "blob_path", "sha256", "size_bytes", "row_count", "received_at",
  ] as const satisfies readonly (keyof SourceArtifactRow)[],
  "portal.ValidationIssue": [
    "issue_id", "run_id", "artifact_id", "line_number", "raw_row_sha256", "severity", "error_code", "field_path",
    "message", "created_at", "issue_type", "report_day", "handled_at",
  ] as const satisfies readonly (keyof ValidationIssueRow)[],
  "portal.stg_user_daily": [
    "run_id", "artifact_id", "line_number", "organization_id", "enterprise_id", "user_id", "user_login", "usage_day",
    "interaction_count", "code_generation_count", "code_acceptance_count", "loc_suggested_to_add",
    "loc_suggested_to_delete", "loc_added", "loc_deleted", "used_agent", "used_chat", "used_cli", "used_coding_agent",
    "used_cloud_agent", "used_copilot_app", "used_vscode_agent", "used_code_review_active", "used_code_review_passive",
    "ai_credits_used", "ai_adoption_phase_number", "ai_adoption_phase", "extra_json",
  ] as const satisfies readonly (keyof StgUserDailyRow)[],
  "portal.dim_user": [
    "user_id", "login", "email", "display_name", "entra_object_id", "state", "first_seen_day", "last_seen_day",
    "deleted_at", "pii_purged_at", "updated_at", "manager_entra_object_id", "manager_email", "department", "business_area",
  ] as const satisfies readonly (keyof DimUserRow)[],
  "portal.AuditLog": [
    "audit_id", "occurred_at", "actor_principal_id", "actor_entra_oid", "action", "target_type", "target_id", "outcome",
    "correlation_id", "detail_json",
  ] as const satisfies readonly (keyof AuditLogRow)[],
  "portal.Principal": [
    "principal_id", "entra_tenant_id", "entra_object_id", "github_user_id", "status", "created_at", "updated_at",
    "permissions_verified_at",
  ] as const satisfies readonly (keyof PrincipalRow)[],
  "portal.AccessGrant": [
    "grant_id", "principal_id", "role", "scope", "scope_value", "granted_by", "granted_at", "revoked_at",
    "principal_entra_oid", "event_seq",
  ] as const satisfies readonly (keyof AccessGrantRow)[],
  "portal.PrincipalLinkState": [
    "link_id", "entra_tenant_id", "entra_object_id", "github_user_id", "linked_at", "unlinked_at", "unlink_seq", "unlink_reason", "run_id",
  ] as const satisfies readonly (keyof PrincipalLinkStateRow)[],
  "portal.GrantRevocation": [
    "revocation_id", "entra_tenant_id", "entra_object_id", "revoked_at", "event_seq", "reason", "run_id",
  ] as const satisfies readonly (keyof GrantRevocationRow)[],
  "portal.IssueAction": [
    "action_id", "issue_id", "action", "actor_entra_oid", "requested_at", "correlation_id",
  ] as const satisfies readonly (keyof IssueActionRow)[],
  "portal.IngestionAuditEvent": [
    "event_id", "occurred_at", "action", "run_id", "target_type", "target_id", "outcome", "correlation_id", "detail_json",
  ] as const satisfies readonly (keyof IngestionAuditEventRow)[],
};
