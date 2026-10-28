import sql from "mssql";
import { AUTH_PRINCIPALS_BY_PERSONA } from "./auth-seed";
import { requireFirstSqlRow } from "../../portal/src/feedback/sql-result";

export type FeedbackSeedIds = [number, number, number];

async function insertFeedback(
  pool: sql.ConnectionPool,
  title: string,
  author: keyof typeof AUTH_PRINCIPALS_BY_PERSONA,
  visibility: "everyone" | "admins",
): Promise<number> {
  const result = await pool.request()
    .input("title", sql.NVarChar(200), title)
    .input("author", sql.UniqueIdentifier, AUTH_PRINCIPALS_BY_PERSONA[author])
    .input("visibility", sql.VarChar(10), visibility)
    .query<{ item_id: string }>(`
      INSERT INTO portal.FeedbackItem (author_principal_id, title, body, visibility)
      OUTPUT CONVERT(varchar(20), INSERTED.item_id) AS item_id
      VALUES (@author, @title, N'Synthetic feedback for local verification only.', @visibility);`);
  const id = Number(requireFirstSqlRow(result.recordset, "Feedback seed insert").item_id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid synthetic feedback ID");
  return id;
}

export async function seedFeedback(pool: sql.ConnectionPool): Promise<FeedbackSeedIds> {
  return [
    await insertFeedback(pool, "Public feedback example", "admin", "everyone"),
    await insertFeedback(pool, "Private admin feedback", "admin", "admins"),
    await insertFeedback(pool, "Private member feedback", "member", "admins"),
  ];
}

export async function cleanupFeedback(pool: sql.ConnectionPool, ids: readonly number[]) {
  for (const id of ids) {
    await pool.request().input("id", sql.BigInt, id)
      .query("DELETE FROM portal.FeedbackItem WHERE item_id = @id");
  }
}
