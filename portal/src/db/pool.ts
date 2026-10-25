import sql from "mssql";
import { testSqlConnection } from "../auth/test-sql";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export async function getPortalSqlPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    const local = testSqlConnection();
    if (local) {
      poolPromise = new sql.ConnectionPool(local).connect().catch((error: unknown) => {
        poolPromise = undefined;
        throw error;
      });
      return poolPromise;
    }
    const server = process.env.SQL_SERVER;
    const database = process.env.SQL_DATABASE;
    if (!server || !database) throw new Error("SQL_SERVER and SQL_DATABASE are required");
    poolPromise = new sql.ConnectionPool({
      server,
      database,
      authentication: {
        type: "azure-active-directory-default",
        options: { clientId: process.env.AZURE_CLIENT_ID },
      },
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 5000,
      requestTimeout: 10000,
    }).connect().catch((error: unknown) => {
      poolPromise = undefined;
      throw error;
    });
  }
  return poolPromise;
}
