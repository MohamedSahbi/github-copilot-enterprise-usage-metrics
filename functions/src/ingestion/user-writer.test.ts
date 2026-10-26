import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import sql from "mssql";
import { writeMetricsUsers, writeDirectoryUsers } from "./user-writer.js";
import type { DirectoryProfile } from "../directory/providers.js";
import { DirectoryUserSchema } from "../../../shared/src/directory-input.js";

const runId = "00000000-0000-0000-0000-000000000003";
const row = DirectoryUserSchema.parse({
  user_id: 42, entra_object_id: "00000000-0000-0000-0000-000000000001",
  entra_account_enabled: true, state: "active", login: "fixture-user",
});

function fakeTransaction() {
  const transaction = new sql.Transaction();
  const request = new sql.Request(transaction);
  const query = vi.spyOn(request, "query").mockImplementation(() =>
    Promise.resolve({ recordset: [], recordsets: [], output: {}, rowsAffected: [] }));
  let calls = 0;
  vi.spyOn(transaction, "request").mockImplementation(() => {
    if (calls++ === 0) return request;
    const next = new sql.Request(transaction);
    vi.spyOn(next, "query").mockImplementation(request.query);
    return next;
  });
  return { transaction, request, query };
}

describe("single logical ingestion user writer", () => {
  it("retains exact existing metrics SQL and transaction request bindings", async () => {
    const { transaction, request, query } = fakeTransaction();
    await writeMetricsUsers(transaction, runId);
    expect(request.parameters.runId?.value).toBe(runId);
    expect(query).toHaveBeenCalledTimes(2);
    const statements = query.mock.calls.map(([text]) => text);
    expect(createHash("sha256").update(JSON.stringify(statements)).digest("hex"))
      .toBe("b5d728c2877f006e09d5965a05803a1c11c1d755fc03257a9aecc03799bca455");
    const caller = readFileSync(new URL("../metrics/day-loader.ts", import.meta.url), "utf8");
    expect(caller).toContain("await writeMetricsUsers(transaction, runId);");
    expect(caller).not.toContain("INSERT INTO portal.dim_user (");
    expect(statements.join("\n")).not.toMatch(/manager_email|manager_entra_object_id|department|business_area|Principal|GrantRevocation/);
  });

  it("uses fixed parameterized directory columns without rewriting metric dates or history", async () => {
    const { transaction, request, query } = fakeTransaction();
    const profile: DirectoryProfile = { user: row, managerResolved: false, errorCode: "manager_read_failed" };
    await writeDirectoryUsers(transaction, [profile]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(request.parameters.userId?.value).toBe(42);
    expect(request.parameters.managerResolved?.value).toBe(false);
    const text = String(query.mock.calls[0]?.[0]);
    expect(text).toContain("CASE WHEN @managerResolved = 1");
    expect(text).toContain("WITH (UPDLOCK, HOLDLOCK)");
    expect(text).not.toMatch(/first_seen_day|last_seen_day|dim_user_login_history|portal\.Principal|GrantRevocation|DELETE|MERGE/);
    expect(text).not.toContain("fixture-user");
  });

  it("checks immutable mapping conflicts before any assignment and permits authoritative manager clearing", async () => {
    const { transaction, request, query } = fakeTransaction();
    await writeDirectoryUsers(transaction, [{ user: row, managerResolved: true, errorCode: null }]);
    expect(request.parameters.managerResolved?.value).toBe(true);
    expect(request.parameters.managerOid?.value).toBe(null);
    const text = String(query.mock.calls[0]?.[0]);
    expect(text.indexOf("DIRECTORY_IDENTITY_CONFLICT")).toBeLessThan(text.indexOf("UPDATE portal.dim_user"));
    expect(text).toContain("entra_object_id <> @entraOid");
    expect(text).toContain("user_id <> @userId");
  });

  it("honors the existing deleted-state timestamp constraint for CSV records", async () => {
    const { transaction, query } = fakeTransaction();
    await writeDirectoryUsers(transaction, [{ user: { ...row, state: "deleted" }, managerResolved: true, errorCode: null }]);
    const text = String(query.mock.calls[0]?.[0]);
    expect(text).toContain("deleted_at = CASE WHEN @state = 'deleted'");
    expect(text).toContain("CASE WHEN @state = 'deleted' THEN SYSUTCDATETIME() ELSE NULL END");
  });
});
