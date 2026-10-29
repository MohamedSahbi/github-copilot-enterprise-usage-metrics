import { describe, expect, it, vi } from "vitest";
import { metricsDays, runMetricsBackfill, type MetricsBackfillDependencies } from "./backfill.js";
import { MetricsAcquisitionError } from "./report-provider.js";

describe("bounded metrics backfill", () => {
  it("defaults to yesterday in UTC and includes the full requested supported range", () => {
    expect(metricsDays(undefined, "2026-10-26")).toEqual(["2026-10-25"]);
    expect(metricsDays("2026-10-23", "2026-10-26")).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(metricsDays("2025-10-10", "2025-10-11")).toEqual(["2025-10-10"]);
    expect(metricsDays("2027-03-01", "2028-02-29")).toHaveLength(365);
  });

  it.each(["", "2026-02-30", "2026-1-01", "2026-10-26", "2026-10-27", "2025-10-25"])(
    "fails closed without silently clamping %s", (from) => {
      expect(() => metricsDays(from, "2026-10-26")).toThrow();
    },
  );

  function harness() {
    const resolveOrganization = vi.fn<MetricsBackfillDependencies["resolveOrganization"]>(async () => 123);
    const acquire = vi.fn<MetricsBackfillDependencies["acquire"]>(async () => ({ organizationId: 123, content: new Uint8Array([123, 125]) }));
    const load = vi.fn<MetricsBackfillDependencies["load"]>(async () => ({
      runId: "loader-run", status: "published" as "published" | "quarantined",
      rowsRead: 2, rowsLoaded: 2, rowsQuarantined: 0, issues: 0, artifactId: 1, blobPath: "raw/path",
    }));
    const isComplete = vi.fn<MetricsBackfillDependencies["isComplete"]>(async () => false);
    const recordFailure = vi.fn<MetricsBackfillDependencies["recordFailure"]>(async () => undefined);
    const logger = { info: vi.fn(), error: vi.fn() };
    return { resolveOrganization, acquire, load, isComplete, recordFailure, logger };
  }
  const input = { organizations: ["fixture-org"], today: "2026-10-26" };

  it("acquires complete bytes before calling the existing loader without a fabricated success run", async () => {
    const h = harness();
    await expect(runMetricsBackfill(input, h)).resolves.toMatchObject({ published: 1, gaps: 0 });
    expect(h.load).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 123, reportDay: "2026-10-25" }));
    expect(h.load.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("dry-run does not load, record failures, or publish anything", async () => {
    const h = harness();
    h.acquire.mockRejectedValue(new MetricsAcquisitionError("report_gap", true));
    await expect(runMetricsBackfill({ ...input, dryRun: true }, h)).resolves.toMatchObject({ gaps: 1, published: 0 });
    expect(h.load).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("checks individual complete days, not the maximum checkpoint", async () => {
    const h = harness();
    h.isComplete.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runMetricsBackfill({ ...input, backfillFrom: "2026-10-24", resume: true }, h))
      .resolves.toMatchObject({ skipped: 1, published: 1 });
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.isComplete.mock.calls).toEqual([[123, "2026-10-24"], [123, "2026-10-25"]]);
  });

  it("records distinct UUID acquisition failure runs and does not invoke the loader", async () => {
    const h = harness();
    h.acquire.mockRejectedValue(new MetricsAcquisitionError("report_gap", true));
    await expect(runMetricsBackfill({ ...input, backfillFrom: "2026-10-24" }, h)).resolves.toMatchObject({ gaps: 2 });
    expect(h.load).not.toHaveBeenCalled();
    const ids = h.recordFailure.mock.calls.map(([failure]) => failure.runId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it("does not count quarantined or partially loaded days as complete publication", async () => {
    const h = harness();
    h.load.mockResolvedValue({ runId: "loader-run", status: "published", rowsRead: 2, rowsLoaded: 1,
      rowsQuarantined: 1, issues: 1, artifactId: 1, blobPath: "raw/path" });
    await expect(runMetricsBackfill(input, h)).resolves.toMatchObject({ published: 0, quarantined: 1 });
  });

  it("lets persistence failures surface rather than pretending they are recorded gaps", async () => {
    const h = harness();
    h.acquire.mockRejectedValue(new MetricsAcquisitionError("report_gap", true));
    h.recordFailure.mockRejectedValue(new Error("persistence failed"));
    await expect(runMetricsBackfill(input, h)).rejects.toThrow("persistence failed");
  });

  it("checks identity again before loading and logs only safe fields", async () => {
    const h = harness();
    h.acquire.mockResolvedValue({ organizationId: 999, content: new TextEncoder().encode("SOURCE_PERSONAL_MARKER") });
    await expect(runMetricsBackfill(input, h)).resolves.toMatchObject({ gaps: 1, published: 0 });
    expect(h.load).not.toHaveBeenCalled();
    expect(JSON.stringify([...h.logger.info.mock.calls, ...h.logger.error.mock.calls]))
      .not.toContain("SOURCE_PERSONAL_MARKER");
    expect(h.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "installation_identity" }));
  });

  it("records failed identity discovery without requiring a fabricated organization ID", async () => {
    const h = harness();
    h.resolveOrganization.mockRejectedValue(new MetricsAcquisitionError("installation_identity", false));
    await expect(runMetricsBackfill(input, h)).resolves.toMatchObject({ gaps: 1, published: 0 });
    expect(h.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      organizationLogin: "fixture-org", organizationId: undefined, errorCode: "installation_identity",
    }));
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("fails invalid day selection before any network or persistence call", async () => {
    const h = harness();
    await expect(runMetricsBackfill({ ...input, backfillFrom: "2020-01-01" }, h)).rejects.toThrow();
    expect(h.resolveOrganization).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("counts a loader failure without reclassifying it as a gap and keeps loading the remaining days and organizations", async () => {
    const h = harness();
    h.load.mockRejectedValueOnce(new Error("archive_write_failed SECRET_MARKER"));
    await expect(runMetricsBackfill({ organizations: ["fixture-org", "second-org"], today: "2026-10-26",
      backfillFrom: "2026-10-24" }, h)).resolves.toMatchObject({ failed: 1, published: 3, gaps: 0 });
    expect(h.load).toHaveBeenCalledTimes(4);
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain("SECRET_MARKER");
  });

  it("resolves each organization once, and records a gap per day when that fails", async () => {
    const h = harness();
    await runMetricsBackfill({ ...input, backfillFrom: "2026-10-23" }, h);
    expect(h.resolveOrganization).toHaveBeenCalledOnce();
    const failing = harness();
    failing.resolveOrganization.mockRejectedValue(new MetricsAcquisitionError("installation_identity", false));
    await expect(runMetricsBackfill({ ...input, backfillFrom: "2026-10-24" }, failing)).resolves.toMatchObject({ gaps: 2 });
    expect(failing.recordFailure).toHaveBeenCalledTimes(2);
  });

  it("does not reclassify resume-store failures as acquisition gaps", async () => {
    const h = harness();
    h.isComplete.mockRejectedValue(new Error("resume store failed"));
    await expect(runMetricsBackfill({ ...input, resume: true }, h)).rejects.toThrow("resume store failed");
    expect(h.recordFailure).not.toHaveBeenCalled();
  });
});
