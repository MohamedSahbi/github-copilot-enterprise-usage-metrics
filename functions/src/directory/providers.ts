import { z } from "zod";
import { isGuid, type DirectoryAttributeSettings } from "../../../shared/src/access.js";
import { DirectoryUserSchema, type DirectoryUser } from "../../../shared/src/directory-input.js";

export interface DirectoryResponse {
  status: number;
  body: unknown;
  // Set only by a transport with endpoint-specific evidence; an ordinary 404 is NOT sufficient.
  authoritativeNoManager?: boolean;
}
export type DirectoryTransport = (path: string) => Promise<DirectoryResponse>;
export type DirectoryErrorCode = "invalid_scim_page" | "invalid_seats_page" | "source_read_failed" | "invalid_population" | "profile_read_failed" | "manager_read_failed";

export class DirectoryProviderError extends Error {
  constructor(readonly code: DirectoryErrorCode) {
    super(`Directory provider failed: ${code}`);
    this.name = "DirectoryProviderError";
  }
}

export interface DirectoryIdentity {
  userId: number;
  login: string;
  entraObjectId: string;
  active: boolean;
}
export interface DirectoryPopulation {
  identities: DirectoryIdentity[];
  licensedUserIds: number[];
  licensedSeats: number;
  unmappedLicensedProfiles: number;
  scimWithoutSeats: number;
}
export interface DirectoryProfile {
  user: DirectoryUser;
  managerResolved: boolean;
  errorCode: "manager_read_failed" | null;
}

const nonnegative = z.number().int().min(0).max(2_147_483_647);
const scimResource = z.object({
  externalId: z.unknown().optional(),
  active: z.boolean(),
  profileUrl: z.unknown().optional(),
});
const scimPage = z.object({
  totalResults: nonnegative,
  startIndex: z.number().int().positive(),
  itemsPerPage: nonnegative,
  Resources: z.array(scimResource),
});
const seatSchema = z.object({ assignee: z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
}) });
const seatsPage = z.object({ total_seats: nonnegative, seats: z.array(seatSchema) });
const graphProfile = z.object({
  id: z.string().refine(isGuid),
  accountEnabled: z.boolean(),
  mail: z.string().trim().min(1).max(320).nullable().optional(),
  displayName: z.string().trim().min(1).max(255).nullable().optional(),
}).passthrough();
const managerSchema = z.object({
  id: z.string().refine(isGuid),
  mail: z.string().trim().max(320).nullable().optional(),
  userPrincipalName: z.string().trim().max(320).nullable().optional(),
});

async function request(get: DirectoryTransport, path: string): Promise<DirectoryResponse> {
  try {
    return await get(path);
  } catch {
    // Provider exceptions can embed credentials and personal payloads. Only the fixed code crosses this boundary.
    throw new DirectoryProviderError("source_read_failed");
  }
}

function profileLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,254})\/?$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function validScope(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value);
}

export async function collectDirectoryIdentities(
  get: DirectoryTransport, enterprise: string, organizations: readonly string[],
): Promise<DirectoryPopulation> {
  if (!validScope(enterprise) || organizations.length === 0 || organizations.some((org) => !validScope(org)) ||
      new Set(organizations.map((org) => org.toLowerCase())).size !== organizations.length) {
    throw new DirectoryProviderError("invalid_population");
  }
  const profiles: z.infer<typeof scimResource>[] = [];
  let total: number | undefined;
  let startIndex = 1;
  do {
    const response = await request(get, `/scim/v2/enterprises/${enterprise}/Users?startIndex=${startIndex}&count=100`);
    const parsed = scimPage.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) throw new DirectoryProviderError("invalid_scim_page");
    const page = parsed.data;
    total ??= page.totalResults;
    if (page.totalResults !== total || page.startIndex !== startIndex || page.itemsPerPage < page.Resources.length ||
        page.Resources.length > 100 || profiles.length + page.Resources.length > total ||
        (page.Resources.length === 0 && profiles.length < total)) {
      throw new DirectoryProviderError("invalid_scim_page");
    }
    profiles.push(...page.Resources);
    startIndex += page.Resources.length;
  } while (profiles.length < total);

  const seats = new Map<number, z.infer<typeof seatSchema>["assignee"]>();
  const logins = new Map<string, number>();
  for (const organization of organizations) {
    let expected: number | undefined;
    let read = 0;
    let pageNumber = 1;
    const seen = new Set<number>();
    do {
      const response = await request(get, `/orgs/${organization}/copilot/billing/seats?per_page=100&page=${pageNumber++}`);
      const parsed = seatsPage.safeParse(response.body);
      if (response.status !== 200 || !parsed.success) throw new DirectoryProviderError("invalid_seats_page");
      const page = parsed.data;
      expected ??= page.total_seats;
      if (page.total_seats !== expected || page.seats.length > 100 || read + page.seats.length > expected ||
          (page.seats.length === 0 && read < expected)) throw new DirectoryProviderError("invalid_seats_page");
      for (const { assignee } of page.seats) {
        const login = assignee.login.toLowerCase();
        if (seen.has(assignee.id) || (seats.has(assignee.id) && seats.get(assignee.id)!.login.toLowerCase() !== login) ||
            (logins.has(login) && logins.get(login) !== assignee.id)) throw new DirectoryProviderError("invalid_seats_page");
        seen.add(assignee.id);
        seats.set(assignee.id, assignee);
        logins.set(login, assignee.id);
      }
      read += page.seats.length;
    } while (read < expected);
  }
  const byLogin = new Map<string, z.infer<typeof scimResource>[]>();
  const entraCounts = new Map<string, number>();
  let scimWithoutSeats = 0;
  for (const profile of profiles) {
    const login = profileLogin(profile.profileUrl);
    if (typeof profile.externalId === "string" && isGuid(profile.externalId)) {
      const oid = profile.externalId.toLowerCase();
      entraCounts.set(oid, (entraCounts.get(oid) ?? 0) + 1);
    }
    if (login === null) continue;
    byLogin.set(login, [...(byLogin.get(login) ?? []), profile]);
    if (!logins.has(login)) scimWithoutSeats++;
  }
  const identities: DirectoryIdentity[] = [];
  for (const seat of seats.values()) {
    const candidates = byLogin.get(seat.login.toLowerCase());
    const profile = candidates?.length === 1 ? candidates[0] : undefined;
    if (!profile || typeof profile.externalId !== "string" || !isGuid(profile.externalId) ||
        entraCounts.get(profile.externalId.toLowerCase()) !== 1) continue;
    identities.push({ userId: seat.id, login: seat.login, entraObjectId: profile.externalId.toLowerCase(), active: profile.active });
  }
  return { identities, licensedUserIds: [...seats.keys()], licensedSeats: seats.size,
    unmappedLicensedProfiles: seats.size - identities.length, scimWithoutSeats };
}

function attribute(profile: Record<string, unknown>, path: string): unknown {
  if (path === "") return null;
  let value: unknown = profile;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, part)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value ?? null;
}

export async function readGraphProfile(
  get: DirectoryTransport, identity: DirectoryIdentity, attrs: DirectoryAttributeSettings,
): Promise<DirectoryProfile> {
  if (!isGuid(identity.entraObjectId) || [attrs.departmentAttribute, attrs.businessAreaAttribute]
    .some((path) => path !== "" && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(path))) {
    throw new DirectoryProviderError("profile_read_failed");
  }
  const select = [...new Set(["id", "accountEnabled", "mail", "displayName",
    ...[attrs.departmentAttribute, attrs.businessAreaAttribute].filter(Boolean).map((path) => path.split(".")[0]!),
  ])].join(",");
  const response = await request(get, `/v1.0/users/${identity.entraObjectId}?$select=${select}`);
  const parsed = graphProfile.safeParse(response.body);
  if (response.status !== 200 || !parsed.success || parsed.data.id.toLowerCase() !== identity.entraObjectId.toLowerCase()) {
    throw new DirectoryProviderError("profile_read_failed");
  }
  const normalized = DirectoryUserSchema.safeParse({
    user_id: identity.userId, login: identity.login, entra_object_id: identity.entraObjectId,
    entra_account_enabled: parsed.data.accountEnabled,
    state: identity.active && parsed.data.accountEnabled ? "active" : "suspended",
    email: parsed.data.mail ?? null, display_name: parsed.data.displayName ?? null,
    department: attribute(parsed.data, attrs.departmentAttribute),
    business_area: attribute(parsed.data, attrs.businessAreaAttribute),
  });
  if (!normalized.success) throw new DirectoryProviderError("profile_read_failed");
  let managerResponse: DirectoryResponse;
  try {
    managerResponse = await request(get, `/v1.0/users/${identity.entraObjectId}/manager?$select=id,mail,userPrincipalName`);
  } catch (error) {
    if (!(error instanceof DirectoryProviderError)) throw error;
    return { user: normalized.data, managerResolved: false, errorCode: "manager_read_failed" };
  }
  if (managerResponse.status === 404 && managerResponse.authoritativeNoManager === true) {
    return { user: normalized.data, managerResolved: true, errorCode: null };
  }
  const manager = managerSchema.safeParse(managerResponse.body);
  if (managerResponse.status !== 200 || !manager.success) {
    return { user: normalized.data, managerResolved: false, errorCode: "manager_read_failed" };
  }
  const email = manager.data.mail || manager.data.userPrincipalName;
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || manager.data.id.toLowerCase() === identity.entraObjectId.toLowerCase()) {
    return { user: normalized.data, managerResolved: false, errorCode: "manager_read_failed" };
  }
  return { user: { ...normalized.data, manager_entra_object_id: manager.data.id.toLowerCase(), manager_email: email },
    managerResolved: true, errorCode: null };
}
