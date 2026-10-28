import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { POST as vote } from "./[id]/vote/route";

const mocks = vi.hoisted(() => ({
  getAccess: vi.fn(), getPortalSqlPool: vi.fn(), listFeedback: vi.fn(), toggleFeedbackVote: vi.fn(),
}));
vi.mock("../../../authz/server", () => ({ getAccess: mocks.getAccess }));
vi.mock("../../../db/pool", () => ({ getPortalSqlPool: mocks.getPortalSqlPool }));
vi.mock("../../../feedback/sql-feedback", () => ({
  listFeedback: mocks.listFeedback, toggleFeedbackVote: mocks.toggleFeedbackVote,
}));

const access = {
  state: "authorized", breakGlass: false, namesVisible: false,
  principal: { principal_id: "00000000-0000-4000-8000-000000000001" },
  grants: [{ role: "user", scope: "self", scope_value: "" }],
};
const item = {
  itemId: 1, title: "Test feature", body: "Synthetic request", status: "open",
  votes: 1, commentCount: 0, authorDisplayName: null, createdAt: "2026-10-25T00:00:00Z",
};

describe("Feedback API gates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MODULE_FEEDBACK", "true");
    vi.stubEnv("AUTH_URL", "http://localhost");
    mocks.getAccess.mockResolvedValue(access);
    mocks.getPortalSqlPool.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["signed-out", 401, "unauthenticated"],
    ["no-access", 403, "forbidden"],
    ["unavailable", 503, "permissions_unavailable"],
  ])("denies %s before touching feedback data", async (state, status, code) => {
    mocks.getAccess.mockResolvedValue({ state, breakGlass: false });
    for (const response of [
      await GET(new NextRequest("http://localhost/api/feedback")),
      await vote(new NextRequest("http://localhost/api/feedback/1/vote", { method: "POST" }), { params: Promise.resolve({ id: "1" }) }),
    ]) {
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it("does not grant access to a break-glass-only caller", async () => {
    mocks.getAccess.mockResolvedValue({ state: "unavailable", breakGlass: true });
    expect((await GET(new NextRequest("http://localhost/api/feedback"))).status).toBe(503);
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it("returns module_disabled on both read and mutation when the flag is off", async () => {
    vi.stubEnv("MODULE_FEEDBACK", "false");
    for (const response of [
      await GET(new NextRequest("http://localhost/api/feedback")),
      await vote(new NextRequest("http://localhost/api/feedback/1/vote", { method: "POST" }), { params: Promise.resolve({ id: "1" }) }),
    ]) {
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("module_disabled");
    }
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it("returns the existing paged Feedback DTO with a correlation ID", async () => {
    mocks.listFeedback.mockResolvedValue({ rows: [item], totalItems: 1 });
    const response = await GET(new NextRequest("http://localhost/api/feedback?status=open&pageSize=25"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual([item]);
    expect(body.page).toEqual({ page: 1, pageSize: 25, totalItems: 1 });
    expect(body.meta.correlationId).toBe(response.headers.get("X-Correlation-ID"));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.listFeedback).toHaveBeenCalledWith({}, access, { page: 1, pageSize: 25, status: "open" });
  });
  it.each(["?status=private", "?page=0", "?pageSize=101"])("rejects malformed filters %s", async (query) => {
    expect((await GET(new NextRequest(`http://localhost/api/feedback${query}`))).status).toBe(400);
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it.each(["1x", "-1", "9007199254740992"])("rejects invalid item ID %s before opening SQL", async (id) => {
    expect((await vote(new NextRequest("http://localhost/api/feedback/1/vote", { method: "POST" }),
      { params: Promise.resolve({ id }) })).status).toBe(400);
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it("does not reveal an invisible parent when voting", async () => {
    mocks.toggleFeedbackVote.mockResolvedValue(null);
    const response = await vote(new NextRequest("http://localhost/api/feedback/1/vote", {
      method: "POST", headers: { origin: "http://localhost" },
    }),
      { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });
  it("returns the updated shared Feedback item after a vote", async () => {
    mocks.toggleFeedbackVote.mockResolvedValue(item);
    const response = await vote(new NextRequest("http://localhost/api/feedback/1/vote", {
      method: "POST", headers: { origin: "http://localhost" },
    }),
      { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(item);
    expect(mocks.toggleFeedbackVote).toHaveBeenCalledWith({}, access, 1);
  });
  it("reports SQL failures explicitly rather than an empty success", async () => {
    mocks.listFeedback.mockRejectedValue(new Error("SQL failed"));
    const response = await GET(new NextRequest("http://localhost/api/feedback"));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
  });
  it("denies cross-origin mutations before opening SQL", async () => {
    const response = await vote(new NextRequest("http://localhost/api/feedback/1/vote", {
      method: "POST", headers: { origin: "https://untrusted.invalid" },
    }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(403);
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it("accepts the configured numeric-loopback origin despite NextURL normalization", async () => {
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3106");
    mocks.toggleFeedbackVote.mockResolvedValue(item);
    const request = new NextRequest("http://127.0.0.1:3106/api/feedback/1/vote", {
      method: "POST", headers: { origin: "http://127.0.0.1:3106" },
    });
    expect(request.nextUrl.origin).toBe("http://localhost:3106");
    const response = await vote(request, { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect(mocks.toggleFeedbackVote).toHaveBeenCalledWith({}, access, 1);
  });
  it("uses the configured canonical origin rather than internal or forwarded host", async () => {
    vi.stubEnv("AUTH_URL", "https://portal.example.invalid/api/auth");
    mocks.toggleFeedbackVote.mockResolvedValue(item);
    const response = await vote(new NextRequest("http://internal.invalid/api/feedback/1/vote", {
      method: "POST", headers: {
        origin: "https://portal.example.invalid", host: "forged.invalid",
        "x-forwarded-host": "forwarded.invalid", "x-forwarded-proto": "http",
      },
    }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect(mocks.toggleFeedbackVote).toHaveBeenCalledWith({}, access, 1);
  });
  it.each([
    { origin: undefined }, { origin: "null" }, { origin: "not a URL" },
    { origin: "https://portal.example.invalid/path" },
    { origin: "https://user:password@portal.example.invalid" },
    { origin: "http://portal.example.invalid" },
    { origin: "https://portal.example.invalid:444" },
    { origin: "https://forged.invalid" },
    { origin: "https://forwarded.invalid" },
  ])("rejects invalid or mismatched origin $origin despite forged host headers", async ({ origin }) => {
    vi.stubEnv("AUTH_URL", "https://portal.example.invalid");
    const headers = new Headers({
      host: "forged.invalid", "x-forwarded-host": "forwarded.invalid", "x-forwarded-proto": "https",
    });
    if (origin !== undefined) headers.set("origin", origin);
    const response = await vote(new NextRequest("https://forged.invalid/api/feedback/1/vote", {
      method: "POST", headers,
    }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatchObject({
      code: "forbidden", message: "A same-origin request is required.",
    });
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
    expect(mocks.toggleFeedbackVote).not.toHaveBeenCalled();
  });
  it("does not equate localhost with the configured numeric-loopback host", async () => {
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3106");
    const response = await vote(new NextRequest("http://127.0.0.1:3106/api/feedback/1/vote", {
      method: "POST", headers: { origin: "http://localhost:3106" },
    }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(403);
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it("preserves authorization and flag gates before canonical-origin configuration", async () => {
    vi.stubEnv("AUTH_URL", undefined);
    mocks.getAccess.mockResolvedValue({ state: "no-access", breakGlass: false });
    const request = () => new NextRequest("http://localhost/api/feedback/1/vote", { method: "POST" });
    const denied = await vote(request(), { params: Promise.resolve({ id: "1" }) });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.message).toBe("You do not have permission to access Feedback.");
    mocks.getAccess.mockResolvedValue(access);
    vi.stubEnv("MODULE_FEEDBACK", "false");
    const disabled = await vote(request(), { params: Promise.resolve({ id: "1" }) });
    expect(disabled.status).toBe(404);
    expect((await disabled.json()).error.code).toBe("module_disabled");
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });
  it.each([
    { configured: undefined }, { configured: "" }, { configured: "not a URL" },
    { configured: "null" }, { configured: "file:///tmp/portal" },
    { configured: "https://user:password@portal.example.invalid" },
  ])("fails explicitly without writes for invalid AUTH_URL $configured", async ({ configured }) => {
    vi.stubEnv("AUTH_URL", configured);
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const response = await vote(new NextRequest("http://localhost/api/feedback/1/vote", {
        method: "POST", headers: { origin: "http://localhost" },
      }), { params: Promise.resolve({ id: "1" }) });
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("internal_error");
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"portal.feedback_request_failed"'));
      expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
      expect(mocks.toggleFeedbackVote).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
