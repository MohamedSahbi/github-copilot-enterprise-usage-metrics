import { validateSettings } from "../../../shared/src/settings";

type Env = Record<string, string | undefined>;

/** Minimum distinct users a reported group needs (MIN_GROUP_SIZE); 5 when unset, never below 2. */
export function readMinGroupSize(env: Env = process.env): number {
  const raw = env.MIN_GROUP_SIZE;
  if (raw === undefined) return validateOrThrow(undefined);
  if (raw.trim() === "") throw new Error("MIN_GROUP_SIZE must be a whole number of at least 2");
  return validateOrThrow(Number(raw));
}

function validateOrThrow(minGroupSize: number | undefined): number {
  const validated = validateSettings({ privacy: { minGroupSize } });
  if (!validated.ok) throw new Error("MIN_GROUP_SIZE must be a whole number of at least 2");
  return validated.settings.privacy.minGroupSize;
}

export function readAccessSettings(env: Env = process.env) {
  const freshness = env.ACCESS_PERMISSION_FRESHNESS_MINUTES === undefined ? 5 : Number(env.ACCESS_PERMISSION_FRESHNESS_MINUTES);
  if (!Number.isInteger(freshness) || env.ACCESS_PERMISSION_FRESHNESS_MINUTES === "") {
    throw new Error("Invalid access.permission_freshness_minutes");
  }
  const breakGlass = env.ACCESS_BREAK_GLASS_GROUP_ID ?? "";
  const validated = validateSettings({
    access: {
      breakGlassGroupId: breakGlass,
      permissionFreshnessMinutes: freshness,
    },
    directory: {
      departmentAttribute: env.DIRECTORY_DEPARTMENT_ATTRIBUTE,
      businessAreaAttribute: env.DIRECTORY_BUSINESS_AREA_ATTRIBUTE,
    },
  });
  if (!validated.ok) throw new Error(`Invalid access settings: ${validated.errors.map((e) => e.setting).join(", ")}`);
  if (env.PER_USER_DETAIL_ENABLED !== undefined && !["true", "false"].includes(env.PER_USER_DETAIL_ENABLED)) {
    throw new Error("PER_USER_DETAIL_ENABLED must be true or false");
  }
  const staleHours = Number(env.STALE_DATA_THRESHOLD_HOURS ?? "36");
  if (!Number.isInteger(staleHours) || staleHours < 1) throw new Error("Invalid STALE_DATA_THRESHOLD_HOURS");
  const provider = env.DIRECTORY_PROVIDER ?? "entra";
  if (!["entra", "csv"].includes(provider)) throw new Error("Invalid DIRECTORY_PROVIDER");
  const requestUrl = env.ACCESS_REQUEST_URL ?? "";
  if (requestUrl && !/^https:\/\/[^\s]+$/.test(requestUrl)) throw new Error("ACCESS_REQUEST_URL must be an HTTPS URL");
  return {
    ...validated.settings.access,
    directory: validated.settings.directory,
    directorySources: provider === "csv" ? ["csv"] : ["scim", "graph", "seats"],
    directoryStaleHours: staleHours,
    perUserDetailEnabled: env.PER_USER_DETAIL_ENABLED === "true",
    noAccessMessage: env.ACCESS_NO_ACCESS_MESSAGE ?? "You do not currently have permission to use this portal.",
    requestUrl,
    contact: env.ACCESS_CONTACT ?? "",
  };
}

export type AccessSettings = ReturnType<typeof readAccessSettings>;
