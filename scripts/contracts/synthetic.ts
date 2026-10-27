// Deterministic synthetic fixtures generated from the documented schema (docs/architecture/data-contracts.md).
// Fake IDs and example.com style names only. Regenerate with: npx tsx scripts/contracts/generate-fixtures.ts

export const WINDOW = { start: "2026-03-02", end: "2026-03-06" };
export const ORGS = [
  { id: "9000001", login: "example-org-a" },
  { id: "9000002", login: "example-org-b" },
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const counts = (r: () => number, withInteractions = true) => ({
  ...(withInteractions ? { user_initiated_interaction_count: Math.floor(r() * 20) + 1 } : {}),
  code_generation_activity_count: Math.floor(r() * 30),
  code_acceptance_activity_count: Math.floor(r() * 15),
  loc_added_sum: Math.floor(r() * 200),
  loc_deleted_sum: Math.floor(r() * 80),
  loc_suggested_to_add_sum: Math.floor(r() * 300),
  loc_suggested_to_delete_sum: Math.floor(r() * 100),
});

const FEATURES = ["code_completion", "chat_panel_ask_mode", "chat_panel_agent_mode", "agent_edit", "chat_inline", "chat_panel_plan_mode", "copilot_cli"];
const MODELS = ["model-a", "model-b", "model-c"];
const LANGS = ["typescript", "python", "go"];
const IDES = ["vscode", "jetbrains"];

export type Row = Record<string, unknown>;

export function usersDayRows(): Row[] {
  const rows: Row[] = [];
  const days = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
  for (let u = 1; u <= 12; u++) {
    const org = ORGS[u % 2]!;
    for (const [di, day] of days.entries()) {
      const r = rng(u * 1000 + di);
      if (r() < 0.25) continue;
      const feats = FEATURES.filter((_, i) => (u + i + di) % 3 !== 0 || i === 0);
      const usedCli = u % 5 === 0;
      const usedApp = u % 7 === 0;
      const row: Row = {
        report_start_day: WINDOW.start,
        report_end_day: WINDOW.end,
        day,
        enterprise_id: "9100001",
        organization_id: org.id,
        user_id: 1000000 + u,
        user_login: `example-user-${String(u).padStart(3, "0")}`,
        ...counts(r),
        ai_credits_used: Math.round(r() * 5000) / 100,
        used_agent: feats.includes("chat_panel_agent_mode") || feats.includes("agent_edit"),
        used_chat: feats.some((f) => f.startsWith("chat_")),
        used_cli: usedCli,
        used_copilot_coding_agent: u % 4 === 0,
        used_copilot_cloud_agent: u % 4 === 0,
        used_vscode_agent: u % 6 === 0,
        used_copilot_code_review_active: u % 3 === 0,
        used_copilot_code_review_passive: u % 8 === 0,
        totals_by_ide: IDES.map((ide) => ({ ide, ...counts(r) })),
        totals_by_feature: feats.map((feature) => ({ feature, ...counts(r) })),
        totals_by_language_feature: LANGS.map((language) => ({ language, feature: "code_completion", ...counts(r, false) })),
        totals_by_language_model: LANGS.map((language, i) => ({ language, model: MODELS[i % 3], ...counts(r, false) })),
        totals_by_model_feature: MODELS.map((model) => ({ model, feature: "chat_panel_ask_mode", ...counts(r) })),
        totals_by_skill: u % 2 ? [{ skill: "skill-x", interaction_count: 2 }] : [],
        totals_by_mcp: [],
      };
      if (usedCli) row.totals_by_cli = { session_count: 1, request_count: 4, prompt_count: 3, token_usage: { output_tokens_sum: 100, prompt_tokens_sum: 400, avg_tokens_per_request: 125 } };
      if (usedApp) {
        row.used_copilot_app = true;
        row.totals_by_copilot_app = { session_count: 1, request_count: 2, prompt_count: 2, token_usage: { output_tokens_sum: 10, prompt_tokens_sum: 40, avg_tokens_per_request: 25 } };
      }
      rows.push(row);
    }
  }
  return rows;
}

export function usersDayNdjson(): string {
  return usersDayRows().map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// One defect per line; the expected quarantine outcome is in INVALID_EXPECTED (same order).
export function invalidUsersDayLines(): string[] {
  const base = usersDayRows()[0]!;
  const withOut = (k: string) => {
    const { [k]: _omit, ...rest } = base;
    void _omit;
    return JSON.stringify(rest);
  };
  return [
    JSON.stringify(base),
    withOut("user_id"),
    JSON.stringify({ ...base, user_id: "abc" }),
    JSON.stringify({ ...base, day: "2026-13-45" }),
    JSON.stringify({ ...base, day: "2026-04-01" }),
    withOut("organization_id"),
    JSON.stringify({ ...base, loc_added_sum: -1 }),
    JSON.stringify(base),
    "{not json",
    JSON.stringify({ ...base, user_id: 1999999, brand_new_field: 1 }),
    JSON.stringify({ ...base, user_id: 1999998, generated_loc_sum: 4 }),
  ];
}

export const INVALID_EXPECTED: { loaded: boolean; code: string | null; severity: string | null }[] = [
  { loaded: true, code: null, severity: null },
  { loaded: false, code: "missing_user_id", severity: "reject" },
  { loaded: false, code: "missing_user_id", severity: "reject" },
  { loaded: false, code: "invalid_day", severity: "reject" },
  { loaded: false, code: "invalid_day", severity: "reject" },
  { loaded: false, code: "missing_organization_id", severity: "reject" },
  { loaded: false, code: "negative_count", severity: "reject" },
  { loaded: false, code: "duplicate_key", severity: "reject" },
  { loaded: false, code: "malformed_json", severity: "reject" },
  { loaded: true, code: "unknown_field", severity: "warn" },
  { loaded: false, code: "unsupported_schema", severity: "fatal" },
];

export const AI_CREDIT_HEADER =
  "date,username,product,sku,model,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,total_monthly_quota,organization,app_client_id,repository,cost_center_name,aic_quantity,aic_gross_amount,input,output,cache_read,cache_write";

export function aiCreditCsv(): string {
  const lines = [AI_CREDIT_HEADER];
  for (let u = 1; u <= 6; u++) {
    for (const [mi, model] of MODELS.entries()) {
      const r = rng(u * 77 + mi);
      const aic = Math.round(r() * 10000) / 100;
      lines.push(
        [
          "2026-03-02", `example-user-${String(u).padStart(3, "0")}`, "copilot", "ai_credit", model, aic.toFixed(2), "ai-credits",
          "0.01", (aic * 0.01).toFixed(4), "0", (aic * 0.01).toFixed(4), "0", ORGS[u % 2]!.login, "", "", u % 3 === 0 ? "cost-center-1" : "",
          aic.toFixed(2), (aic * 0.01).toFixed(4), Math.floor(r() * 5000), Math.floor(r() * 1000), Math.floor(r() * 3000), Math.floor(r() * 500),
        ].join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}
