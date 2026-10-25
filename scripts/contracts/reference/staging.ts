// Reference staging mapper: NDJSON line / CSV row → typed staging rows + ValidationIssues (data-contracts.md §2–§3).
// Pure and deterministic; test-only oracle for the contract; the ingestion code (a later change) implements the same rules and must pass these tests.

import { createHash } from "node:crypto";
import { normalizeLanguage } from "../../../shared/src/languages";
import {
  VALIDATION_ERROR_CODES,
  type BreakdownKind,
  type IssueSeverity,
  type StgAiCreditLineRow,
  type StgUserBreakdownRow,
  type StgUserDailyRow,
  type StgUserFamilyCountRow,
  type UsageFamily,
  type ValidationErrorCode,
} from "../../../shared/src/rows";

export interface StagedIssue {
  run_id: string;
  artifact_id: number;
  line_number: number | null;
  raw_row_sha256: string | null;
  severity: IssueSeverity;
  error_code: ValidationErrorCode;
  field_path: string | null;
  message: string;
}

export interface StagingContext {
  runId: string;
  window: { start: string; end: string };
  seen: Map<string, number>;
}

export function createStagingContext(runId: string, window: { start: string; end: string }): StagingContext {
  return { runId, window, seen: new Map() };
}

export function severityOf(code: ValidationErrorCode): IssueSeverity {
  for (const sev of ["fatal", "reject", "warn"] as const) {
    if ((VALIDATION_ERROR_CODES[sev] as readonly string[]).includes(code)) return sev;
  }
  throw new Error(`unknown validation code ${code}`);
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface UsersDayResult {
  loaded: boolean;
  daily?: StgUserDailyRow;
  breakdown: StgUserBreakdownRow[];
  families: StgUserFamilyCountRow[];
  issues: StagedIssue[];
}

const KNOWN_ROOT = new Set([
  "report_start_day", "report_end_day", "day", "enterprise_id", "organization_id", "user_id", "user_login",
  "user_initiated_interaction_count", "code_generation_activity_count", "code_acceptance_activity_count",
  "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum", "loc_added_sum", "loc_deleted_sum",
  "used_agent", "used_chat", "used_cli", "used_copilot_coding_agent", "used_copilot_cloud_agent", "used_copilot_app",
  "used_vscode_agent", "used_copilot_code_review_active", "used_copilot_code_review_passive", "ai_credits_used",
  "ai_adoption_phase", "totals_by_ide", "totals_by_feature", "totals_by_language_feature", "totals_by_language_model",
  "totals_by_model_feature", "totals_by_cli", "totals_by_copilot_app", "totals_by_vscode_agent",
  "totals_by_skill", "totals_by_custom_agent", "totals_by_mcp", "totals_by_slash_cmd", "totals_by_plugin",
]);

const INT_MAX = 2147483647;
const BIGINT_MAX = Number.MAX_SAFE_INTEGER;
const FAMILIES: readonly UsageFamily[] = ["skill", "custom_agent", "mcp", "slash_cmd", "plugin"];
const DEPRECATED = ["generated_loc_sum", "accepted_loc_sum"];
const REQUIRED_LOC = ["loc_added_sum", "loc_deleted_sum", "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const VERSION_INFO_MAX = 1000;
function pickStrings(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (typeof o[k] === "string") out[k] = o[k];
  return out;
}
// Compact JSON of the documented version objects; null when empty or too long for the NVARCHAR(1000) column.
function versionJson(parts: Obj): string | null {
  const nonEmpty = Object.values(parts).some((v) => isObj(v) && Object.keys(v).length > 0);
  if (!nonEmpty) return null;
  const json = JSON.stringify(parts);
  return json.length <= VERSION_INFO_MAX ? json : null;
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  return null;
}

// artifactId is the SourceArtifact (one download part) the line came from; line numbers restart in every part.
export function mapUsersDayLine(line: string, lineNumber: number, ctx: StagingContext, artifactId: number): UsersDayResult {
  const issues: StagedIssue[] = [];
  const issue = (code: ValidationErrorCode, field: string | null, message: string): void => {
    issues.push({ run_id: ctx.runId, artifact_id: artifactId, line_number: lineNumber, raw_row_sha256: sha(line), severity: severityOf(code), error_code: code, field_path: field, message });
  };
  const fail = (): UsersDayResult => ({ loaded: false, breakdown: [], families: [], issues });

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    issue("malformed_json", null, "line is not valid JSON");
    return fail();
  }
  if (!isObj(raw)) {
    issue("malformed_json", null, "line is not a JSON object");
    return fail();
  }

  const features = Array.isArray(raw.totals_by_feature) ? raw.totals_by_feature : [];
  const deprecated =
    DEPRECATED.some((k) => k in raw) ||
    features.some((f) => isObj(f) && DEPRECATED.some((k) => k in f)) ||
    REQUIRED_LOC.some((k) => !(k in raw));
  if (deprecated) {
    issue("unsupported_schema", null, "deprecated or missing LOC fields (old schema is not supported)");
    return fail();
  }

  const userId = toInt(raw.user_id);
  if (userId === null) {
    issue("missing_user_id", "user_id", "user_id absent or not an integer");
    return fail();
  }
  const orgId = toInt(raw.organization_id);
  if (orgId === null) {
    issue("missing_organization_id", "organization_id", "organization_id absent or non-numeric");
    return fail();
  }
  if (!isRealDate(raw.day) || raw.day < ctx.window.start || raw.day > ctx.window.end) {
    issue("invalid_day", "day", "day unparseable or outside the report window");
    return fail();
  }
  const day = raw.day;

  let negative = false;
  // Counts must fit their SQL column: INT-backed counts <= INT_MAX, BIGINT-backed LOC sums <= 2^53-1 (JSON numbers).
  const bounded = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
  const count = (obj: Obj, key: string, path: string, max = INT_MAX): number => {
    const v = obj[key];
    if (v === undefined || v === null) return 0;
    if (!bounded(v, max)) {
      negative = true;
      issue("negative_count", path, `${path} must be an integer between 0 and ${max}`);
      return 0;
    }
    return v;
  };
  const optCount = (obj: Obj, key: string, path: string, max = INT_MAX): number | null => {
    const v = obj[key];
    if (v === undefined || v === null) return null;
    if (!bounded(v, max)) {
      negative = true;
      issue("negative_count", path, `${path} must be an integer between 0 and ${max}`);
      return null;
    }
    return v;
  };

  const key = `${orgId}:${userId}:${day}`;
  const first = ctx.seen.get(key);

  const counts = (o: Obj, path: string) => ({
    interaction_count: count(o, "user_initiated_interaction_count", `${path}.user_initiated_interaction_count`),
    code_generation_count: count(o, "code_generation_activity_count", `${path}.code_generation_activity_count`),
    code_acceptance_count: count(o, "code_acceptance_activity_count", `${path}.code_acceptance_activity_count`),
    loc_suggested_to_add: count(o, "loc_suggested_to_add_sum", `${path}.loc_suggested_to_add_sum`, BIGINT_MAX),
    loc_suggested_to_delete: count(o, "loc_suggested_to_delete_sum", `${path}.loc_suggested_to_delete_sum`, BIGINT_MAX),
    loc_added: count(o, "loc_added_sum", `${path}.loc_added_sum`, BIGINT_MAX),
    loc_deleted: count(o, "loc_deleted_sum", `${path}.loc_deleted_sum`, BIGINT_MAX),
  });

  const rootCounts = counts(raw, "$");
  const bool = (k: string): boolean => raw[k] === true;

  let credits = 0;
  if (raw.ai_credits_used !== undefined && raw.ai_credits_used !== null) {
    if (typeof raw.ai_credits_used !== "number" || !Number.isFinite(raw.ai_credits_used) || raw.ai_credits_used < 0) {
      negative = true;
      issue("negative_count", "ai_credits_used", "ai_credits_used must be a finite number >= 0");
    } else credits = raw.ai_credits_used;
  }

  const breakdown: StgUserBreakdownRow[] = [];
  const families: StgUserFamilyCountRow[] = [];
  const nested = (field: string, kind: BreakdownKind, keys: (e: Obj) => [string, string] | null, withInteractions = true, version?: (e: Obj) => string | null): void => {
    const arr = raw[field];
    if (arr === undefined || arr === null) return;
    if (!Array.isArray(arr)) {
      issue("extra_nested_item", field, `${field} is not an array`);
      return;
    }
    arr.forEach((e: unknown, idx: number) => {
      const k = isObj(e) ? keys(e) : null;
      if (!isObj(e) || !k) {
        issue("extra_nested_item", `${field}[${idx}]`, "nested item has an unknown shape");
        return;
      }
      const c = counts(e, `${field}[${idx}]`);
      breakdown.push({
        run_id: ctx.runId, artifact_id: artifactId, line_number: lineNumber, item_number: breakdown.length + 1, breakdown_kind: kind,
        key_1: k[0], key_2: k[1], ...c, interaction_count: withInteractions ? c.interaction_count : 0,
        session_count: null, request_count: null, prompt_tokens: null, output_tokens: null, version_info: version ? version(e) : null,
      });
    });
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const one = (k: string) => (e: Obj): [string, string] | null => { const a = str(e[k]); return a ? [a, ""] : null; };
  const two = (a: string, b: string, normA = false) => (e: Obj): [string, string] | null => {
    const x = str(e[a]);
    const y = str(e[b]);
    return x && y ? [normA ? normalizeLanguage(x) : x, y] : null;
  };

  // Upstream types: last_known_ide_version {sampled_at, ide_version}, last_known_plugin_version {sampled_at, plugin, plugin_version}.
  const ideVersion = (e: Obj): string | null => {
    const parts: Obj = {};
    for (const [field, keys] of [["last_known_ide_version", ["ide_version", "sampled_at"]], ["last_known_plugin_version", ["plugin", "plugin_version", "sampled_at"]]] as const) {
      const o = e[field];
      if (!isObj(o)) continue;
      const picked: Obj = {};
      for (const k of keys) if (typeof o[k] === "string") picked[k] = o[k];
      if (Object.keys(picked).length) parts[field] = picked;
    }
    return versionJson(parts);
  };
  nested("totals_by_ide", "ide", one("ide"), true, ideVersion);
  nested("totals_by_feature", "feature", one("feature"));
  nested("totals_by_language_feature", "language_feature", two("language", "feature", true), false);
  nested("totals_by_language_model", "language_model", (e) => {
    const l = str(e.language), m = str(e.model);
    return l && m ? [normalizeLanguage(l), m] : null;
  }, false);
  nested("totals_by_model_feature", "model_feature", two("model", "feature"));

  const clientObject = (field: string, name: string, versionField?: string, versionKey?: string): void => {
    const o = raw[field];
    if (o === undefined || o === null) return;
    if (!isObj(o)) {
      issue("extra_nested_item", field, `${field} is not an object`);
      return;
    }
    const tu = isObj(o.token_usage) ? o.token_usage : {};
    const vo = versionField ? o[versionField] : undefined;
    const version = versionKey && isObj(vo) ? versionJson({ [versionField!]: pickStrings(vo, [versionKey, "sampled_at"]) }) : null;
    breakdown.push({
      run_id: ctx.runId, artifact_id: artifactId, line_number: lineNumber, item_number: breakdown.length + 1, breakdown_kind: "client",
      key_1: name, key_2: "", interaction_count: 0, code_generation_count: 0, code_acceptance_count: 0,
      loc_suggested_to_add: 0, loc_suggested_to_delete: 0, loc_added: 0, loc_deleted: 0,
      session_count: optCount(o, "session_count", `${field}.session_count`),
      request_count: optCount(o, "request_count", `${field}.request_count`),
      prompt_tokens: optCount(tu, "prompt_tokens_sum", `${field}.token_usage.prompt_tokens_sum`, BIGINT_MAX),
      output_tokens: optCount(tu, "output_tokens_sum", `${field}.token_usage.output_tokens_sum`, BIGINT_MAX),
      version_info: version,
    });
  };
  clientObject("totals_by_cli", "copilot_cli", "last_known_cli_version", "cli_version");
  clientObject("totals_by_copilot_app", "copilot_app");
  clientObject("totals_by_vscode_agent", "vscode_agent");

  for (const family of FAMILIES) {
    const field = `totals_by_${family}`;
    const arr = raw[field];
    if (arr === undefined || arr === null) continue;
    if (!Array.isArray(arr)) {
      issue("extra_nested_item", field, `${field} is not an array`);
      continue;
    }
    arr.forEach((e: unknown, idx: number) => {
      const name = isObj(e) ? str(e.name) : null;
      if (!isObj(e) || !name) {
        issue("extra_nested_item", `${field}[${idx}]`, "nested item has an unknown shape");
        return;
      }
      families.push({
        run_id: ctx.runId, artifact_id: artifactId, line_number: lineNumber, item_number: families.length + 1, family, item_name: name,
        interaction_count: count(e, "interaction_count", `${field}[${idx}].interaction_count`),
      });
    });
  }

  if (negative) return fail();
  if (first !== undefined) {
    issue("duplicate_key", "(organization_id,user_id,day)", `duplicate of line ${first}; first row wins`);
    return fail();
  }
  ctx.seen.set(key, lineNumber);

  const unknown = Object.keys(raw).filter((k) => !KNOWN_ROOT.has(k));
  const extra: Obj = {};
  for (const k of unknown) {
    extra[k] = raw[k];
    issue("unknown_field", k, `unknown top-level field ${k}`);
  }

  const appActivity =
    Array.isArray(raw.totals_by_ide) &&
    raw.totals_by_ide.some((e) => isObj(e) && e.ide === "copilot_app" && ["user_initiated_interaction_count", "code_generation_activity_count", "code_acceptance_activity_count", "loc_added_sum", "loc_deleted_sum", "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum"].some((k) => typeof e[k] === "number" && (e[k] as number) > 0));
  const usedApp =
    bool("used_copilot_app") || Boolean(raw.totals_by_copilot_app) || features.some((f) => isObj(f) && f.feature === "copilot_app") || appActivity;
  // Upstream derives both coding-agent flags from used_copilot_cloud_agent; we match it (data-contracts.md §4).
  const cloud = bool("used_copilot_cloud_agent");
  const phase = isObj(raw.ai_adoption_phase) ? raw.ai_adoption_phase : null;

  const daily: StgUserDailyRow = {
    run_id: ctx.runId,
    artifact_id: artifactId,
    line_number: lineNumber,
    organization_id: orgId,
    enterprise_id: toInt(raw.enterprise_id),
    user_id: userId,
    user_login: str(raw.user_login),
    usage_day: day,
    ...rootCounts,
    used_agent: bool("used_agent"),
    used_chat: bool("used_chat"),
    used_cli: bool("used_cli"),
    used_coding_agent: cloud,
    used_cloud_agent: cloud,
    used_copilot_app: usedApp,
    used_vscode_agent: bool("used_vscode_agent"),
    used_code_review_active: bool("used_copilot_code_review_active"),
    used_code_review_passive: bool("used_copilot_code_review_passive"),
    ai_credits_used: credits,
    ai_adoption_phase_number: phase ? toInt(phase.phase_number) : null,
    ai_adoption_phase: phase ? str(phase.phase) : null,
    extra_json: unknown.length ? JSON.stringify(extra) : null,
  };
  return { loaded: true, daily, breakdown, families, issues };
}

// ---- ai_credit CSV ----

const AI_COLUMNS = [
  "date", "username", "product", "sku", "model", "quantity", "unit_type", "applied_cost_per_quantity", "gross_amount",
  "discount_amount", "net_amount", "total_monthly_quota", "organization", "app_client_id", "repository", "cost_center_name",
  "aic_quantity", "aic_gross_amount", "input", "output", "cache_read", "cache_write",
] as const;
const AI_REQUIRED = ["date", "username", "model", "organization", "aic_quantity"] as const;

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// One call per CSV part. Pass the same `seen` map for every part of a run so duplicates across parts are caught.
export function parseAiCreditCsv(
  csv: string,
  runId: string,
  artifactId: number,
  seen: Map<string, string> = new Map(),
): { rows: StgAiCreditLineRow[]; issues: StagedIssue[] } {
  const issues: StagedIssue[] = [];
  const add = (lineNumber: number | null, code: ValidationErrorCode, field: string | null, message: string, raw: string | null): void => {
    issues.push({ run_id: runId, artifact_id: artifactId, line_number: lineNumber, raw_row_sha256: raw === null ? null : sha(raw), severity: severityOf(code), error_code: code, field_path: field, message });
  };
  const lines = csv.split(/\r?\n/).filter((l) => l !== "");
  if (!lines.length) {
    add(null, "unsupported_schema", null, "empty file", null);
    return { rows: [], issues };
  }
  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  const missing = AI_REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    add(1, "unsupported_schema", null, `missing required columns: ${missing.join(",")}`, lines[0]!);
    return { rows: [], issues };
  }
  for (const h of header) if (!(AI_COLUMNS as readonly string[]).includes(h)) add(1, "unknown_field", h, `unknown column ${h}`, null);

  const rows: StgAiCreditLineRow[] = [];
  lines.slice(1).forEach((l, i) => {
    const lineNumber = i + 2;
    const cells = splitCsvLine(l);
    const g = (c: string): string => {
      const idx = header.indexOf(c);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const dec = (c: string): string | null => (g(c) === "" ? null : g(c));
    const int = (c: string): number | null => (/^\d+$/.test(g(c)) ? Number(g(c)) : null);
    if (!isRealDate(g("date"))) return add(lineNumber, "invalid_day", "date", "date unparseable", l);
    if (g("username") === "" || g("model") === "") return add(lineNumber, "malformed_json", null, "username or model missing", l);
    if ([g("aic_quantity"), g("quantity"), g("gross_amount")].some((v) => v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0))) {
      return add(lineNumber, "negative_count", null, "decimal value negative or not numeric", l);
    }
    const nk = [g("date"), g("username"), g("model"), g("organization"), g("sku"), g("app_client_id"), g("repository"), g("cost_center_name")].join("|");
    const prev = seen.get(nk);
    if (prev !== undefined) return add(lineNumber, "duplicate_key", null, `duplicate of artifact ${prev}; first row wins`, l);
    seen.set(nk, `${artifactId}:${lineNumber}`);
    rows.push({
      run_id: runId, artifact_id: artifactId, line_number: lineNumber, usage_date: g("date"), username: g("username"), organization: g("organization"),
      model: g("model"), product: dec("product"), sku: dec("sku"), quantity: dec("quantity"), unit_type: dec("unit_type"),
      applied_cost_per_quantity: dec("applied_cost_per_quantity"), gross_amount: dec("gross_amount"),
      discount_amount: dec("discount_amount"), net_amount: dec("net_amount"), total_monthly_quota: dec("total_monthly_quota"),
      aic_quantity: dec("aic_quantity"), aic_gross_amount: dec("aic_gross_amount"),
      input_tokens: int("input"), output_tokens: int("output"), cache_read_tokens: int("cache_read"), cache_write_tokens: int("cache_write"),
      repository: g("repository"), app_client_id: g("app_client_id"), cost_center_name: g("cost_center_name"),
    });
  });
  return { rows, issues };
}
