import { z } from "zod";
import { isGuid } from "./access";
import { backfillFromSchema } from "./ingestion-settings";

const hostLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const githubOrganizationLogin = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const storageAccountName = /^[a-z0-9]{3,24}$/;
const storageContainerName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const invalidSqlDatabaseCharacters = /[\\/:*?"<>|]/;

const organizationSchema = z.string()
  .min(1, "must be a valid GitHub organization login")
  .max(39, "must be a valid GitHub organization login")
  .regex(githubOrganizationLogin, "must be a valid GitHub organization login");

const organizationsSchema = z.array(organizationSchema)
  .min(1, "must contain at least one GitHub organization")
  .superRefine((organizations, context) => {
    const seen = new Set<string>();
    organizations.forEach((organization, index) => {
      const identity = organization.toLowerCase();
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "duplicates a GitHub organization identity",
        });
      }
      seen.add(identity);
    });
  })
  .readonly();

const metricsRuntimeBaseSchema = z.strictObject({
  githubAppId: z.string()
    .regex(/^[0-9]+$/, "must be a positive decimal GitHub App ID")
    .refine((value) => /[1-9]/.test(value), "must be a positive decimal GitHub App ID"),
  organizations: organizationsSchema,
  sqlServer: z.string()
    .min(1, "must be a SQL server host name")
    .max(253, "must be a SQL server host name")
    .refine((value) => value.split(".").every((label) => hostLabel.test(label)), "must be a SQL server host name"),
  sqlDatabase: z.string()
    .min(1, "must be a SQL database name")
    .max(128, "must be a SQL database name")
    .refine((value) =>
      value.trim().length > 0 &&
      value.trim() === value &&
      !invalidSqlDatabaseCharacters.test(value) &&
      ![...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f),
    "must be a SQL database name"),
  managedIdentityClientId: z.string().refine(isGuid, "must be a managed identity client ID (GUID)"),
  rawArchiveAccount: z.string().regex(storageAccountName, "must be a valid Azure Storage account name"),
  rawArchiveContainer: z.string()
    .min(3, "must be a valid Azure Storage container name")
    .max(63, "must be a valid Azure Storage container name")
    .regex(storageContainerName, "must be a valid Azure Storage container name"),
});

export type MetricsRuntimeSettings = z.infer<typeof metricsRuntimeBaseSchema> & {
  backfillFrom?: string;
};

export type MetricsRuntimeSettingsValidation =
  | { ok: true; settings: MetricsRuntimeSettings }
  | { ok: false; errors: { setting: string; issue: string }[] };

export function validateMetricsRuntimeSettings(
  input: unknown,
  today = new Date().toISOString().slice(0, 10),
): MetricsRuntimeSettingsValidation {
  const schema = metricsRuntimeBaseSchema.extend({
    backfillFrom: backfillFromSchema(today),
  });
  const result = schema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => ({
        setting: issue.path.length === 0 ? "settings" : issue.path.join("."),
        issue: issue.path.length === 0 ? "contains invalid or unknown settings" : issue.message,
      })),
    };
  }
  const { backfillFrom, ...settings } = result.data;
  return {
    ok: true,
    settings: {
      ...settings,
      ...(backfillFrom === undefined ? {} : { backfillFrom }),
    },
  };
}
