// Metrics per-day reconciliation comparison contract (#79, D-10, D-47; data-contracts §16).
// Compares an operator-supplied legacy evidence manifest with what the new database published for one
// (organization_id, report_day). Metrics only: directory comparison needs its own contract.
// The only accepted evidence is a manifest of the legacy raw users-1-day NDJSON. It proves load fidelity
// (legacy bytes -> published facts), not that legacy portal displays match new metric definitions (test oracle).
// This contract does not grant, perform or imply any source access; it reads no other database.

import { z } from "zod";
import { validateDateRange, type DateRange } from "./api";
import { exactDecimal18_9, exactDecimal38_9 } from "./decimal";
import type { Guid, IsoDate, RunStatus, StgUserDailyRow } from "./rows";

export const METRICS_EVIDENCE_KIND = "legacy_raw_ndjson_manifest";

// Additive integer measures of portal.fact_user_daily_usage compared as day totals and per user.
export const METRICS_DAY_MEASURES = [
  "interaction_count", "code_generation_count", "code_acceptance_count",
  "loc_suggested_to_add", "loc_suggested_to_delete", "loc_added", "loc_deleted",
] as const satisfies readonly (keyof StgUserDailyRow)[];
export type MetricsDayMeasure = (typeof METRICS_DAY_MEASURES)[number];

export const EVIDENCE_AVAILABILITY = ["available", "unavailable", "unauthorized", "incomplete"] as const;
export type EvidenceAvailability = (typeof EVIDENCE_AVAILABILITY)[number];

export const METRICS_CHECK_OUTCOMES = ["matched", "explained", "unexplained", "unavailable", "incomplete"] as const;
export type MetricsCheckOutcome = (typeof METRICS_CHECK_OUTCOMES)[number];
export type ReconciliationStatus = MetricsCheckOutcome;

// Every required check must be present and matched/explained for a day to be matched. per_user is optional:
// it runs only when the manifest carries private per-user rows.
export const REQUIRED_METRICS_CHECKS = [
  "evidence_available", // manifest is available and valid
  "run_published",      // a current published users_1_day run exists for the day
  "lineage_sha256",     // SourceArtifact.sha256 equals the manifest sha256
  "lineage_size",       // SourceArtifact.size_bytes equals the manifest sizeBytes
  "row_count",          // SourceArtifact.row_count equals the manifest nonEmptyLines
  "rows_accounted",     // IngestionRun rows_loaded + rows_quarantined equals rows_read equals nonEmptyLines
  "distinct_users",     // published fact rows equal manifest distinctUserKeys
  "totals",             // every measure total and ai_credits_used equal; differingCount = measures that differ
] as const;
export const METRICS_CHECKS = [...REQUIRED_METRICS_CHECKS, "per_user"] as const;
export type MetricsCheck = (typeof METRICS_CHECKS)[number];

// Fixed allowlist. An explanation is valid only for the listed checks and only when new-side evidence supports it:
// quarantined_rejects = the difference is exactly the rows rejected with reject-severity ValidationIssue rows.
export const METRICS_EXPLANATIONS = {
  quarantined_rejects: ["distinct_users", "totals", "per_user"],
} as const satisfies Record<string, readonly MetricsCheck[]>;
export type MetricsExplanation = keyof typeof METRICS_EXPLANATIONS;

export interface MetricsCheckResult {
  check: MetricsCheck;
  outcome: MetricsCheckOutcome;
  // Required when outcome is explained, otherwise null.
  explanation: MetricsExplanation | null;
  // Number of differing items (measures for totals, users for per_user, 1 for a scalar mismatch); never values.
  differingCount: number;
}

export type ReconciliationContractErrorCode = "invalid_evidence_manifest" | "invalid_public_summary" | "invalid_coverage";

// Never retain offending values or schema-library errors: they can contain personal data.
export class ReconciliationContractError extends Error {
  constructor(readonly code: ReconciliationContractErrorCode) {
    super(`Reconciliation contract rejected: ${code}`);
    this.name = "ReconciliationContractError";
  }
}

const isoDate = z.string().refine((value) => validateDateRange({ from: value, to: value }).ok, "must be a calendar date");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalDecimal = (exact: (value: string) => string | null) =>
  z.string().refine((value) => !value.startsWith("-") && exact(value) === value, "must be a canonical non-negative decimal");
const measures = Object.fromEntries(METRICS_DAY_MEASURES.map((measure) => [measure, count])) as Record<MetricsDayMeasure, typeof count>;

const ProvenanceSchema = z.strictObject({
  // Generic label only (no organization, enterprise or storage account names).
  sourceLabel: z.string().trim().min(1).max(100),
  retrievedAt: z.iso.datetime(),
  // Opaque reference to the owner's source-access approval, kept in the private evidence location.
  approvalRef: z.string().trim().min(1).max(200).nullable(),
  toolVersion: z.string().trim().min(1).max(64),
});

const ArtifactSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: count,
  // Same definition as the loader's SourceArtifact.row_count: lines that are not empty after trimming.
  nonEmptyLines: count,
  jsonObjects: count,
  distinctUserKeys: count,
  // Extra occurrences of an (organization_id, user_id, day) key; any value > 0 makes the loader quarantine the file.
  duplicateUserKeys: count,
}).refine((a) => a.jsonObjects <= a.nonEmptyLines && a.distinctUserKeys <= a.jsonObjects);

const TotalsSchema = z.strictObject({ ...measures, ai_credits_used: canonicalDecimal(exactDecimal38_9) });
export type MetricsDayTotals = z.infer<typeof TotalsSchema>;

// PRIVATE: per-user evidence never leaves the approved private evidence location.
const PerUserSchema = z.strictObject({ user_id: positiveId, ...measures, ai_credits_used: canonicalDecimal(exactDecimal18_9) });
export type MetricsUserEvidence = z.infer<typeof PerUserSchema>;

const manifestBase = {
  schemaVersion: z.literal(1),
  evidenceKind: z.literal(METRICS_EVIDENCE_KIND),
  organizationId: positiveId,
  reportDay: isoDate,
};

const AvailableManifestSchema = z.strictObject({
  ...manifestBase,
  availability: z.literal("available"),
  provenance: ProvenanceSchema.extend({ approvalRef: z.string().trim().min(1).max(200) }),
  artifact: ArtifactSchema,
  totals: TotalsSchema,
  perUser: z.array(PerUserSchema).optional(),
}).refine((m) => m.perUser === undefined || (
  m.artifact.duplicateUserKeys === 0 &&
  m.perUser.length === m.artifact.distinctUserKeys &&
  new Set(m.perUser.map((row) => row.user_id)).size === m.perUser.length
));

const UnavailableManifestSchema = z.strictObject({
  ...manifestBase,
  availability: z.enum(["unavailable", "unauthorized", "incomplete"]),
  provenance: ProvenanceSchema,
});

export const MetricsDayEvidenceManifestSchema = z.union([AvailableManifestSchema, UnavailableManifestSchema]);
export type MetricsDayEvidenceManifest = z.infer<typeof MetricsDayEvidenceManifestSchema>;

export type EvidenceManifestParse =
  | { ok: true; manifest: MetricsDayEvidenceManifest }
  | { ok: false; code: "invalid_evidence_manifest" };

// Untrusted operator input. An invalid manifest must be reported as incomplete evidence, never as a match.
export function parseEvidenceManifest(input: unknown): EvidenceManifestParse {
  const parsed = MetricsDayEvidenceManifestSchema.safeParse(input);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, code: "invalid_evidence_manifest" };
}

// New side: read by the implementation from the new database only (IngestionRun, SourceArtifact, ValidationIssue,
// portal.fact_user_daily_usage). null means the row does not exist.
export interface MetricsDayObserved {
  organizationId: number;
  reportDay: IsoDate;
  run: {
    runId: Guid;
    status: RunStatus;
    isCurrent: boolean;
    rowsRead: number | null;
    rowsLoaded: number | null;
    rowsQuarantined: number | null;
    errorCode: string | null;
  } | null;
  artifact: { artifactId: number; sha256: string; sizeBytes: number; rowCount: number | null } | null;
  issueCounts: { reject: number; warn: number; fatal: number };
  publishedFacts: { rowCount: number; totals: MetricsDayTotals } | null;
  // PRIVATE: only loaded when the manifest carries per-user rows.
  perUser?: readonly MetricsUserEvidence[];
}

export function isPermittedExplanation(check: MetricsCheck, explanation: string | null): explanation is MetricsExplanation {
  if (explanation === null || !Object.hasOwn(METRICS_EXPLANATIONS, explanation)) return false;
  return (METRICS_EXPLANATIONS[explanation as MetricsExplanation] as readonly MetricsCheck[]).includes(check);
}

const PRECEDENCE: readonly ReconciliationStatus[] = ["unavailable", "incomplete", "unexplained", "explained", "matched"];

function worst(statuses: readonly ReconciliationStatus[]): ReconciliationStatus {
  return PRECEDENCE.find((status) => statuses.includes(status)) ?? "incomplete";
}

// Day status: unavailable > incomplete > unexplained > explained > matched. A missing required check makes the day
// incomplete; an explained outcome without a permitted explanation counts as unexplained.
export function deriveDayStatus(results: readonly MetricsCheckResult[]): ReconciliationStatus {
  const present = new Set(results.map((result) => result.check));
  const statuses: ReconciliationStatus[] = results.map((result) =>
    result.outcome === "explained" && !isPermittedExplanation(result.check, result.explanation) ? "unexplained" : result.outcome);
  if (REQUIRED_METRICS_CHECKS.some((check) => !present.has(check))) statuses.push("incomplete");
  return worst(statuses);
}

export interface MetricsDayCoverage {
  reportDay: IsoDate;
  status: ReconciliationStatus;
}

export interface MetricsRangeCoverage extends DateRange {
  status: ReconciliationStatus;
  days: MetricsDayCoverage[];
}

// Every requested day appears once; a day with no result is unavailable, so a partial range is never matched.
export function deriveRangeCoverage(range: DateRange, results: readonly MetricsDayCoverage[]): MetricsRangeCoverage {
  if (!validateDateRange(range).ok) throw new ReconciliationContractError("invalid_coverage");
  const byDay = new Map<IsoDate, ReconciliationStatus>();
  for (const result of results) {
    if (result.reportDay < range.from || result.reportDay > range.to || byDay.has(result.reportDay)) {
      throw new ReconciliationContractError("invalid_coverage");
    }
    byDay.set(result.reportDay, result.status);
  }
  const days: MetricsDayCoverage[] = [];
  for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += 86_400_000) {
    const reportDay = new Date(t).toISOString().slice(0, 10);
    days.push({ reportDay, status: byDay.get(reportDay) ?? "unavailable" });
  }
  return { from: range.from, to: range.to, status: worst(days.map((day) => day.status)), days };
}

const outcome = z.enum(METRICS_CHECK_OUTCOMES);

const PublicCheckSchema = z.strictObject({
  check: z.enum(METRICS_CHECKS),
  outcome,
  explanation: z.enum(Object.keys(METRICS_EXPLANATIONS) as [MetricsExplanation, ...MetricsExplanation[]]).nullable(),
  differingCount: count,
}).refine((c) => (c.outcome === "explained" ? isPermittedExplanation(c.check, c.explanation) : c.explanation === null));

const PublicDaySchema = z.strictObject({
  reportDay: isoDate,
  status: outcome,
  // Sanitized aggregate counts only; null when the source of the count does not exist.
  counts: z.strictObject({
    evidenceLines: count.nullable(),
    newRowsRead: count.nullable(),
    newRowsLoaded: count.nullable(),
    newRowsQuarantined: count.nullable(),
    rejectIssues: count,
    warnIssues: count,
    fatalIssues: count,
  }),
  checks: z.array(PublicCheckSchema),
}).refine((d) => new Set(d.checks.map((c) => c.check)).size === d.checks.length && d.status === deriveDayStatus(d.checks));

// PUBLIC: no user IDs, logins, emails, organization IDs, hashes, blob locators or approval references.
export const MetricsRangeReconciliationSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceKind: z.literal(METRICS_EVIDENCE_KIND),
  from: isoDate,
  to: isoDate,
  status: outcome,
  days: z.array(PublicDaySchema),
}).refine((s) => {
  try {
    const coverage = deriveRangeCoverage(s, s.days);
    return coverage.status === s.status && coverage.days.every((day, i) => s.days[i]?.reportDay === day.reportDay);
  } catch {
    return false;
  }
});
export type MetricsRangeReconciliationSummary = z.infer<typeof MetricsRangeReconciliationSummarySchema>;
export type MetricsDayReconciliationSummary = MetricsRangeReconciliationSummary["days"][number];

// Gate before writing any public artifact: strict parse, so any extra key (for example a user or organization ID) fails.
export function assertPublicSummary(value: unknown): MetricsRangeReconciliationSummary {
  const parsed = MetricsRangeReconciliationSummarySchema.safeParse(value);
  if (!parsed.success) throw new ReconciliationContractError("invalid_public_summary");
  return parsed.data;
}

export type PerUserDifferenceKind = "missing_in_new" | "missing_in_evidence" | "value_mismatch";

// PRIVATE: written only to the owner-approved private evidence location; never logged or published.
export interface MetricsDayReconciliationDetail {
  organizationId: number;
  reportDay: IsoDate;
  status: ReconciliationStatus;
  evidence: { availability: EvidenceAvailability; sha256: string | null; approvalRef: string | null; sourceLabel: string; retrievedAt: string } | null;
  observed: { runId: Guid | null; runStatus: RunStatus | null; artifactSha256: string | null };
  checks: Array<MetricsCheckResult & { evidenceValue: string | number | null; newValue: string | number | null }>;
  totals: Record<MetricsDayMeasure | "ai_credits_used", { evidence: string | number | null; new: string | number | null }>;
  perUserDifferences: Array<{
    user_id: number;
    kind: PerUserDifferenceKind;
    measures: Array<MetricsDayMeasure | "ai_credits_used">;
    explanation: MetricsExplanation | null;
  }>;
}
