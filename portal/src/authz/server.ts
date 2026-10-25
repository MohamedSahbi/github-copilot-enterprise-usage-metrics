import { randomUUID } from "node:crypto";
import sql from "mssql";
import { auth } from "../auth/config";
import { readAccessSettings } from "../auth/settings";
import { testSqlConnection } from "../auth/test-sql";
import { resolveAccess, type AccessRepository } from "./access";
import { SqlAccessRepository } from "./sql-access";
import { isGuid, validateGrantRequest, type GrantRequestInput } from "../../../shared/src/access";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

async function openPool(): Promise<sql.ConnectionPool> {
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
      server, database,
      authentication: {
        type: "azure-active-directory-default",
        options: { clientId: process.env.AZURE_CLIENT_ID },
      },
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 5000, requestTimeout: 10000,
    }).connect().catch((error: unknown) => {
      poolPromise = undefined;
      throw error;
    });
  }
  return poolPromise;
}

export async function getAccess() {
  const session = await auth();
  const correlationId = randomUUID();
  const repository: AccessRepository = {
    async read(identity) {
      try {
        return await new SqlAccessRepository(await openPool()).read(identity);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ level: "error", event: "access.permissions_unavailable", correlationId })}\n`);
        throw error;
      }

    },
  };
  return resolveAccess(session?.identity ?? null, repository, readAccessSettings());
}

// Admin routes supply only the requested grant; directory facts and link state never come from HTTP input.
export async function validateServerGrant(request: GrantRequestInput) {
  const settings = readAccessSettings();
  if (!isGuid(request.principalEntraObjectId)) return { ok: false, code: "principal_not_linked" } as const;
  const tenant = process.env.ENTRA_TENANT_ID;
  if (!tenant || !isGuid(tenant)) throw new Error("ENTRA_TENANT_ID is required");
  const repository = new SqlAccessRepository(await openPool());
  return validateGrantRequest(request, await repository.grantValidationContext(tenant, request.principalEntraObjectId, settings));
}
