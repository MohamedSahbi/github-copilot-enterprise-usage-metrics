import { mkdtemp, mkdir, readFile, rm, symlink, chmod, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardPrivateOutput, writePrivateJson, writePublicSummary, runMetricsReconciliationCommand } from "./metrics.js";

const directories: string[] = [];
async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "reconciliation-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe("owner-approved private evidence output", () => {
  it("requires explicit approval and an existing private directory, not the repository", async () => {
    const directory = await privateDirectory();
    await expect(guardPrivateOutput({ directory, approvalRef: "" })).rejects.toThrow("reconciliation_private_output_invalid");
    await expect(guardPrivateOutput({ directory: process.cwd(), approvalRef: "approved" })).rejects.toThrow("reconciliation_private_output_invalid");
    await expect(guardPrivateOutput({ directory: join(directory, "absent"), approvalRef: "approved" })).rejects.toThrow("reconciliation_private_output_invalid");
    await expect(guardPrivateOutput(undefined)).rejects.toThrow("reconciliation_private_output_invalid");
  });
  it("rejects shared permissions and symlink destinations", async () => {
    const directory = await privateDirectory();
    const shared = join(directory, "shared");
    await mkdir(shared);
    await chmod(shared, 0o755);
    await expect(guardPrivateOutput({ directory: shared, approvalRef: "approved" })).rejects.toThrow();
    const link = join(directory, "link");
    await symlink(directory, link);
    await expect(guardPrivateOutput({ directory: link, approvalRef: "approved" })).rejects.toThrow();
  });
  it("creates private evidence exclusively with owner-only permissions and never overwrites", async () => {
    const directory = await privateDirectory();
    const target = await guardPrivateOutput({ directory, approvalRef: "approved" });
    await writePrivateJson(target, "manifest.json", { private: "marker" });
    expect(await readFile(join(directory, "manifest.json"), "utf8")).toContain("marker");
    expect((await stat(join(directory, "manifest.json"))).mode & 0o777).toBe(0o600);
    await expect(writePrivateJson(target, "manifest.json", {})).rejects.toThrow("reconciliation_private_write_failed");
    await expect(writePrivateJson(target, "../escape.json", {})).rejects.toThrow();
  });
  it("does not pass private values or unknown fields through the public output gate", async () => {
    const directory = await privateDirectory();
    const write = vi.fn();
    await expect(writePublicSummary(join(directory, "public.json"), { user_id: 1001 }, write)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("generates a manifest from one supplied local synthetic file without a source client", async () => {
    const directory = await privateDirectory();
    const localRawFile = join(directory, "synthetic.ndjson");
    await writeFile(localRawFile, JSON.stringify({
      organization_id: 9000001, user_id: 1001, day: "2026-03-02",
      user_initiated_interaction_count: 2, code_generation_activity_count: 1, code_acceptance_activity_count: 0,
      loc_suggested_to_add_sum: 3, loc_suggested_to_delete_sum: 0, loc_added_sum: 1, loc_deleted_sum: 0,
    }) + "\n");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await runMetricsReconciliationCommand({
        mode: "manifest", organizationId: 9000001, reportDay: "2026-03-02", localRawFile,
        provenance: { sourceLabel: "legacy raw", retrievedAt: "2026-03-03T00:00:00Z", approvalRef: "private-marker", toolVersion: "1" },
        privateOutput: { directory, approvalRef: "owner-private-marker" }, includePerUser: false,
      });
      const file = (await readdir(directory)).find((name) => name.startsWith("manifest-"))!;
      expect(JSON.parse(await readFile(join(directory, file), "utf8"))).toMatchObject({
        availability: "available", artifact: { nonEmptyLines: 1 }, totals: { interaction_count: 2 },
      });
      const output = JSON.stringify(log.mock.calls);
      for (const marker of [directory, "private-marker", "9000001", "sha256", "user_id"]) expect(output).not.toContain(marker);
    } finally { log.mockRestore(); }
  });
  it("rejects unknown configuration and lacks any implicit private destination", async () => {
    await expect(runMetricsReconciliationCommand({ mode: "manifest", localRawFile: "/placeholder" }))
      .rejects.toThrow("reconciliation_config_invalid");
  });
});
