import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertPublicSummary, METRICS_DAY_MEASURES } from "../../../shared/src/reconciliation.js";
import { createManifest, compareMetricsDay, reconcileMetricsRange, sumMetrics } from "./report.js";
import type { MetricsDayObserved } from "../../../shared/src/reconciliation.js";

export const reportDay = "2026-03-02";
export const organizationId = 9000001;
export const provenance = {
  sourceLabel: "legacy raw", retrievedAt: "2026-03-03T00:00:00Z",
  approvalRef: "private-approval-marker", toolVersion: "1",
};
export function rawRow(user_id = 1001, overrides: Record<string, unknown> = {}) {
  return {
    day: reportDay, organization_id: organizationId, user_id, user_login: "private-identity-marker",
    user_initiated_interaction_count: 2, code_generation_activity_count: 1, code_acceptance_activity_count: 0,
    loc_suggested_to_add_sum: 3, loc_suggested_to_delete_sum: 0, loc_added_sum: 1, loc_deleted_sum: 0,
    ...overrides,
  };
}
export const bytes = (...rows: ReturnType<typeof rawRow>[]) => Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
export const options = { organizationId, reportDay, provenance, includePerUser: true };

export function snapshot(content = bytes(rawRow())) {
  const manifest = createManifest(content, options);
  if (manifest.availability !== "available" || !manifest.perUser) throw new Error("fixture invalid");
  const observed: MetricsDayObserved = {
    organizationId, reportDay,
    run: { runId: "00000000-0000-4000-8000-000000000001", status: "published", isCurrent: true,
      rowsRead: manifest.artifact.nonEmptyLines, rowsLoaded: manifest.perUser.length, rowsQuarantined: 0, errorCode: null },
    artifact: { artifactId: 1, sha256: manifest.artifact.sha256, sizeBytes: content.length, rowCount: manifest.artifact.nonEmptyLines },
    issueCounts: { reject: 0, warn: 0, fatal: 0 },
    publishedFacts: { rowCount: manifest.perUser.length, totals: manifest.totals }, perUser: manifest.perUser,
  };
  return { observed, archive: content, rejects: [] };
}
const compare = (manifest: unknown, current = snapshot()) =>
  compareMetricsDay({ organizationId, reportDay, manifest, ...current });

describe("legacy evidence manifest", () => {
  it("computes byte lineage, trimmed line/object/key counts and exact decimal totals", () => {
    const content = Buffer.from(` \r\n${JSON.stringify(rawRow()).slice(0, -1)},"ai_credits_used":123456789.123456789}\r\n\n`);
    const manifest = createManifest(content, options);
    expect(manifest).toMatchObject({
      availability: "available", artifact: {
        sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: content.length,
        nonEmptyLines: 1, jsonObjects: 1, distinctUserKeys: 1, duplicateUserKeys: 0,
      }, totals: { interaction_count: 2, ai_credits_used: "123456789.123456789" },
    });
  });
  it.each(["", "{bad", "[]", '{"user_id":1}', "\uFFFD"])("fails closed for unmeasurable input %j", (content) => {
    expect(createManifest(Buffer.from(content), options).availability).toBe("incomplete");
  });
  it("does not decode corrupt UTF8 into a plausible source row", () => {
    const content = Buffer.concat([bytes(rawRow()).subarray(0, -2), Buffer.from([0xff]), Buffer.from("}\n")]);
    expect(createManifest(content, options).availability).toBe("incomplete");
  });
  it("counts duplicate keys but never emits ambiguous per-user evidence or a match", () => {
    const content = bytes(rawRow(), rawRow());
    const manifest = createManifest(content, options);
    expect(manifest).toMatchObject({ artifact: { duplicateUserKeys: 1, distinctUserKeys: 1 } });
    expect(manifest).not.toHaveProperty("perUser");
    expect(compare(manifest).summary.status).toBe("incomplete");
  });
  it("rejects unsafe integer totals rather than rounding", () => {
    expect(createManifest(bytes(rawRow(1001, { loc_added_sum: Number.MAX_SAFE_INTEGER }), rawRow(1002)), options).availability).toBe("incomplete");
  });
});

describe("metrics day reconciliation", () => {
  it("matches independently recomputed archive and SQL evidence", () => {
    const current = snapshot();
    const { summary, detail } = compare(createManifest(current.archive, options), current);
    expect(summary.status).toBe("matched");
    expect(summary.checks).toHaveLength(9);
    expect(summary.checks.every((check) => check.outcome === "matched")).toBe(true);
    expect(detail.perUserDifferences).toEqual([]);
  });
  it.each(["unavailable", "unauthorized", "incomplete"] as const)("preserves %s evidence", (availability) => {
    const { summary } = compare({ schemaVersion: 1, evidenceKind: "legacy_raw_ndjson_manifest", organizationId, reportDay, availability, provenance });
    expect(summary.status).toBe(availability === "incomplete" ? "incomplete" : "unavailable");
  });
  it.each([undefined, {}, { schemaVersion: 99 }])("never matches missing or invalid manifest", (manifest) => {
    expect(compare(manifest).summary.status).toBe(manifest === undefined ? "unavailable" : "incomplete");
  });
  it("rejects a valid manifest for another day or organization", () => {
    const manifest = createManifest(bytes(rawRow()), options);
    expect(compare({ ...manifest, organizationId: organizationId + 1 }).summary.status).toBe("incomplete");
    expect(compare({ ...manifest, reportDay: "2026-03-01" }).summary.status).toBe("incomplete");
  });
  it.each(["run", "artifact", "publishedFacts", "archive"] as const)("fails closed without %s", (key) => {
    const current = snapshot();
    const { summary } = compareMetricsDay({ organizationId, reportDay, manifest: createManifest(current.archive, options), ...current, [key === "archive" ? "archive" : "observed"]: key === "archive" ? null : { ...current.observed, [key]: null } });
    expect(summary.status).not.toBe("matched");
  });
  it("detects tampered archives even when the supplied manifest and SQL agree", () => {
    const current = snapshot();
    const manifest = createManifest(current.archive, options);
    current.archive = bytes(rawRow(1001, { user_initiated_interaction_count: 9 }));
    expect(compare(manifest, current).summary.status).toBe("incomplete");
  });
  it("reports SQL differences and private per-user differences", () => {
    const current = snapshot();
    const manifest = createManifest(current.archive, options);
    current.observed.perUser = current.observed.perUser!.map((row) => ({ ...row, interaction_count: 9 }));
    current.observed.publishedFacts!.totals = sumMetrics(current.observed.perUser);
    const result = compare(manifest, current);
    expect(result.summary.status).toBe("unexplained");
    expect(result.summary.checks.find((check) => check.check === "totals")).toMatchObject({ differingCount: 1, outcome: "unexplained" });
    expect(result.detail.perUserDifferences).toEqual([{ user_id: 1001, kind: "value_mismatch", measures: ["interaction_count"], explanation: null }]);
  });
  it("explains only exact archive rejects supported by SQL line/hash evidence", () => {
    const content = bytes(rawRow(), rawRow(1002, { totals_by_cli: { prompt_count: -1 } }));
    const current = snapshot(content);
    const manifest = createManifest(content, options);
    current.observed.perUser = current.observed.perUser!.slice(0, 1);
    current.observed.publishedFacts = { rowCount: 1, totals: sumMetrics(current.observed.perUser) };
    current.observed.run!.rowsLoaded = 1;
    current.observed.run!.rowsQuarantined = 1;
    current.observed.issueCounts.reject = 1;
    const rejects = [{ lineNumber: 2, sha256: createHash("sha256").update(content.toString().split("\n")[1]!).digest("hex") }];
    const result = compareMetricsDay({ organizationId, reportDay, manifest, ...current, rejects });
    expect(result.summary.status).toBe("explained");
    expect(result.summary.checks.filter((check) => check.outcome === "explained").map((check) => check.check)).toEqual(["distinct_users", "totals", "per_user"]);
    expect(compare(manifest, current).summary.status).toBe("incomplete");
    expect(compareMetricsDay({ organizationId, reportDay, manifest, ...current, rejects: [{ ...rejects[0]!, sha256: "0".repeat(64) }] }).summary.status).toBe("incomplete");
  });
  it("never explains a SQL mismatch merely because a reject exists", () => {
    const current = snapshot();
    current.observed.issueCounts.reject = 1;
    current.observed.publishedFacts!.totals = { ...current.observed.publishedFacts!.totals, interaction_count: 9 };
    expect(compare(createManifest(current.archive, options), current).summary.status).not.toBe("explained");
  });
  it("does not explain fabricated manifest totals even with genuine archive rejects", () => {
    const content = bytes(rawRow(), rawRow(1002, { totals_by_cli: { prompt_count: -1 } }));
    const current = snapshot(content);
    current.observed.perUser = current.observed.perUser!.slice(0, 1);
    current.observed.publishedFacts = { rowCount: 1, totals: sumMetrics(current.observed.perUser) };
    current.observed.run!.rowsLoaded = 1;
    current.observed.run!.rowsQuarantined = 1;
    current.observed.issueCounts.reject = 1;
    const manifest = createManifest(content, { ...options, includePerUser: false });
    if (manifest.availability !== "available") throw new Error("fixture invalid");
    manifest.totals.interaction_count = 500;
    const result = compareMetricsDay({
      organizationId, reportDay, manifest, ...current,
      rejects: [{ lineNumber: 2, sha256: createHash("sha256").update(content.toString().split("\n")[1]!).digest("hex") }],
    });
    expect(result.summary.status).toBe("unexplained");
    expect(result.summary.checks.find((check) => check.check === "totals")!.explanation).toBeNull();
  });
  it("never matches accepted-only manifest claims against a larger same-digest raw archive", () => {
    const content = bytes(rawRow(), rawRow(1002, { totals_by_cli: { prompt_count: -1 } }));
    const current = snapshot(content);
    current.observed.perUser = current.observed.perUser!.slice(0, 1);
    current.observed.publishedFacts = { rowCount: 1, totals: sumMetrics(current.observed.perUser) };
    current.observed.run!.rowsLoaded = 1;
    current.observed.run!.rowsQuarantined = 1;
    current.observed.issueCounts.reject = 1;
    const manifest = createManifest(content, { ...options, includePerUser: false });
    if (manifest.availability !== "available") throw new Error("fixture invalid");
    manifest.artifact.distinctUserKeys = 1;
    manifest.totals = current.observed.publishedFacts.totals;
    const result = compareMetricsDay({
      organizationId, reportDay, manifest, ...current,
      rejects: [{ lineNumber: 2, sha256: createHash("sha256").update(content.toString().split("\n")[1]!).digest("hex") }],
    });
    expect(result.summary.status).toBe("incomplete");
  });
  it("treats fatal, unpublished and accounting-inconsistent runs as incomplete", () => {
    for (const change of [{ status: "failed" as const }, { isCurrent: false }, { rowsRead: null }, { rowsLoaded: 99 }, { errorCode: "quarantined" }]) {
      const current = snapshot();
      Object.assign(current.observed.run!, change);
      expect(compare(createManifest(current.archive, options), current).summary.status).toBe("incomplete");
    }
    const current = snapshot();
    current.observed.issueCounts.fatal = 1;
    expect(compare(createManifest(current.archive, options), current).summary.status).toBe("incomplete");
  });
  it("does not trust inconsistent per-user manifest claims", () => {
    const manifest = createManifest(bytes(rawRow()), options);
    if (manifest.availability !== "available") throw new Error("fixture invalid");
    manifest.totals.interaction_count = 0;
    expect(compare(manifest).summary.status).not.toBe("matched");
  });
});

describe("range coverage and privacy", () => {
  it("includes uncovered days and gates every public artifact with the strict contract", async () => {
    const current = snapshot();
    const events: unknown[] = [];
    const result = await reconcileMetricsRange({
      organizationId, from: reportDay, to: "2026-03-03", correlationId: "00000000-0000-4000-8000-000000000002",
      manifests: [createManifest(current.archive, options)],
    }, { read: async () => current, logger: { info: (event) => events.push(event), error: (event) => events.push(event) } });
    expect(result.summary.status).toBe("unavailable");
    expect(result.summary.days.map((day) => day.status)).toEqual(["matched", "unavailable"]);
    expect(assertPublicSummary(result.summary)).toEqual(result.summary);
    const publicText = JSON.stringify([result.summary, events]);
    for (const marker of ["private-identity-marker", provenance.approvalRef, current.observed.artifact!.sha256, String(organizationId), "user_id", "blob_path"]) {
      expect(publicText).not.toContain(marker);
    }
    expect(Object.keys(events[0] as object).sort()).toEqual(["correlationId", "days", "event"]);
    expect(METRICS_DAY_MEASURES).toHaveLength(7);
  });
  it("propagates unavailable new-store reads as unavailable, never as empty facts", async () => {
    const { ReconciliationReadError } = await import("./report.js");
    const events: unknown[] = [];
    const result = await reconcileMetricsRange({
      organizationId, from: reportDay, to: reportDay, correlationId: "00000000-0000-4000-8000-000000000002",
      manifests: [createManifest(bytes(rawRow()), options)],
    }, { read: async () => { throw new ReconciliationReadError("unavailable"); },
      logger: { info: (event) => events.push(event), error: (event) => events.push(event) } });
    expect(result.summary.status).toBe("unavailable");
    expect(events).toHaveLength(2);
  });
});
