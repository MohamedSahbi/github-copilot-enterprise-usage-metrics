import sql from "mssql";
import type { FeedbackItemView, FeedbackListRequest } from "../../../shared/src/api";
import type { AccessResult } from "../authz/access";
import { requireFirstSqlRow, requireSqlResultSet } from "./sql-result";

type Access = Extract<AccessResult, { state: "authorized" }>;

// Original public-or-author-or-admin visibility, using immutable principal IDs instead of email.
const VISIBLE_ITEM = `(fi.visibility = 'everyone' OR
  (fi.visibility = 'admins' AND (@admin = 1 OR fi.author_principal_id = @principal)))`;
const ITEM_COLUMNS = `CONVERT(varchar(20), fi.item_id) AS itemId, fi.title, fi.body, fi.status,
  (SELECT COUNT(*) FROM portal.FeedbackVote fv WHERE fv.item_id = fi.item_id) AS votes,
  (SELECT COUNT(*) FROM portal.FeedbackComment fc WHERE fc.item_id = fi.item_id) AS commentCount,
  CONVERT(varchar(19), fi.created_at, 126) + 'Z' AS createdAt`;

function request(pool: sql.ConnectionPool, access: Access) {
  return pool.request()
    .input("principal", sql.UniqueIdentifier, access.principal.principal_id)
    .input("admin", sql.Bit, access.grants.some(({ role }) => role === "admin"));
}

function itemView(row: Omit<FeedbackItemView, "itemId" | "authorDisplayName"> & { itemId: string }): FeedbackItemView {
  const itemId = Number(row.itemId);
  if (!Number.isSafeInteger(itemId) || itemId < 1) throw new Error("Feedback item ID exceeds the API range");
  return { ...row, itemId, authorDisplayName: null };
}

type ItemResult = Parameters<typeof itemView>[0];

export async function listFeedback(
  pool: sql.ConnectionPool,
  access: Access,
  page: Required<Pick<FeedbackListRequest, "page" | "pageSize">> & Pick<FeedbackListRequest, "status">,
) {
  const result = await request(pool, access)
    .input("status", sql.VarChar(12), page.status ?? null)
    .input("offset", sql.Int, (page.page - 1) * page.pageSize)
    .input("pageSize", sql.Int, page.pageSize)
    .query<[{ totalItems: number }, ItemResult]>(`
      SELECT COUNT(*) AS totalItems FROM portal.FeedbackItem fi
      WHERE ${VISIBLE_ITEM} AND (@status IS NULL OR fi.status = @status);
      SELECT ${ITEM_COLUMNS} FROM portal.FeedbackItem fi
      WHERE ${VISIBLE_ITEM} AND (@status IS NULL OR fi.status = @status)
      ORDER BY votes DESC, fi.created_at DESC, fi.item_id DESC
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;`);
  const itemRows = requireSqlResultSet(result.recordsets[1], "Feedback list items");
  const count = requireFirstSqlRow(result.recordsets[0], "Feedback list count");
  return { rows: itemRows.map(itemView), totalItems: count.totalItems };
}

export async function getFeedback(pool: sql.ConnectionPool, access: Access, itemId: number) {
  const result = await request(pool, access).input("itemId", sql.BigInt, itemId)
    .query<ItemResult>(`SELECT ${ITEM_COLUMNS} FROM portal.FeedbackItem fi
      WHERE fi.item_id = @itemId AND ${VISIBLE_ITEM};`);
  const row = requireSqlResultSet(result.recordset, "Feedback item")[0];
  return row ? itemView(row) : null;
}

export async function toggleFeedbackVote(pool: sql.ConnectionPool, access: Access, itemId: number) {
  const result = await request(pool, access).input("itemId", sql.BigInt, itemId)
    .query<{ allowed: boolean }>(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @allowed bit = 0;
        IF EXISTS (SELECT 1 FROM portal.FeedbackItem fi WITH (UPDLOCK, HOLDLOCK)
          WHERE fi.item_id = @itemId AND ${VISIBLE_ITEM})
        BEGIN
          SET @allowed = 1;
          IF EXISTS (SELECT 1 FROM portal.FeedbackVote WHERE item_id = @itemId AND principal_id = @principal)
            DELETE FROM portal.FeedbackVote WHERE item_id = @itemId AND principal_id = @principal;
          ELSE
            INSERT INTO portal.FeedbackVote (item_id, principal_id) VALUES (@itemId, @principal);
        END;
        COMMIT TRANSACTION;
        SELECT @allowed AS allowed;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;`);
  const outcome = requireFirstSqlRow(result.recordset, "Feedback vote toggle");
  return outcome.allowed ? getFeedback(pool, access, itemId) : null;
}
