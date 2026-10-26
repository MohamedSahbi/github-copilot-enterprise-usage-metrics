import { randomUUID } from "node:crypto";
import { auth } from "../auth/config";
import { readAccessSettings } from "../auth/settings";
import { resolveAccess, type AccessRepository, type AccessScopedUser, type AccessResult } from "./access";
import { SqlAccessRepository } from "./sql-access";
import { isGuid, validateGrantRequest, type GrantRequestInput } from "../../../shared/src/access";
import { getPortalSqlPool } from "../db/pool";

export async function getAccess(correlationId: string = randomUUID()) {
  const session = await auth();
  const repository: AccessRepository = {
    async read(identity) {
      try {
        return await new SqlAccessRepository(await getPortalSqlPool()).read(identity);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ level: "error", event: "access.permissions_unavailable", correlationId })}\n`);
        throw error;
      }

    },
  };
  return resolveAccess(session?.identity ?? null, repository, readAccessSettings());
}

export async function getAuthorizedScopeUsers(
  access: Extract<AccessResult, { state: "authorized" }>,
): Promise<AccessScopedUser[]> {
  const objectId = access.principal.entra_object_id;
  if (!objectId) throw new Error("Authorized principal is missing its Entra object ID");
  try {
    return await new SqlAccessRepository(await getPortalSqlPool()).readScopedUsers(objectId, access.grants);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "access.scope_users_unavailable", correlationId: randomUUID() })}\n`);
    throw error;
  }
}

// Admin routes supply only the requested grant; directory facts and link state never come from HTTP input.
export async function validateServerGrant(request: GrantRequestInput) {
  const settings = readAccessSettings();
  if (!isGuid(request.principalEntraObjectId)) return { ok: false, code: "principal_not_linked" } as const;
  const tenant = process.env.ENTRA_TENANT_ID;
  if (!tenant || !isGuid(tenant)) throw new Error("ENTRA_TENANT_ID is required");
  const repository = new SqlAccessRepository(await getPortalSqlPool());
  return validateGrantRequest(request, await repository.grantValidationContext(tenant, request.principalEntraObjectId, settings));
}
