import sql from "mssql";
import type { DirectoryProfile } from "../directory/providers.js";

export async function writeMetricsUsers(transaction: sql.Transaction, runId: string): Promise<void> {
  await transaction.request()
      .input("runId", sql.UniqueIdentifier, runId)
      .query(`
        UPDATE u WITH (UPDLOCK, HOLDLOCK)
        SET login = COALESCE(s.user_login, u.login),
            first_seen_day = CASE WHEN u.first_seen_day IS NULL OR s.usage_day < u.first_seen_day THEN s.usage_day ELSE u.first_seen_day END,
            last_seen_day = CASE WHEN u.last_seen_day IS NULL OR s.usage_day > u.last_seen_day THEN s.usage_day ELSE u.last_seen_day END,
            updated_at = SYSUTCDATETIME()
        FROM portal.dim_user AS u
        JOIN (SELECT user_id, MAX(user_login) AS user_login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily WHERE run_id = @runId GROUP BY user_id) AS s
          ON s.user_id = u.user_id;
        INSERT INTO portal.dim_user (user_id, login, first_seen_day, last_seen_day)
        SELECT s.user_id, s.user_login, s.usage_day, s.usage_day
        FROM (SELECT user_id, MAX(user_login) AS user_login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily WHERE run_id = @runId GROUP BY user_id) AS s
        WHERE NOT EXISTS (SELECT 1 FROM portal.dim_user AS u WITH (UPDLOCK, HOLDLOCK) WHERE u.user_id = s.user_id)`);

  await transaction.request()
      .input("runId", sql.UniqueIdentifier, runId)
      .query(`
        UPDATE h WITH (UPDLOCK, HOLDLOCK)
        SET first_seen_day = CASE WHEN s.usage_day < h.first_seen_day THEN s.usage_day ELSE h.first_seen_day END,
            last_seen_day = CASE WHEN s.usage_day > h.last_seen_day THEN s.usage_day ELSE h.last_seen_day END
        FROM portal.dim_user_login_history AS h
        JOIN (SELECT user_id, user_login AS login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily
              WHERE run_id = @runId AND user_login IS NOT NULL GROUP BY user_id, user_login) AS s
          ON s.user_id = h.user_id AND s.login = h.login;
        INSERT INTO portal.dim_user_login_history (user_id, login, first_seen_day, last_seen_day, is_hashed_login)
        SELECT s.user_id, s.login, s.usage_day, s.usage_day,
               CASE WHEN s.login LIKE REPLICATE('[0-9a-f]', 20) + '%' THEN 1 ELSE 0 END
        FROM (SELECT user_id, user_login AS login, MIN(usage_day) AS usage_day FROM portal.stg_user_daily
              WHERE run_id = @runId AND user_login IS NOT NULL GROUP BY user_id, user_login) AS s
        WHERE NOT EXISTS (SELECT 1 FROM portal.dim_user_login_history AS h WITH (UPDLOCK, HOLDLOCK)
                          WHERE h.user_id = s.user_id AND h.login = s.login)`);
}

export async function writeDirectoryUsers(transaction: sql.Transaction, profiles: readonly DirectoryProfile[]): Promise<void> {
  for (const { user, managerResolved } of profiles) {
    await transaction.request()
      .input("userId", sql.BigInt, user.user_id)
      .input("entraOid", sql.UniqueIdentifier, user.entra_object_id)
      .input("login", sql.NVarChar(255), user.login)
      .input("email", sql.NVarChar(320), user.email)
      .input("displayName", sql.NVarChar(255), user.display_name)
      .input("state", sql.VarChar(16), user.state)
      .input("managerResolved", sql.Bit, managerResolved)
      .input("managerOid", sql.UniqueIdentifier, user.manager_entra_object_id)
      .input("managerEmail", sql.NVarChar(320), user.manager_email)
      .input("department", sql.NVarChar(100), user.department)
      .input("businessArea", sql.NVarChar(50), user.business_area)
      .query(`
        IF EXISTS (SELECT 1 FROM portal.dim_user WITH (UPDLOCK, HOLDLOCK)
                   WHERE user_id = @userId AND entra_object_id IS NOT NULL AND entra_object_id <> @entraOid)
           OR EXISTS (SELECT 1 FROM portal.dim_user WITH (UPDLOCK, HOLDLOCK)
                      WHERE entra_object_id = @entraOid AND user_id <> @userId)
          THROW 51000, 'DIRECTORY_IDENTITY_CONFLICT', 1;
        UPDATE portal.dim_user WITH (UPDLOCK, HOLDLOCK)
        SET login = @login, email = @email, display_name = @displayName, entra_object_id = @entraOid,
            state = @state, department = @department, business_area = @businessArea,
            deleted_at = CASE WHEN @state = 'deleted' THEN COALESCE(deleted_at, SYSUTCDATETIME()) ELSE NULL END,
            manager_entra_object_id = CASE WHEN @managerResolved = 1 THEN @managerOid ELSE manager_entra_object_id END,
            manager_email = CASE WHEN @managerResolved = 1 THEN @managerEmail ELSE manager_email END,
            updated_at = SYSUTCDATETIME()
        WHERE user_id = @userId;
        IF @@ROWCOUNT = 0
          INSERT INTO portal.dim_user (user_id, login, email, display_name, entra_object_id, state, deleted_at,
                                       manager_entra_object_id, manager_email, department, business_area)
          VALUES (@userId, @login, @email, @displayName, @entraOid, @state,
                  CASE WHEN @state = 'deleted' THEN SYSUTCDATETIME() ELSE NULL END,
                  @managerOid, @managerEmail, @department, @businessArea)`);
  }
}
