import { cookies } from "next/headers";
import {
  resolveTestPersona,
  TEST_PERSONAS,
  TEST_SESSION_COOKIE,
  type TestPersonaId,
} from "../auth/test-auth";

export type PortalScopeKind = "all" | "business_area" | "department" | "team" | "self";

export interface PortalScopeOption {
  kind: PortalScopeKind;
  value: string;
  label: string;
  userIds: number[];
}

export interface PortalViewer {
  persona: TestPersonaId | null;
  displayName: string | null;
  role: "admin" | "manager" | "member" | "no-access" | "anonymous";
  authenticated: boolean;
  perUserDetailEnabled: boolean;
  scopeOptions: PortalScopeOption[];
  allowedUserIds: number[];
}

export interface PortalScopeSelection {
  kind: PortalScopeKind;
  value: string;
  label: string;
  userIds: number[];
}

interface SyntheticUserScope {
  userId: number;
  businessArea: string;
  department: string;
  team: string;
}

const SYNTHETIC_USER_SCOPES: SyntheticUserScope[] = [
  { userId: 1000001, businessArea: "business-area-a", department: "department-a", team: "team-a" },
  { userId: 1000003, businessArea: "business-area-a", department: "department-a", team: "team-a" },
  { userId: 1000004, businessArea: "business-area-a", department: "department-a", team: "team-a" },
  { userId: 1000006, businessArea: "business-area-a", department: "department-a", team: "team-a" },
  { userId: 1000007, businessArea: "business-area-a", department: "department-b", team: "team-a" },
  { userId: 1000008, businessArea: "business-area-a", department: "department-b", team: "team-a" },
  { userId: 1000009, businessArea: "business-area-b", department: "department-c", team: "team-b" },
  { userId: 1000011, businessArea: "business-area-b", department: "department-c", team: "team-b" },
  { userId: 1000012, businessArea: "business-area-b", department: "department-d", team: "team-b" },
];

const MANAGER_REPORT_USER_IDS = [1000001, 1000003, 1000004, 1000006, 1000007, 1000008];

function uniqueOptions(
  kind: Exclude<PortalScopeKind, "all" | "self">,
  users: SyntheticUserScope[],
  key: "businessArea" | "department" | "team",
): PortalScopeOption[] {
  const values = new Map<string, number[]>();
  for (const user of users) {
    const value = user[key];
    values.set(value, [...(values.get(value) ?? []), user.userId]);
  }
  return [...values].map(([value, userIds]) => ({
    kind,
    value,
    label: value.replaceAll("-", " "),
    userIds,
  }));
}

export async function getPortalViewer(): Promise<PortalViewer> {
  const persona = resolveTestPersona((await cookies()).get(TEST_SESSION_COOKIE)?.value);
  if (!persona) {
    return {
      persona: null,
      displayName: null,
      role: "anonymous",
      authenticated: false,
      perUserDetailEnabled: false,
      scopeOptions: [],
      allowedUserIds: [],
    };
  }

  if (persona === "no-access") {
    return {
      persona,
      displayName: TEST_PERSONAS[persona],
      role: "no-access",
      authenticated: true,
      perUserDetailEnabled: false,
      scopeOptions: [],
      allowedUserIds: [],
    };
  }

  const allowedUserIds = persona === "admin"
    ? SYNTHETIC_USER_SCOPES.map(({ userId }) => userId)
    : persona === "manager"
      ? MANAGER_REPORT_USER_IDS
      : [1000001];
  const allowedUsers = SYNTHETIC_USER_SCOPES.filter(({ userId }) => allowedUserIds.includes(userId));
  const scopeOptions: PortalScopeOption[] = persona === "member"
    ? [{ kind: "self", value: String(allowedUserIds[0]), label: "Self", userIds: allowedUserIds }]
    : [
        ...uniqueOptions("business_area", allowedUsers, "businessArea"),
        ...uniqueOptions("department", allowedUsers, "department"),
        ...uniqueOptions("team", allowedUsers, "team"),
      ];

  if (persona === "admin") {
    scopeOptions.unshift({
      kind: "all",
      value: "all",
      label: "All available data",
      userIds: allowedUserIds,
    });
  }

  return {
    persona,
    displayName: TEST_PERSONAS[persona],
    role: persona,
    authenticated: true,
    perUserDetailEnabled: false,
    scopeOptions,
    allowedUserIds,
  };
}

export function resolvePortalScope(
  viewer: PortalViewer,
  requestedKind?: string,
  requestedValue?: string,
): PortalScopeSelection | null {
  const selected = viewer.scopeOptions.find(
    ({ kind, value }) => kind === requestedKind && value === requestedValue,
  );
  const defaultSelection = viewer.role === "admin"
    ? viewer.scopeOptions.find(({ kind }) => kind === "all")
    : viewer.scopeOptions[0];
  const option = selected ?? defaultSelection;
  if (!option) return null;

  return {
    ...option,
    userIds: option.userIds.filter((userId) => viewer.allowedUserIds.includes(userId)),
  };
}

export function getFixturePersonaAccess(persona: TestPersonaId): PortalViewer {
  const allowedUserIds = persona === "admin"
    ? SYNTHETIC_USER_SCOPES.map(({ userId }) => userId)
    : persona === "manager"
      ? MANAGER_REPORT_USER_IDS
      : persona === "member"
        ? [1000001]
        : [];
  return {
    persona,
    displayName: TEST_PERSONAS[persona],
    role: persona,
    authenticated: true,
    perUserDetailEnabled: false,
    scopeOptions: [],
    allowedUserIds,
  };
}

export function getSyntheticFixtureUserIds(): number[] {
  return SYNTHETIC_USER_SCOPES.map(({ userId }) => userId);
}
