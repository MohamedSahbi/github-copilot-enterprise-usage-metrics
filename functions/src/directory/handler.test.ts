import { describe, expect, it, vi } from "vitest";
import { createDirectoryHandler } from "./handler.js";
import type { DirectorySyncDependencies } from "./sync.js";

const invocationId = "00000000-0000-0000-0000-000000000003";
const context = () => ({ invocationId, info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("real directory invocation boundary", () => {
  it("runs the use case from an injected invocation, not a dummy callback", async () => {
    const commit = vi.fn();
    const dependencies: Omit<DirectorySyncDependencies, "logger"> = {
      github: vi.fn(), graph: vi.fn(), writer: { commit }, now: () => new Date("2026-10-26T12:00:00Z"),
    };
    const handler = createDirectoryHandler(async () => ({
      provider: "csv", enterprise: "fixture-enterprise", organizations: [], attributes: { departmentAttribute: "", businessAreaAttribute: "" },
      content: new TextEncoder().encode("user_id,entra_object_id,state,entra_account_enabled\n42,00000000-0000-0000-0000-000000000001,active,true"),
    }), async () => dependencies);
    const invocation = context();
    await handler({}, invocation);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ run: expect.objectContaining({ correlation_id: invocationId, status: "published" }) }));
    expect(invocation.info).toHaveBeenCalledWith(expect.stringContaining('"event":"directory.completed"'));
    expect(dependencies.github).not.toHaveBeenCalled();
  });

  it("throws a sanitized invocation error instead of logging raw configuration/SQL exceptions", async () => {
    const handler = createDirectoryHandler(async () => { throw new Error("secret-person@example.invalid"); },
      async () => { throw new Error("must not run"); });
    const invocation = context();
    await expect(handler({}, invocation)).rejects.toThrow("directory_handler_failed");
    expect(invocation.error).toHaveBeenCalledWith(JSON.stringify({
      event: "directory.failed", code: "directory_handler_failed", correlation_id: invocationId,
    }));
    expect(JSON.stringify(invocation.error.mock.calls)).not.toContain("secret-person");
  });

  it("does not report a persisted incomplete run as a successful invocation", async () => {
    const handler = createDirectoryHandler(async () => ({
      provider: "csv", enterprise: "fixture-enterprise", organizations: [], attributes: { departmentAttribute: "", businessAreaAttribute: "" },
      content: new TextEncoder().encode("private-row@example.invalid"),
    }), async () => ({
      github: vi.fn(), graph: vi.fn(), writer: { commit: vi.fn() }, now: () => new Date("2026-10-26T12:00:00Z"),
    }));
    const invocation = context();
    await expect(handler({}, invocation)).rejects.toThrow("directory_handler_failed");
    expect(JSON.stringify(invocation.error.mock.calls)).not.toContain("private-row");
  });
});
