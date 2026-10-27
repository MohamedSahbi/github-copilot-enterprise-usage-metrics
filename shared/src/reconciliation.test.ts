import { describe, expect, it } from "vitest";
import {
  assertPublicSummary,
  deriveDayStatus,
  deriveRangeCoverage,
  isPermittedExplanation,
  parseEvidenceManifest,
  ReconciliationContractError,
  REQUIRED_METRICS_CHECKS,
  type MetricsCheckResult,
  type MetricsRangeReconciliationSummary,
} from "./reconciliation";

const sha = "a".repeat(64);
const totals = {
  interaction_count: 10, code_generation_count: 8, code_acceptance_count: 4,
  loc_suggested_to_add: 100, loc_suggested_to_delete: 5, loc_added: 40, loc_deleted: 2,
  ai_credits_used: "1.25",
};
const available = {
  schemaVersion: 1,
  evidenceKind: "legacy_raw_ndjson_manifest",
  availability: "available",
  organizationId: 1001,
  reportDay: "2026-10-01",
  provenance: { sourceLabel: "legacy raw archive", retrievedAt: "2026-10-27T10:00:00Z", approvalRef: "approval-0001", toolVersion: "1" },
  artifact: { sha256: sha, sizeBytes: 2048, nonEmptyLines: 2, jsonObjects: 2, distinctUserKeys: 2, duplicateUserKeys: 0 },
  totals,
};
const perUser = [
  { user_id: 1, interaction_count: 6, code_generation_count: 5, code_acceptance_count: 2, loc_suggested_to_add: 60, loc_suggested_to_delete: 3, loc_added: 20, loc_deleted: 1, ai_credits_used: "1" },
  { user_id: 2, interaction_count: 4, code_generation_count: 3, code_acceptance_count: 2, loc_suggested_to_add: 40, loc_suggested_to_delete: 2, loc_added: 20, loc_deleted: 1, ai_credits_used: "0.25" },
];

const matched = (): MetricsCheckResult[] =>
  REQUIRED_METRICS_CHECKS.map((check) => ({ check, outcome: "matched", explanation: null, differingCount: 0 }));
const withCheck = (result: MetricsCheckResult): MetricsCheckResult[] =>
  matched().map((r) => (r.check === result.check ? result : r));

describe("legacy evidence manifest", () => {
  it("accepts an available synthetic manifest with and without private per-user rows", () => {
    expect(parseEvidenceManifest(available)).toMatchObject({ ok: true, manifest: { availability: "available" } });
    expect(parseEvidenceManifest({ ...available, perUser })).toMatchObject({ ok: true });
  });

  it("accepts non-available evidence only without artifact, totals or per-user data", () => {
    for (const availability of ["unavailable", "unauthorized", "incomplete"]) {
      const base = { schemaVersion: 1, evidenceKind: "legacy_raw_ndjson_manifest", availability, organizationId: 1001,
        reportDay: "2026-10-01", provenance: { sourceLabel: "legacy raw archive", retrievedAt: "2026-10-27T10:00:00Z", approvalRef: null, toolVersion: "1" } };
      expect(parseEvidenceManifest(base).ok).toBe(true);
      expect(parseEvidenceManifest({ ...base, artifact: available.artifact }).ok).toBe(false);
      expect(parseEvidenceManifest({ ...base, totals }).ok).toBe(false);
      expect(parseEvidenceManifest({ ...base, perUser }).ok).toBe(false);
    }
  });

  it.each([
    ["unknown key", { ...available, user_login: "x" }],
    ["other evidence kind", { ...available, evidenceKind: "legacy_enhanced_json" }],
    ["schema version", { ...available, schemaVersion: 2 }],
    ["impossible date", { ...available, reportDay: "2026-02-30" }],
    ["unsafe organization", { ...available, organizationId: 2 ** 53 }],
    ["missing approval", { ...available, provenance: { ...available.provenance, approvalRef: null } }],
    ["short sha", { ...available, artifact: { ...available.artifact, sha256: "a".repeat(63) } }],
    ["upper-case sha", { ...available, artifact: { ...available.artifact, sha256: "A".repeat(64) } }],
    ["negative size", { ...available, artifact: { ...available.artifact, sizeBytes: -1 } }],
    ["more objects than lines", { ...available, artifact: { ...available.artifact, jsonObjects: 3 } }],
    ["more users than objects", { ...available, artifact: { ...available.artifact, distinctUserKeys: 3, jsonObjects: 2 } }],
    ["fractional total", { ...available, totals: { ...totals, loc_added: 1.5 } }],
    ["numeric credits", { ...available, totals: { ...totals, ai_credits_used: 1.25 } }],
    ["negative credits", { ...available, totals: { ...totals, ai_credits_used: "-1" } }],
    ["non-canonical credits", { ...available, totals: { ...totals, ai_credits_used: "1.250" } }],
    ["per-user count mismatch", { ...available, perUser: perUser.slice(0, 1) }],
    ["duplicate per-user id", { ...available, perUser: [perUser[0], { ...perUser[1], user_id: 1 }] }],
    ["per-user with duplicate keys", { ...available, artifact: { ...available.artifact, duplicateUserKeys: 1 }, perUser }],
  ])("rejects %s without echoing input", (_name, input) => {
    const result = parseEvidenceManifest(input);
    expect(result).toEqual({ ok: false, code: "invalid_evidence_manifest" });
  });
});

describe("day status precedence", () => {
  it("is matched only when every required check matched", () => {
    expect(deriveDayStatus(matched())).toBe("matched");
    expect(deriveDayStatus(matched().slice(1))).toBe("incomplete");
    expect(deriveDayStatus([])).toBe("incomplete");
  });

  it("orders unavailable > incomplete > unexplained > explained > matched", () => {
    const explained: MetricsCheckResult = { check: "totals", outcome: "explained", explanation: "quarantined_rejects", differingCount: 1 };
    const unexplained: MetricsCheckResult = { check: "distinct_users", outcome: "unexplained", explanation: null, differingCount: 1 };
    const incomplete: MetricsCheckResult = { check: "run_published", outcome: "incomplete", explanation: null, differingCount: 0 };
    const unavailable: MetricsCheckResult = { check: "evidence_available", outcome: "unavailable", explanation: null, differingCount: 0 };
    let results = withCheck(explained);
    expect(deriveDayStatus(results)).toBe("explained");
    results = results.map((r) => (r.check === "distinct_users" ? unexplained : r));
    expect(deriveDayStatus(results)).toBe("unexplained");
    results = results.map((r) => (r.check === "run_published" ? incomplete : r));
    expect(deriveDayStatus(results)).toBe("incomplete");
    results = results.map((r) => (r.check === "evidence_available" ? unavailable : r));
    expect(deriveDayStatus(results)).toBe("unavailable");
  });

  it("treats an optional per-user check like any other once present", () => {
    expect(deriveDayStatus([...matched(), { check: "per_user", outcome: "unexplained", explanation: null, differingCount: 2 }])).toBe("unexplained");
  });

  it("counts an explanation that is missing or not permitted for the check as unexplained", () => {
    expect(deriveDayStatus(withCheck({ check: "totals", outcome: "explained", explanation: null, differingCount: 1 }))).toBe("unexplained");
    expect(deriveDayStatus(withCheck({ check: "lineage_sha256", outcome: "explained", explanation: "quarantined_rejects", differingCount: 1 }))).toBe("unexplained");
    expect(deriveDayStatus(withCheck({ check: "totals", outcome: "explained", explanation: "operator_said_so" as never, differingCount: 1 }))).toBe("unexplained");
    expect(isPermittedExplanation("totals", "quarantined_rejects")).toBe(true);
    expect(isPermittedExplanation("row_count", "quarantined_rejects")).toBe(false);
  });
});

describe("range coverage", () => {
  it("marks requested days without a result as unavailable and never matches a partial range", () => {
    const coverage = deriveRangeCoverage({ from: "2026-10-01", to: "2026-10-03" }, [
      { reportDay: "2026-10-01", status: "matched" },
      { reportDay: "2026-10-03", status: "matched" },
    ]);
    expect(coverage.days).toEqual([
      { reportDay: "2026-10-01", status: "matched" },
      { reportDay: "2026-10-02", status: "unavailable" },
      { reportDay: "2026-10-03", status: "matched" },
    ]);
    expect(coverage.status).toBe("unavailable");
  });

  it("matches a fully covered range and rejects days outside the range, duplicates and invalid ranges", () => {
    expect(deriveRangeCoverage({ from: "2026-10-01", to: "2026-10-01" }, [{ reportDay: "2026-10-01", status: "matched" }]).status).toBe("matched");
    expect(() => deriveRangeCoverage({ from: "2026-10-01", to: "2026-10-01" }, [{ reportDay: "2026-10-02", status: "matched" }])).toThrow(ReconciliationContractError);
    expect(() => deriveRangeCoverage({ from: "2026-10-01", to: "2026-10-01" }, [
      { reportDay: "2026-10-01", status: "matched" }, { reportDay: "2026-10-01", status: "unexplained" },
    ])).toThrow(ReconciliationContractError);
    expect(() => deriveRangeCoverage({ from: "2026-10-02", to: "2026-10-01" }, [])).toThrow(ReconciliationContractError);
  });
});

describe("public summary boundary", () => {
  const summary = (): MetricsRangeReconciliationSummary => ({
    schemaVersion: 1,
    evidenceKind: "legacy_raw_ndjson_manifest",
    from: "2026-10-01",
    to: "2026-10-01",
    status: "matched",
    days: [{
      reportDay: "2026-10-01",
      status: "matched",
      counts: { evidenceLines: 2, newRowsRead: 2, newRowsLoaded: 2, newRowsQuarantined: 0, rejectIssues: 0, warnIssues: 0, fatalIssues: 0 },
      checks: matched(),
    }],
  });

  it("accepts a sanitized count-only summary", () => {
    expect(assertPublicSummary(summary())).toEqual(summary());
  });

  it.each(["user_id", "organizationId", "sha256", "approvalRef", "blobPath", "login"])("rejects an extra %s key at every level", (key) => {
    const top = { ...summary(), [key]: "x" };
    const day = summary(); (day.days[0] as unknown as Record<string, unknown>)[key] = 1;
    const check = summary(); (check.days[0]!.checks[0] as unknown as Record<string, unknown>)[key] = 1;
    for (const value of [top, day, check]) {
      expect(() => assertPublicSummary(value)).toThrow(ReconciliationContractError);
    }
  });

  it("rejects a status that disagrees with its checks or coverage", () => {
    const wrongDay = summary(); wrongDay.days[0]!.checks = withCheck({ check: "totals", outcome: "unexplained", explanation: null, differingCount: 1 });
    expect(() => assertPublicSummary(wrongDay)).toThrow(ReconciliationContractError);
    const missingDay = { ...summary(), to: "2026-10-02" };
    expect(() => assertPublicSummary(missingDay)).toThrow(ReconciliationContractError);
  });

  it("rejects explanations on non-explained outcomes and errors carry no input values", () => {
    const bad = summary(); bad.days[0]!.checks = withCheck({ check: "totals", outcome: "matched", explanation: "quarantined_rejects", differingCount: 0 });
    try {
      assertPublicSummary({ ...bad, user_id: 987654321 });
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationContractError);
      expect(error).toMatchObject({ code: "invalid_public_summary" });
      expect(String((error as Error).message)).not.toContain("987654321");
    }
  });
});
