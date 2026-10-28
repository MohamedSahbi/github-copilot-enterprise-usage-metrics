import sql from "mssql";
import {
  DISMISSING_ACTIONS, validateIssueActionRequest, type IssueAction,
  type IssueActionRequest, type IssueType, type IssueActionResponse,
} from "../../../shared/src/issues";
import { appendAdminAudit, type AdminActor } from "./grants";
import { AdminError } from "./input";

export async function applyIssueAction(
  pool: sql.ConnectionPool, actor: AdminActor, request: IssueActionRequest, correlationId: string,
): Promise<IssueActionResponse["data"]> {
  const transaction = new sql.Transaction(pool);
  let rolledBack = false;
  transaction.on("rollback", () => { rolledBack = true; });
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const issue = (await transaction.request().input("id", sql.BigInt, request.issueId)
      .query<{ type: IssueType; reportDay: Date | null; incomingRows: number | null; handled: Date | null; chosen: number }>(`
        SELECT i.issue_type AS type, i.report_day AS reportDay, r.rows_loaded AS incomingRows,
          i.handled_at AS handled, (SELECT COUNT(*) FROM portal.IssueAction WHERE issue_id = i.issue_id) AS chosen
        FROM portal.ValidationIssue i WITH (UPDLOCK, HOLDLOCK)
        JOIN portal.IngestionRun r ON r.run_id = i.run_id
        WHERE i.issue_id = @id AND i.issue_type IS NOT NULL`)).recordset[0];
    if (!issue) throw new AdminError("not_found", 404);
    if (issue.chosen > 0 || issue.handled) throw new AdminError("invalid_action", 409);
    const validation = validateIssueActionRequest(request, issue.type, true,
      issue.incomingRows === null ? undefined : {
        incomingRows: issue.incomingRows, reportDay: issue.reportDay?.toISOString().slice(0, 10) ?? null,
      });
    if (!validation.ok) throw new AdminError(validation.code);
    await transaction.request().input("id", sql.BigInt, request.issueId)
      .input("action", sql.VarChar(16), request.action)
      .input("actor", sql.UniqueIdentifier, actor.entraObjectId)
      .input("correlation", sql.VarChar(64), correlationId)
      .query(`INSERT INTO portal.IssueAction (issue_id, action, actor_entra_oid, correlation_id)
        VALUES (@id, @action, @actor, @correlation)`);
    await appendAdminAudit(transaction, actor, correlationId, "issue.action_applied", "ValidationIssue", request.issueId,
      { action: request.action, ...(request.confirmDate ? { confirmDate: request.confirmDate } : {}) });
    await transaction.commit();
    const action = request.action as IssueAction;
    const dismissed = DISMISSING_ACTIONS.includes(action);
    return {
      issueId: request.issueId, action, status: dismissed ? "dismissed" : "open",
      reprocessRequested: !dismissed, audit: "issue.action_applied",
    };
  } catch (error) {
    if (!rolledBack) await transaction.rollback();
    throw error;
  }
}
