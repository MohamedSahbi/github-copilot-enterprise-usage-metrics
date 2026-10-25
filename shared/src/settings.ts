// Deployment settings contract (issue #44, items 6, 8, 11). These are settings (tfvars -> app settings), not SQL rows.
// Real values live in the private deployment repository; defaults and examples here are generic.

import { isGuid } from "./access";

export interface DeploymentSettings {
  retention: { perUserMonths: number; loginHistoryMonths: number };
  privacy: { minGroupSize: number };
  access: { breakGlassGroupId: string; permissionFreshnessMinutes: number };
  directory: { departmentAttribute: string; businessAreaAttribute: string; emptyAttributeThresholdPercent: number };
}

export const MIN_GROUP_SIZE_FLOOR = 5;
export const MIN_PERMISSION_FRESHNESS_MINUTES = 1;
export const MAX_PERMISSION_FRESHNESS_MINUTES = 60;
export const MAX_PER_USER_MONTHS = 36;
export const MAX_LOGIN_HISTORY_MONTHS = 60;

export const DEFAULT_SETTINGS: DeploymentSettings = {
  retention: { perUserMonths: 13, loginHistoryMonths: 24 },
  privacy: { minGroupSize: MIN_GROUP_SIZE_FLOOR },
  access: { breakGlassGroupId: "", permissionFreshnessMinutes: 5 },
  directory: { departmentAttribute: "", businessAreaAttribute: "", emptyAttributeThresholdPercent: 20 },
};

export type SettingsValidation =
  | { ok: true; settings: DeploymentSettings }
  | { ok: false; errors: { setting: string; issue: string }[] };

// Entra attribute paths such as "department" or "onPremisesExtensionAttributes.extensionAttribute1"; "" disables the scope.
const ATTRIBUTE_PATH = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);

export function validateSettings(input: unknown): SettingsValidation {
  const errors: { setting: string; issue: string }[] = [];
  // Omitted (undefined) roots and sections keep their defaults; anything else must be a plain object.
  const bag = (v: unknown, setting: string): Bag => {
    if (v === undefined) return {};
    if (!isBag(v)) {
      errors.push({ setting, issue: "must be an object" });
      return {};
    }
    return v;
  };
  const root = bag(input, "settings");
  const retention = bag(root.retention, "retention");
  const privacy = bag(root.privacy, "privacy");
  const access = bag(root.access, "access");
  const directory = bag(root.directory, "directory");
  const d = DEFAULT_SETTINGS;

  const int = (v: unknown, setting: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push({ setting, issue: `must be an integer between ${min} and ${max === Number.MAX_SAFE_INTEGER ? "unbounded" : max}` });
      return fallback;
    }
    return v;
  };
  const attr = (v: unknown, setting: string): string => {
    if (v === undefined) return "";
    if (typeof v !== "string" || (v.trim() !== "" && !ATTRIBUTE_PATH.test(v.trim()))) {
      errors.push({ setting, issue: "must be empty (scope disabled) or an Entra attribute path" });
      return "";
    }
    return v.trim();
  };

  let breakGlassGroupId = "";
  if (access.breakGlassGroupId !== undefined) {
    if (typeof access.breakGlassGroupId !== "string" || (access.breakGlassGroupId !== "" && !isGuid(access.breakGlassGroupId))) {
      errors.push({ setting: "access.breakGlassGroupId", issue: "must be empty or an Entra group object ID (GUID)" });
    } else {
      breakGlassGroupId = access.breakGlassGroupId;
    }
  }

  const settings: DeploymentSettings = {
    retention: {
      perUserMonths: int(retention.perUserMonths, "retention.perUserMonths", d.retention.perUserMonths, 1, MAX_PER_USER_MONTHS),
      loginHistoryMonths: int(retention.loginHistoryMonths, "retention.loginHistoryMonths", d.retention.loginHistoryMonths, 1, MAX_LOGIN_HISTORY_MONTHS),
    },
    privacy: { minGroupSize: int(privacy.minGroupSize, "privacy.minGroupSize", d.privacy.minGroupSize, MIN_GROUP_SIZE_FLOOR) },
    access: {
      breakGlassGroupId,
      permissionFreshnessMinutes: int(
        access.permissionFreshnessMinutes,
        "access.permissionFreshnessMinutes",
        d.access.permissionFreshnessMinutes,
        MIN_PERMISSION_FRESHNESS_MINUTES,
        MAX_PERMISSION_FRESHNESS_MINUTES,
      ),
    },
    directory: {
      departmentAttribute: attr(directory.departmentAttribute, "directory.departmentAttribute"),
      businessAreaAttribute: attr(directory.businessAreaAttribute, "directory.businessAreaAttribute"),
      emptyAttributeThresholdPercent: int(
        directory.emptyAttributeThresholdPercent,
        "directory.emptyAttributeThresholdPercent",
        d.directory.emptyAttributeThresholdPercent,
        1,
        100,
      ),
    },
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings };
}

// Value written to the department and business_area directory columns: trimmed, whitespace collapsed, lowercased.
export function normalizeDirectoryValue(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface EmptyShareCheck {
  enabled: boolean;
  totalUsers: number;
  emptyUsers: number;
  thresholdPercent: number;
}

// True when the sync must record a ValidationIssue (attribute_empty_share) instead of creating an empty group.
export function attributeEmptyShareExceeded(c: EmptyShareCheck): boolean {
  if (!c.enabled || c.totalUsers <= 0) return false;
  return (c.emptyUsers * 100) / c.totalUsers > c.thresholdPercent;
}
