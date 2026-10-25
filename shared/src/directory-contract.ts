// Directory column contract read by the budget Functions (D-29). Derived from the existing code, generic names only.
// v1 = the columns the Functions read today. v2 (defined, not yet adopted) re-keys on the numeric GitHub user ID.
// Any change here needs the contract test updated and a note for the budget Functions' owner.

export const DIRECTORY_CONTRACT_V1_VERSION = 1;
export const DIRECTORY_CONTRACT_V2_VERSION = 2;

export type SqlType = "nvarchar" | "datetime2" | "int";

export interface ColumnSpec {
  readonly name: string;
  readonly type: SqlType;
  readonly length?: number;
  readonly nullable: boolean;
}

export interface TableContract {
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnSpec[];
}

const c = (name: string, type: SqlType, nullable: boolean, length?: number): ColumnSpec =>
  length === undefined ? { name, type, nullable } : { name, type, length, nullable };

export const COPILOT_USER_DIRECTORY_V1: TableContract = {
  table: "CopilotUserDirectory",
  primaryKey: ["GitHubLogin"],
  columns: [
    c("GitHubLogin", "nvarchar", false, 255),
    c("Email", "nvarchar", true, 320),
    c("DisplayName", "nvarchar", true, 255),
    c("BusinessArea", "nvarchar", true, 50),
    c("Department", "nvarchar", true, 255),
    c("JobTitle", "nvarchar", true, 255),
    c("Manager", "nvarchar", true, 320),
    c("ManagerName", "nvarchar", true, 255),
    c("CreatedAt", "datetime2", true),
    c("UpdatedAt", "datetime2", true),
    c("LastActivityAt", "datetime2", true),
    c("LastActivityEditor", "nvarchar", true, 255),
    c("PlanType", "nvarchar", true, 100),
    c("github_license_type", "nvarchar", true, 100),
    c("PendingCancellation", "datetime2", true),
    c("AccountStatus", "nvarchar", false, 50),
    c("LastSyncedAt", "datetime2", false),
    c("GitHubUserId", "nvarchar", true, 50),
    c("DeletionTemporaryGuid", "nvarchar", true, 255),
  ],
};

export const MANAGER_HIERARCHY_V1: TableContract = {
  table: "ManagerHierarchy",
  primaryKey: ["manager_email", "report_email"],
  columns: [
    c("manager_email", "nvarchar", false, 320),
    c("report_email", "nvarchar", false, 320),
    c("report_github_login", "nvarchar", true, 255),
    c("report_display_name", "nvarchar", true, 255),
  ],
};

export const HIERARCHY_SYNC_RUN_V1: TableContract = {
  table: "HierarchySyncRun",
  primaryKey: ["id"],
  columns: [
    c("id", "int", false),
    c("status", "nvarchar", false, 20),
    c("trigger_source", "nvarchar", false, 20),
    c("source_rows", "int", false),
    c("active_rows", "int", false),
    c("relationships", "int", false),
    c("deleted_count", "int", false),
    c("upserted_count", "int", false),
    c("started_at", "datetime2", false),
    c("completed_at", "datetime2", false),
  ],
};

export const DIRECTORY_CONTRACT_V1 = {
  version: DIRECTORY_CONTRACT_V1_VERSION,
  tables: [COPILOT_USER_DIRECTORY_V1, MANAGER_HIERARCHY_V1, HIERARCHY_SYNC_RUN_V1],
} as const;

// Columns the budget queries actually reference (lookup, reconcile, cost-center management). Contract tests pin these.
export const BUDGET_QUERY_COLUMNS_V1 = {
  CopilotUserDirectory: ["GitHubLogin", "Email", "DisplayName"],
  ManagerHierarchy: ["manager_email", "report_email", "report_github_login"],
  HierarchySyncRun: ["id", "status", "completed_at", "relationships"],
} as const;

// v2: numeric GitHub user ID is the key; login and email are mutable; deletion is a state, not a sentinel GUID.
export const COPILOT_USER_DIRECTORY_V2: TableContract = {
  table: "CopilotUserDirectory",
  primaryKey: ["GitHubUserId"],
  columns: [
    ...COPILOT_USER_DIRECTORY_V1.columns.filter((x) => x.name !== "GitHubUserId" && x.name !== "DeletionTemporaryGuid"),
    c("GitHubUserId", "nvarchar", false, 20),
    c("DeletedAt", "datetime2", true),
  ].map((x) => (x.name === "GitHubLogin" ? c("GitHubLogin", "nvarchar", true, 255) : x)),
};

// Old column → v2 column mapping for the follow-up migration of the budget Functions.
export const DIRECTORY_V1_TO_V2 = {
  GitHubLogin: "GitHubLogin (now mutable, nullable)",
  GitHubUserId: "GitHubUserId (now primary key, not null)",
  DeletionTemporaryGuid: "DeletedAt (state replaces the sentinel)",
} as const;
