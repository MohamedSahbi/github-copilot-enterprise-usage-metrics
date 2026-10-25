// Shared helpers for integration tests. They need the local stack (`npm run stack:up`) and refuse non-local hosts.
import sql from "mssql";
import { assertLocalHost, localConnectionString } from "../stack/config";

export const connectionString = process.env.SQL_CONNECTION_STRING ?? localConnectionString(process.env);

export async function openPool(): Promise<sql.ConnectionPool> {
  assertLocalHost(connectionString);
  return new sql.ConnectionPool(connectionString).connect();
}
