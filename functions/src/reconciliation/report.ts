import { createHash } from "node:crypto";
import { z } from "zod";
import { exactDecimal18_9, exactDecimal38_9 } from "../../../shared/src/decimal.js";
import {
  METRICS_DAY_MEASURES, METRICS_EVIDENCE_KIND,
  assertPublicSummary, deriveDayStatus, deriveRangeCoverage, evidenceAvailabilityCheck, parseEvidenceManifest,
  type MetricsCheck, type MetricsCheckOutcome, type MetricsDayEvidenceManifest, type MetricsDayObserved,
  type MetricsDayReconciliationDetail, type MetricsDayReconciliationSummary, type MetricsDayTotals,
  type MetricsUserEvidence,
} from "../../../shared/src/reconciliation.js";
import { parseMetricsDay } from "../metrics/day-parser.js";
import type { StructuredLogger } from "../metrics/day-loader.js";

const ROOT_COUNTS = {
  interaction_count: "user_initiated_interaction_count",
  code_generation_count: "code_generation_activity_count",
  code_acceptance_count: "code_acceptance_activity_count",
  loc_suggested_to_add: "loc_suggested_to_add_sum", loc_suggested_to_delete: "loc_suggested_to_delete_sum",
  loc_added: "loc_added_sum", loc_deleted: "loc_deleted_sum",
} as const;
const MEASURES = [...METRICS_DAY_MEASURES, "ai_credits_used"] as const;
const positiveId = z.union([z.number(), z.string().regex(/^\d+$/)])
  .transform((value) => Number(value)).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const measure = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rootSchema = z.object({
  user_id: positiveId, organization_id: positiveId, day: z.string(),
  ...Object.fromEntries(Object.values(ROOT_COUNTS).map((field) => [field, measure])),
}).passthrough();
const digest = (content: Uint8Array | string) => createHash("sha256").update(content).digest("hex");

export class ReconciliationReadError extends Error {
  constructor(readonly availability: "unavailable" | "unauthorized" | "incomplete") {
    super("reconciliation_read_failed");
  }
}

export function sumMetrics(rows: readonly MetricsUserEvidence[]): MetricsDayTotals {
  const totals: MetricsDayTotals = {
    interaction_count: 0, code_generation_count: 0, code_acceptance_count: 0,
    loc_suggested_to_add: 0, loc_suggested_to_delete: 0, loc_added: 0, loc_deleted: 0, ai_credits_used: "0",
  };
  let credits = 0n;
  for (const row of rows) {
    for (const key of METRICS_DAY_MEASURES) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("reconciliation_measure_invalid");
      totals[key] += row[key];
      if (!Number.isSafeInteger(totals[key])) throw new Error("reconciliation_measure_overflow");
    }
    const canonical = exactDecimal18_9(row.ai_credits_used);
    if (canonical === null || canonical.startsWith("-")) throw new Error("reconciliation_measure_invalid");
    const [whole, fraction = ""] = canonical.split(".");
    credits += BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  }
  const decimal = `${credits / 1_000_000_000n}.${(credits % 1_000_000_000n).toString().padStart(9, "0")}`;
  const canonical = exactDecimal38_9(decimal);
  if (canonical === null) throw new Error("reconciliation_measure_overflow");
  totals.ai_credits_used = canonical;
  return totals;
}

export interface ManifestOptions {
  organizationId: number;
  reportDay: string;
  provenance: MetricsDayEvidenceManifest["provenance"];
  includePerUser?: boolean;
}

function rawMetrics(content: Uint8Array, organizationId: number, reportDay: string) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const rows: MetricsUserEvidence[] = [];
  const keys = new Set<number>();
  for (const line of lines) {
    let creditToken: string | undefined;
    const creditTokens = new WeakMap<object, string | undefined>();
    const object: unknown = JSON.parse(line, function (
      this: Record<string, unknown>, key: string, value: unknown, context?: { source?: string },
    ) {
      if (key === "ai_credits_used" && typeof value === "number") {
        creditTokens.set(this, context?.source);
      }
      return value;
    });
    const root = rootSchema.parse(object);
    if (root.organization_id !== organizationId || root.day !== reportDay) throw new Error("reconciliation_scope_invalid");
    if (object !== null && typeof object === "object") creditToken = creditTokens.get(object);
    const creditPresent = root.ai_credits_used !== undefined && root.ai_credits_used !== null;
    const credit = creditPresent ? creditToken === undefined ? null : exactDecimal18_9(creditToken) : "0";
    if (credit === null || credit.startsWith("-")) throw new Error("reconciliation_credit_invalid");
    const row: MetricsUserEvidence = {
      user_id: root.user_id, interaction_count: 0, code_generation_count: 0, code_acceptance_count: 0,
      loc_suggested_to_add: 0, loc_suggested_to_delete: 0, loc_added: 0, loc_deleted: 0, ai_credits_used: credit,
    };
    for (const key of METRICS_DAY_MEASURES) row[key] = measure.parse(root[ROOT_COUNTS[key]]);
    rows.push(row);
    keys.add(row.user_id);
  }
  if (lines.length === 0) throw new Error("reconciliation_empty_evidence");
  return { text, rows, distinctUsers: keys.size, duplicates: rows.length - keys.size, lines: lines.length };
}

export function createManifest(content: Uint8Array, options: ManifestOptions): MetricsDayEvidenceManifest {
  const base = {
    schemaVersion: 1 as const, evidenceKind: METRICS_EVIDENCE_KIND,
    organizationId: options.organizationId, reportDay: options.reportDay, provenance: options.provenance,
  };
  let candidate: unknown;
  try {
    const raw = rawMetrics(content, options.organizationId, options.reportDay);
    candidate = {
      ...base, availability: "available",
      artifact: {
        sha256: digest(content), sizeBytes: content.byteLength, nonEmptyLines: raw.lines,
        jsonObjects: raw.rows.length, distinctUserKeys: raw.distinctUsers, duplicateUserKeys: raw.duplicates,
      },
      totals: sumMetrics(raw.rows),
      ...(options.includePerUser && raw.duplicates === 0 ? { perUser: raw.rows } : {}),
    };
  } catch {
    // Unmeasurable input is represented explicitly, never as zero-valued available evidence.
    candidate = { ...base, availability: "incomplete" };
  }
  const parsed = parseEvidenceManifest(candidate);
  if (!parsed.ok) throw new Error("reconciliation_manifest_options_invalid");
  return parsed.manifest;
}

export interface MetricsSnapshot {
  observed: MetricsDayObserved;
  archive: Uint8Array | null;
  rejects: readonly { lineNumber: number; sha256: string }[];
}
interface DayInput extends MetricsSnapshot {
  organizationId: number;
  reportDay: string;
  manifest: unknown;
  readFailure?: ReconciliationReadError["availability"];
}
export function emptyObserved(organizationId: number, reportDay: string): MetricsDayObserved {
  return { organizationId, reportDay, run: null, artifact: null,
    issueCounts: { reject: 0, warn: 0, fatal: 0 }, publishedFacts: null };
}
const differences = (left: MetricsDayTotals | MetricsUserEvidence, right: MetricsDayTotals | MetricsUserEvidence) =>
  MEASURES.filter((key) => left[key] !== right[key]);
const equalTotals = (left: MetricsDayTotals, right: MetricsDayTotals) => differences(left, right).length === 0;
const validCount = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;

export function compareMetricsDay(input: DayInput): { summary: MetricsDayReconciliationSummary; detail: MetricsDayReconciliationDetail } {
  const { organizationId, reportDay, observed, archive, rejects } = input;
  let parsed = parseEvidenceManifest(input.manifest);
  if (parsed.ok && (parsed.manifest.organizationId !== organizationId || parsed.manifest.reportDay !== reportDay)) {
    parsed = { ok: false, code: "invalid_evidence_manifest" };
  }
  const manifest = parsed.ok ? parsed.manifest : null;
  const available = manifest?.availability === "available" ? manifest : null;
  const evidenceCheck = evidenceAvailabilityCheck(parsed);
  if (input.manifest === undefined) evidenceCheck.outcome = "unavailable";
  if (available && (available.artifact.duplicateUserKeys > 0 || available.artifact.jsonObjects !== available.artifact.nonEmptyLines)) {
    evidenceCheck.outcome = "incomplete";
  }
  if (available?.perUser) {
    try {
      if (!equalTotals(sumMetrics(available.perUser), available.totals)) evidenceCheck.outcome = "incomplete";
    } catch {
      evidenceCheck.outcome = "incomplete";
    }
  }
  const checks: MetricsDayReconciliationDetail["checks"] = [{ ...evidenceCheck, evidenceValue: null, newValue: null }];
  const add = (
    check: MetricsCheck, outcome: MetricsCheckOutcome, evidenceValue: string | number | null, newValue: string | number | null,
    differingCount = outcome === "unexplained" || outcome === "explained" ? 1 : 0,
  ) => checks.push({
    check, outcome, evidenceValue, newValue, differingCount,
    explanation: outcome === "explained" ? "quarantined_rejects" : null,
  });
  const { run, artifact, publishedFacts: facts, issueCounts } = observed;
  const runValid = observed.organizationId === organizationId && observed.reportDay === reportDay &&
    run?.status === "published" && run.isCurrent && run.errorCode === null &&
    validCount(run.rowsRead) && validCount(run.rowsLoaded) && validCount(run.rowsQuarantined) &&
    run.rowsLoaded + run.rowsQuarantined === run.rowsRead && facts !== null && facts.rowCount === run.rowsLoaded &&
    issueCounts.fatal === 0 && Object.values(issueCounts).every(validCount);
  add("run_published", input.readFailure ? input.readFailure === "incomplete" ? "incomplete" : "unavailable" : runValid ? "matched" : "incomplete",
    null, run?.status ?? null);

  let archiveValid = false;
  let accepted: MetricsUserEvidence[] = [];
  let rawUsers: MetricsUserEvidence[] = [];
  let rawTotals: MetricsDayTotals | null = null;
  let acceptedTotals: MetricsDayTotals | null = null;
  let rejectionProof = false;
  if (archive && artifact && run && runValid) {
    try {
      const raw = rawMetrics(archive, organizationId, reportDay);
      rawUsers = raw.rows;
      const loaded = parseMetricsDay(raw.text, { organizationId, reportDay, runId: run.runId, artifactId: artifact.artifactId });
      accepted = loaded.rows.map((row) => row.daily);
      rawTotals = sumMetrics(raw.rows);
      acceptedTotals = sumMetrics(accepted);
      const rejected = loaded.issues.filter((issue) => issue.severity === "reject");
      const uniqueRejects = new Set(rejected.map((issue) => issue.line_number));
      const rejectLines = new Set(rejects.map((issue) => issue.lineNumber));
      rejectionProof = uniqueRejects.size === run.rowsQuarantined && rejectLines.size === uniqueRejects.size &&
        rejects.length === issueCounts.reject && rejected.length === issueCounts.reject &&
        rejected.every((issue) => rejects.some((row) => row.lineNumber === issue.line_number && row.sha256 === issue.raw_row_sha256)) &&
        rejects.every((row) => rejected.some((issue) => row.lineNumber === issue.line_number && row.sha256 === issue.raw_row_sha256));
      archiveValid = !loaded.fatal && raw.duplicates === 0 && digest(archive) === artifact.sha256 &&
        archive.byteLength === artifact.sizeBytes && raw.lines === artifact.rowCount &&
        loaded.linesRead === run.rowsRead && loaded.rows.length === run.rowsLoaded && rejectionProof;
    } catch {
      archiveValid = false;
    }
  }
  const rawClaimsConsistent = available !== null && artifact !== null && rawTotals !== null &&
    (available.artifact.sha256 !== artifact.sha256 || (
      available.artifact.nonEmptyLines === rawUsers.length && available.artifact.jsonObjects === rawUsers.length &&
      available.artifact.distinctUserKeys === rawUsers.length && equalTotals(available.totals, rawTotals)
    ));
  const ready = evidenceCheck.outcome === "matched" && runValid && artifact !== null && archiveValid &&
    available !== null && rawClaimsConsistent;
  const scalar = (check: MetricsCheck, left: string | number | null, right: string | number | null) =>
    add(check, !ready ? "incomplete" : left === right ? "matched" : "unexplained", left, right);
  scalar("lineage_sha256", available?.artifact.sha256 ?? null, artifact?.sha256 ?? null);
  scalar("lineage_size", available?.artifact.sizeBytes ?? null, artifact?.sizeBytes ?? null);
  scalar("row_count", available?.artifact.nonEmptyLines ?? null, artifact?.rowCount ?? null);
  scalar("rows_accounted", available?.artifact.nonEmptyLines ?? null, run?.rowsRead ?? null);

  const sqlMatchesArchive = ready && facts !== null && acceptedTotals !== null &&
    facts.rowCount === accepted.length && equalTotals(facts.totals, acceptedTotals);
  const sameArtifact = ready && available.artifact.sha256 === artifact.sha256 && available.artifact.sizeBytes === artifact.sizeBytes &&
    rawClaimsConsistent;
  // An explanation needs exact bytes, accepted-row agreement and the rejected line/hash multiset, not just a count.
  const canExplain = sameArtifact && sqlMatchesArchive && rejectionProof && run.rowsQuarantined! > 0;
  const userDelta = available && facts ? Math.abs(available.artifact.distinctUserKeys - facts.rowCount) : 0;
  add("distinct_users", !ready ? "incomplete" : userDelta === 0 ? "matched" : canExplain ? "explained" : "unexplained",
    available?.artifact.distinctUserKeys ?? null, facts?.rowCount ?? null, userDelta ? 1 : 0);
  const totalDelta = available && facts ? differences(available.totals, facts.totals).length : 0;
  add("totals", !ready ? "incomplete" : totalDelta === 0 ? "matched" : canExplain ? "explained" : "unexplained",
    available ? JSON.stringify(available.totals) : null, facts ? JSON.stringify(facts.totals) : null, totalDelta);
  // Also catch SQL/archive corruption that happens to agree with the operator manifest.
  if (ready && !sqlMatchesArchive && checks.every((check) => check.check !== "totals" || check.outcome === "matched")) {
    const check = checks.find((check) => check.check === "totals")!;
    check.outcome = "unexplained";
    check.differingCount = Math.max(1, facts && acceptedTotals ? differences(facts.totals, acceptedTotals).length : 1);
  }
  const perUserDifferences: MetricsDayReconciliationDetail["perUserDifferences"] = [];
  if (available?.perUser) {
    const newUsers = new Map(observed.perUser?.map((row) => [row.user_id, row]));
    const legacyUsers = new Map(available.perUser.map((row) => [row.user_id, row]));
    const acceptedUsers = new Map(accepted.map((row) => [row.user_id, row]));
    const rawByUser = new Map(rawUsers.map((row) => [row.user_id, row]));
    for (const user_id of new Set([...legacyUsers.keys(), ...newUsers.keys()])) {
      const left = legacyUsers.get(user_id);
      const right = newUsers.get(user_id);
      const measures = left && right ? differences(left, right) : [...MEASURES];
      if (left && right && measures.length === 0) continue;
      const rawUser = rawByUser.get(user_id);
      const explained = canExplain && left !== undefined && right === undefined && !acceptedUsers.has(user_id) &&
        rawUser !== undefined && differences(left, rawUser).length === 0;
      perUserDifferences.push({ user_id, kind: !left ? "missing_in_evidence" : !right ? "missing_in_new" : "value_mismatch",
        measures, explanation: explained ? "quarantined_rejects" : null });
    }
    const completeUsers = observed.perUser !== undefined && observed.perUser.length === facts?.rowCount &&
      newUsers.size === observed.perUser.length;
    add("per_user", !ready || !completeUsers ? "incomplete" : perUserDifferences.length === 0 ? "matched" :
      perUserDifferences.every((row) => row.explanation !== null) ? "explained" : "unexplained",
    available.perUser.length, observed.perUser?.length ?? null, perUserDifferences.length);
  }
  const status = deriveDayStatus(checks);
  const detail: MetricsDayReconciliationDetail = {
    organizationId, reportDay, status,
    evidence: manifest ? { availability: manifest.availability, sha256: available?.artifact.sha256 ?? null,
      approvalRef: manifest.provenance.approvalRef, sourceLabel: manifest.provenance.sourceLabel, retrievedAt: manifest.provenance.retrievedAt } : null,
    observed: { runId: run?.runId ?? null, runStatus: run?.status ?? null, artifactSha256: artifact?.sha256 ?? null },
    checks,
    totals: Object.fromEntries(MEASURES.map((key) => [key, { evidence: available?.totals[key] ?? null, new: facts?.totals[key] ?? null }])) as MetricsDayReconciliationDetail["totals"],
    perUserDifferences,
  };
  return {
    detail,
    summary: {
      reportDay, status,
      counts: {
        evidenceLines: available?.artifact.nonEmptyLines ?? null, newRowsRead: run?.rowsRead ?? null,
        newRowsLoaded: run?.rowsLoaded ?? null, newRowsQuarantined: run?.rowsQuarantined ?? null,
        rejectIssues: issueCounts.reject, warnIssues: issueCounts.warn, fatalIssues: issueCounts.fatal,
      },
      checks: checks.map(({ check, outcome, explanation, differingCount }) => ({ check, outcome, explanation, differingCount })),
    },
  };
}

export async function reconcileMetricsRange(
  input: { organizationId: number; from: string; to: string; correlationId: string; manifests: readonly unknown[] },
  dependencies: { read(organizationId: number, reportDay: string, perUser: boolean): Promise<MetricsSnapshot>; logger: StructuredLogger },
) {
  positiveId.parse(input.organizationId);
  z.uuid().parse(input.correlationId);
  const coverage = deriveRangeCoverage(input, []);
  if (input.manifests.length > coverage.days.length) throw new Error("reconciliation_manifest_coverage_invalid");
  const byDay = new Map<string, unknown>();
  for (const value of input.manifests) {
    // Invalid inputs retain their day only to produce incomplete coverage; never infer a valid manifest.
    const key = z.object({ reportDay: z.string() }).safeParse(value);
    if (!key.success || !coverage.days.some((day) => day.reportDay === key.data.reportDay) || byDay.has(key.data.reportDay)) {
      throw new Error("reconciliation_manifest_coverage_invalid");
    }
    byDay.set(key.data.reportDay, value);
  }
  const days: MetricsDayReconciliationSummary[] = [];
  const details: MetricsDayReconciliationDetail[] = [];
  for (const { reportDay } of coverage.days) {
    const manifest = byDay.get(reportDay);
    const parsed = parseEvidenceManifest(manifest);
    let current: MetricsSnapshot = { observed: emptyObserved(input.organizationId, reportDay), archive: null, rejects: [] };
    let readFailure: DayInput["readFailure"];
    if (parsed.ok && parsed.manifest.availability === "available" && parsed.manifest.organizationId === input.organizationId) {
      try {
        current = await dependencies.read(input.organizationId, reportDay, parsed.manifest.perUser !== undefined);
      } catch (error) {
        if (!(error instanceof ReconciliationReadError)) throw error;
        readFailure = error.availability;
        dependencies.logger.error({ event: "reconciliation_read_failed", correlationId: input.correlationId });
      }
    }
    const result = compareMetricsDay({ organizationId: input.organizationId, reportDay, manifest, ...current, readFailure });
    days.push(result.summary);
    details.push(result.detail);
  }
  const range = deriveRangeCoverage(input, days);
  const summary = assertPublicSummary({ schemaVersion: 1, evidenceKind: METRICS_EVIDENCE_KIND,
    from: input.from, to: input.to, status: range.status, days });
  dependencies.logger.info({ event: "reconciliation_completed", correlationId: input.correlationId, days: days.length });
  return { summary, details };
}
