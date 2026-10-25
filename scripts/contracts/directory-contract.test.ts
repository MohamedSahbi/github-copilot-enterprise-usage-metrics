import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUDGET_QUERY_COLUMNS_V1,
  COPILOT_USER_DIRECTORY_V1,
  COPILOT_USER_DIRECTORY_V2,
  DIRECTORY_CONTRACT_V1,
  HIERARCHY_SYNC_RUN_V1,
  MANAGER_HIERARCHY_V1,
} from "../../shared/src/directory-contract";

describe("directory contract v1 (budget Functions, D-29)", () => {
  it("pins the exact column sets", () => {
    expect(COPILOT_USER_DIRECTORY_V1.columns.map((c) => c.name)).toEqual([
      "GitHubLogin", "Email", "DisplayName", "BusinessArea", "Department", "JobTitle", "Manager", "ManagerName",
      "CreatedAt", "UpdatedAt", "LastActivityAt", "LastActivityEditor", "PlanType", "github_license_type",
      "PendingCancellation", "AccountStatus", "LastSyncedAt", "GitHubUserId", "DeletionTemporaryGuid",
    ]);
    expect(MANAGER_HIERARCHY_V1.columns.map((c) => c.name)).toEqual(["manager_email", "report_email", "report_github_login", "report_display_name"]);
    expect(HIERARCHY_SYNC_RUN_V1.columns.map((c) => c.name)).toEqual([
      "id", "status", "trigger_source", "source_rows", "active_rows", "relationships", "deleted_count", "upserted_count", "started_at", "completed_at",
    ]);
  });

  it("keeps every column the budget queries read, with the keys they rely on", () => {
    for (const t of DIRECTORY_CONTRACT_V1.tables) {
      const names = t.columns.map((c) => c.name);
      for (const col of BUDGET_QUERY_COLUMNS_V1[t.table as keyof typeof BUDGET_QUERY_COLUMNS_V1]) expect(names).toContain(col);
    }
    expect(COPILOT_USER_DIRECTORY_V1.primaryKey).toEqual(["GitHubLogin"]);
    expect(MANAGER_HIERARCHY_V1.primaryKey).toEqual(["manager_email", "report_email"]);
  });

  it("v2 is keyed on the numeric GitHub user ID, with a mutable nullable login", () => {
    const col = (n: string) => COPILOT_USER_DIRECTORY_V2.columns.find((c) => c.name === n)!;
    expect(COPILOT_USER_DIRECTORY_V2.primaryKey).toEqual(["GitHubUserId"]);
    expect(col("GitHubUserId").nullable).toBe(false);
    expect(col("GitHubLogin").nullable).toBe(true);
    expect(COPILOT_USER_DIRECTORY_V2.columns.map((c) => c.name)).not.toContain("DeletionTemporaryGuid");
  });

  it("is never created or altered by this repository's migrations (D-34)", () => {
    const dir = join(__dirname, "..", "..", "db", "migrations");
    if (!existsSync(dir)) return;
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(/CREATE\s+TABLE\s+(portal\.)?(CopilotUserDirectory|ManagerHierarchy|HierarchySyncRun)/i.test(sql)).toBe(false);
  });
});
