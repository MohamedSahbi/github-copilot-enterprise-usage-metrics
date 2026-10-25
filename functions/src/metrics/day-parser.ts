import { createHash } from "node:crypto";
import { z } from "zod";
import { exactDecimal18_9 } from "../../../shared/src/decimal.js";
import { FEATURE_TAXONOMY } from "../../../shared/src/features.js";
import { normalizeLanguage } from "../../../shared/src/languages.js";
import {
  VALIDATION_ERROR_CODES,
  type BreakdownKind,
  type IssueSeverity,
  type StgUserBreakdownRow,
  type StgUserDailyRow,
  type StgUserFamilyCountRow,
  type UsageFamily,
  type ValidationErrorCode,
} from "../../../shared/src/rows.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());
const INT_MAX = 2_147_483_647;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;
const FAMILIES = ["skill", "custom_agent", "mcp", "slash_cmd", "plugin"] as const satisfies readonly UsageFamily[];
const ROOT_FIELDS = new Set([
  "report_start_day", "report_end_day", "day", "enterprise_id", "organization_id", "user_id", "user_login",
  "user_initiated_interaction_count", "code_generation_activity_count", "code_acceptance_activity_count",
  "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum", "loc_added_sum", "loc_deleted_sum",
  "used_agent", "used_chat", "used_cli", "used_copilot_coding_agent", "used_copilot_cloud_agent", "used_copilot_app",
  "used_vscode_agent", "used_copilot_code_review_active", "used_copilot_code_review_passive", "ai_credits_used",
  "ai_adoption_phase", "totals_by_ide", "totals_by_feature", "totals_by_language_feature", "totals_by_language_model",
  "totals_by_model_feature", "totals_by_cli", "totals_by_copilot_app", "totals_by_vscode_agent",
  "totals_by_skill", "totals_by_custom_agent", "totals_by_mcp", "totals_by_slash_cmd", "totals_by_plugin",
]);
const DEPRECATED_FIELDS = ["generated_loc_sum", "accepted_loc_sum"] as const;
const REQUIRED_LOC_FIELDS = ["loc_added_sum", "loc_deleted_sum", "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum"] as const;
const COUNT_FIELDS = [
  ["user_initiated_interaction_count", "interaction_count", INT_MAX],
  ["code_generation_activity_count", "code_generation_count", INT_MAX],
  ["code_acceptance_activity_count", "code_acceptance_count", INT_MAX],
  ["loc_suggested_to_add_sum", "loc_suggested_to_add", SAFE_INT_MAX],
  ["loc_suggested_to_delete_sum", "loc_suggested_to_delete", SAFE_INT_MAX],
  ["loc_added_sum", "loc_added", SAFE_INT_MAX],
  ["loc_deleted_sum", "loc_deleted", SAFE_INT_MAX],
] as const;

type JsonObject = Record<string, unknown>;

export interface MetricsDayInput {
  runId: string;
  artifactId: number;
  reportDay: string;
  organizationId: number;
}

export interface MetricsValidationIssue {
  line_number: number | null;
  raw_row_sha256: string | null;
  severity: IssueSeverity;
  error_code: ValidationErrorCode;
  field_path: string | null;
  message: string;
}

export interface MappedMetricsRow {
  daily: StgUserDailyRow;
  breakdown: StgUserBreakdownRow[];
  families: StgUserFamilyCountRow[];
}

export interface ParsedMetricsDay {
  rows: MappedMetricsRow[];
  issues: MetricsValidationIssue[];
  linesRead: number;
  fatal: boolean;
}

function severityOf(code: ValidationErrorCode): IssueSeverity {
  for (const severity of ["fatal", "reject", "warn"] as const) {
    if ((VALIDATION_ERROR_CODES[severity] as readonly string[]).includes(code)) return severity;
  }
  throw new Error(`Unknown validation code: ${code}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return null;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compactVersion(value: JsonObject, field: string, allowed: readonly string[]): string | null {
  const candidate = value[field];
  if (!isObject(candidate)) return null;
  const selected: JsonObject = {};
  for (const key of allowed) if (typeof candidate[key] === "string") selected[key] = candidate[key];
  if (Object.keys(selected).length === 0) return null;
  const json = JSON.stringify({ [field]: selected });
  return json.length <= 1000 ? json : null;
}

function rawRootNumber(source: string, property: string): string | undefined {
  const whitespace = (index: number): number => {
    while (/\s/.test(source[index] ?? "")) index++;
    return index;
  };
  const stringEnd = (start: number): number => {
    for (let index = start + 1; index < source.length; index++) {
      if (source[index] === "\\") index++;
      else if (source[index] === '"') return index + 1;
    }
    return source.length;
  };
  const valueEnd = (start: number): number => {
    const first = source[start];
    if (first === '"') return stringEnd(start);
    if (first !== "{" && first !== "[") {
      let index = start;
      while (index < source.length && !/[\s,}\]]/.test(source[index] ?? "")) index++;
      return index;
    }
    const open: string[] = [];
    let quoted = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index]!;
      if (quoted) {
        if (char === "\\") index++;
        else if (char === '"') quoted = false;
      } else if (char === '"') {
        quoted = true;
      } else if (char === "{" || char === "[") {
        open.push(char);
      } else if (char === "}" || char === "]") {
        open.pop();
        if (open.length === 0) return index + 1;
      }
    }
    return source.length;
  };

  let index = whitespace(0);
  if (source[index] !== "{") return undefined;
  index = whitespace(index + 1);
  while (index < source.length && source[index] !== "}") {
    if (source[index] !== '"') return undefined;
    const keyEnd = stringEnd(index);
    const key = JSON.parse(source.slice(index, keyEnd)) as unknown;
    index = whitespace(keyEnd);
    if (source[index] !== ":") return undefined;
    const start = whitespace(index + 1);
    const end = valueEnd(start);
    if (key === property) {
      const token = source.slice(start, end);
      return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token) ? token : undefined;
    }
    index = whitespace(end);
    if (source[index] === ",") index = whitespace(index + 1);
    else break;
  }
  return undefined;
}

function parseLine(line: string, lineNumber: number, input: MetricsDayInput): {
  row: MappedMetricsRow | null;
  issues: MetricsValidationIssue[];
  fatal: boolean;
  duplicateKey: string | null;
} {
  const issues: MetricsValidationIssue[] = [];
  let duplicateKey: string | null = null;
  const addIssue = (code: ValidationErrorCode, field: string | null, message: string, hash = sha256(line)): void => {
    issues.push({ line_number: lineNumber, raw_row_sha256: hash, severity: severityOf(code), error_code: code, field_path: field, message });
  };
  const reject = (): ReturnType<typeof parseLine> => ({ row: null, issues, fatal: issues.some((issue) => issue.severity === "fatal"), duplicateKey });

  const creditTokens = new WeakMap<JsonObject, string>();
  let decoded: unknown;
  try {
    decoded = JSON.parse(line, function (this: JsonObject, key: string, value: unknown, context?: { source?: string }) {
      if (key === "ai_credits_used" && typeof value === "number" && context?.source !== undefined) {
        creditTokens.set(this, context.source);
      }
      return value;
    });
  } catch {
    addIssue("malformed_json", null, "line is not valid JSON");
    return reject();
  }
  const parsed = JsonObjectSchema.safeParse(decoded);
  if (!parsed.success) {
    addIssue("malformed_json", null, "line is not a JSON object");
    return reject();
  }
  const creditToken = (isObject(decoded) ? creditTokens.get(decoded) : undefined) ?? rawRootNumber(line, "ai_credits_used");
  const source = parsed.data;
  const featureRows = Array.isArray(source.totals_by_feature) ? source.totals_by_feature : [];
  if (
    DEPRECATED_FIELDS.some((field) => field in source) ||
    featureRows.some((entry) => isObject(entry) && DEPRECATED_FIELDS.some((field) => field in entry)) ||
    REQUIRED_LOC_FIELDS.some((field) => !(field in source))
  ) {
    addIssue("unsupported_schema", null, "deprecated or missing LOC fields; report schema is unsupported");
    return reject();
  }

  const userId = toInteger(source.user_id);
  if (userId === null || userId <= 0) {
    addIssue("missing_user_id", "user_id", "user_id is absent or not a positive integer");
    return reject();
  }
  const organizationId = toInteger(source.organization_id);
  if (organizationId === null || organizationId <= 0) {
    addIssue("missing_organization_id", "organization_id", "organization_id is absent or non-numeric");
    return reject();
  }
  if (organizationId !== input.organizationId) {
    addIssue("unsupported_schema", "organization_id", "report contains a different organization than requested");
    return { row: null, issues, fatal: true, duplicateKey: null };
  }
  if (!isCalendarDate(source.day) || source.day !== input.reportDay) {
    addIssue("invalid_day", "day", "day is invalid or does not match the requested report day");
    return reject();
  }
  duplicateKey = JSON.stringify([organizationId, userId, source.day]);

  let invalidCount = false;
  const readCounts = (object: JsonObject, path: string, required = false) => {
    const result: Record<(typeof COUNT_FIELDS)[number][1], number> = {
      interaction_count: 0, code_generation_count: 0, code_acceptance_count: 0,
      loc_suggested_to_add: 0, loc_suggested_to_delete: 0, loc_added: 0, loc_deleted: 0,
    };
    for (const [field, column, max] of COUNT_FIELDS) {
      const value = object[field];
      if (value === undefined || value === null) {
        if (required) {
          invalidCount = true;
          addIssue("negative_count", `${path}.${field}`, "required value must be a non-negative integer");
        }
        continue;
      }
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
        invalidCount = true;
        addIssue("negative_count", `${path}.${field}`, `value must be an integer between 0 and ${max}`);
        continue;
      }
      result[column] = value;
    }
    return result;
  };
  const optionalCount = (object: JsonObject, field: string, path: string, max = INT_MAX): number | null => {
    const value = object[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
      invalidCount = true;
      addIssue("negative_count", path, `value must be an integer between 0 and ${max}`);
      return null;
    }
    return value;
  };
  const counts = readCounts(source, "$", true);

  const creditValue = source.ai_credits_used;
  const creditAmount = creditValue === undefined || creditValue === null ? "0" :
    creditToken === undefined ? null : exactDecimal18_9(creditToken);
  if (creditAmount === null || creditAmount.startsWith("-")) {
    invalidCount = true;
    addIssue("negative_count", "ai_credits_used", "value must be an exact non-negative DECIMAL(18,9) number");
  }

  const breakdown: StgUserBreakdownRow[] = [];
  const families: StgUserFamilyCountRow[] = [];
  const nestedNames = new Set<string>();
  let duplicateNested = false;
  const addNested = (
    field: string,
    kind: BreakdownKind,
    identify: (entry: JsonObject) => [string, string] | null,
    interactions = true,
    version?: (entry: JsonObject) => string | null,
    normalizeFirst = false,
  ): void => {
    const items = source[field];
    if (items === undefined || items === null) return;
    if (!Array.isArray(items)) {
      addIssue("extra_nested_item", field, `${field} is not an array`);
      return;
    }
    items.forEach((item, index) => {
      const key = isObject(item) ? identify(item) : null;
      if (!isObject(item) || !key) {
        addIssue("extra_nested_item", `${field}[${index}]`, "nested item has an unsupported shape");
        return;
      }
      const first = normalizeFirst ? normalizeLanguage(key[0]) : key[0];
      if (kind === "feature" && !(first in FEATURE_TAXONOMY)) {
        addIssue("unknown_enum_value", `${field}[${index}].feature`, "feature value is not in the known taxonomy");
      }
      const identity = JSON.stringify([kind, first, key[1]]);
      if (nestedNames.has(identity)) {
        duplicateNested = true;
        addIssue("duplicate_nested_name", field, "nested list contains a duplicate key");
        return;
      }
      nestedNames.add(identity);
      const itemCounts = readCounts(item, `${field}[${index}]`);
      breakdown.push({
        run_id: input.runId, artifact_id: input.artifactId, line_number: lineNumber, item_number: breakdown.length + 1,
        breakdown_kind: kind, key_1: first, key_2: key[1], ...itemCounts,
        interaction_count: interactions ? itemCounts.interaction_count : 0,
        session_count: null, request_count: null, prompt_tokens: null, output_tokens: null,
        version_info: version?.(item) ?? null,
      });
    });
  };
  const oneKey = (field: string) => (entry: JsonObject): [string, string] | null => {
    const value = nonEmptyString(entry[field]);
    return value === null ? null : [value, ""];
  };
  const twoKeys = (first: string, second: string) => (entry: JsonObject): [string, string] | null => {
    const left = nonEmptyString(entry[first]);
    const right = nonEmptyString(entry[second]);
    return left === null || right === null ? null : [left, right];
  };
  addNested("totals_by_ide", "ide", oneKey("ide"), true, (entry) => {
    const parts: JsonObject = {};
    for (const [field, keys] of [
      ["last_known_ide_version", ["ide_version", "sampled_at"]],
      ["last_known_plugin_version", ["plugin", "plugin_version", "sampled_at"]],
    ] as const) {
      const object = entry[field];
      if (!isObject(object)) continue;
      const selected: JsonObject = {};
      for (const key of keys) if (typeof object[key] === "string") selected[key] = object[key];
      if (Object.keys(selected).length) parts[field] = selected;
    }
    return Object.keys(parts).length && JSON.stringify(parts).length <= 1000 ? JSON.stringify(parts) : null;
  });
  addNested("totals_by_feature", "feature", oneKey("feature"));
  addNested("totals_by_language_feature", "language_feature", twoKeys("language", "feature"), false, undefined, true);
  addNested("totals_by_language_model", "language_model", twoKeys("language", "model"), false, undefined, true);
  addNested("totals_by_model_feature", "model_feature", twoKeys("model", "feature"));

  const addClient = (field: string, name: string, versionField?: string, versionKey?: string): void => {
    const value = source[field];
    if (value === undefined || value === null) return;
    if (!isObject(value)) {
      addIssue("extra_nested_item", field, `${field} is not an object`);
      return;
    }
    const tokenUsage = isObject(value.token_usage) ? value.token_usage : {};
    const version = versionField && versionKey
      ? compactVersion(value, versionField, [versionKey, "sampled_at"])
      : null;
    const identity = JSON.stringify(["client", name, ""]);
    if (nestedNames.has(identity)) {
      duplicateNested = true;
      addIssue("duplicate_nested_name", field, "client list contains a duplicate key");
      return;
    }
    nestedNames.add(identity);
    breakdown.push({
      run_id: input.runId, artifact_id: input.artifactId, line_number: lineNumber, item_number: breakdown.length + 1,
      breakdown_kind: "client", key_1: name, key_2: "", interaction_count: 0, code_generation_count: 0,
      code_acceptance_count: 0, loc_suggested_to_add: 0, loc_suggested_to_delete: 0, loc_added: 0, loc_deleted: 0,
      session_count: optionalCount(value, "session_count", `${field}.session_count`),
      request_count: optionalCount(value, "request_count", `${field}.request_count`),
      prompt_tokens: optionalCount(tokenUsage, "prompt_tokens_sum", `${field}.token_usage.prompt_tokens_sum`, SAFE_INT_MAX),
      output_tokens: optionalCount(tokenUsage, "output_tokens_sum", `${field}.token_usage.output_tokens_sum`, SAFE_INT_MAX),
      version_info: version,
    });
  };
  addClient("totals_by_cli", "copilot_cli", "last_known_cli_version", "cli_version");
  addClient("totals_by_copilot_app", "copilot_app");
  addClient("totals_by_vscode_agent", "vscode_agent");

  for (const family of FAMILIES) {
    const field = `totals_by_${family}`;
    const items = source[field];
    if (items === undefined || items === null) continue;
    if (!Array.isArray(items)) {
      addIssue("extra_nested_item", field, `${field} is not an array`);
      continue;
    }
    items.forEach((item, index) => {
      const name = isObject(item) ? nonEmptyString(item[family]) : null;
      if (!isObject(item) || name === null) {
        addIssue("extra_nested_item", `${field}[${index}]`, "nested item has an unsupported shape");
        return;
      }
      const identity = JSON.stringify([family, name]);
      if (nestedNames.has(identity)) {
        duplicateNested = true;
        addIssue("duplicate_nested_name", field, "family list contains a duplicate name");
        return;
      }
      nestedNames.add(identity);
      const amount = optionalCount(item, "interaction_count", `${field}[${index}].interaction_count`);
      families.push({
        run_id: input.runId, artifact_id: input.artifactId, line_number: lineNumber, item_number: families.length + 1,
        family, item_name: name, interaction_count: amount ?? 0,
      });
    });
  }
  if (invalidCount) return reject();

  if (Object.keys(source).some((field) => !ROOT_FIELDS.has(field))) {
    addIssue("unknown_field", null, "unknown top-level field");
  }

  const appIdeActivity = Array.isArray(source.totals_by_ide) && source.totals_by_ide.some((item) =>
    isObject(item) && item.ide === "copilot_app" &&
    COUNT_FIELDS.some(([field]) => typeof item[field] === "number" && (item[field] as number) > 0));
  const usedApp =
    source.used_copilot_app === true ||
    Boolean(source.totals_by_copilot_app) ||
    featureRows.some((item) => isObject(item) && item.feature === "copilot_app") ||
    appIdeActivity;
  const cloud = source.used_copilot_cloud_agent === true;
  const phase = isObject(source.ai_adoption_phase) ? source.ai_adoption_phase : null;
  const unknown: JsonObject = {};
  for (const [field, value] of Object.entries(source)) if (!ROOT_FIELDS.has(field)) unknown[field] = value;

  const row: MappedMetricsRow = {
    daily: {
      run_id: input.runId, artifact_id: input.artifactId, line_number: lineNumber,
      organization_id: organizationId, enterprise_id: toInteger(source.enterprise_id),
      user_id: userId, user_login: nonEmptyString(source.user_login), usage_day: source.day,
      ...counts,
      used_agent: source.used_agent === true, used_chat: source.used_chat === true, used_cli: source.used_cli === true,
      used_coding_agent: cloud, used_cloud_agent: cloud, used_copilot_app: usedApp,
      used_vscode_agent: source.used_vscode_agent === true,
      used_code_review_active: source.used_copilot_code_review_active === true,
      used_code_review_passive: source.used_copilot_code_review_passive === true,
      ai_credits_used: creditAmount ?? "0",
      ai_adoption_phase_number: phase ? toInteger(phase.phase_number) : null,
      ai_adoption_phase: phase ? nonEmptyString(phase.phase) : null,
      extra_json: Object.keys(unknown).length ? JSON.stringify(unknown) : null,
    },
    breakdown,
    families,
  };
  return {
    row,
    issues,
    fatal: duplicateNested,
    duplicateKey,
  };
}

export function parseMetricsDay(content: string, input: MetricsDayInput): ParsedMetricsDay {
  const rows: MappedMetricsRow[] = [];
  const issues: MetricsValidationIssue[] = [];
  const seen = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  let linesRead = 0;
  let fatal = false;
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const lineNumber = index + 1;
    linesRead++;
    const mapped = parseLine(line, lineNumber, input);
    issues.push(...mapped.issues);
    fatal ||= mapped.fatal;
    let duplicate = false;
    if (mapped.duplicateKey !== null) {
      const first = seen.get(mapped.duplicateKey);
      if (first !== undefined) {
        duplicate = true;
        fatal = true;
        issues.push({
          line_number: lineNumber,
          raw_row_sha256: sha256(line),
          severity: "fatal",
          error_code: "duplicate_file",
          field_path: "(organization_id,user_id,day)",
          message: `duplicate user key; first occurrence was line ${first}`,
        });
      } else {
        seen.set(mapped.duplicateKey, lineNumber);
      }
    }
    if (mapped.row && !duplicate) rows.push(mapped.row);
  });
  if (linesRead === 0) {
    issues.push({
      line_number: null,
      raw_row_sha256: null,
      severity: "fatal",
      error_code: "unsupported_schema",
      field_path: null,
      message: "report contains no records",
    });
    fatal = true;
  }
  return { rows, issues, linesRead, fatal };
}
