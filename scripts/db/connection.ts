// SQL connection settings for the database CLIs, read from the environment only and never printed.
// Either SQL_CONNECTION_STRING (local stack), or SQL_SERVER + SQL_DATABASE + SQL_ACCESS_TOKEN: an Entra token for
// https://database.windows.net/, which a pipeline gets from its own sign-in with `az account get-access-token`.
import sql from "mssql";

type Environment = Readonly<Record<string, string | undefined>>;

export function connectionFromEnvironment(env: Environment): sql.config {
  const connectionString = env.SQL_CONNECTION_STRING?.trim();
  if (connectionString) return sql.ConnectionPool.parseConnectionString(connectionString);
  const server = env.SQL_SERVER?.trim();
  const database = env.SQL_DATABASE?.trim();
  const token = env.SQL_ACCESS_TOKEN?.trim();
  if (!server || !database || !token) {
    throw new Error("Set SQL_CONNECTION_STRING, or SQL_SERVER, SQL_DATABASE and SQL_ACCESS_TOKEN");
  }
  return {
    server,
    database,
    authentication: { type: "azure-active-directory-access-token", options: { token } },
    options: { encrypt: true, trustServerCertificate: false },
  };
}
