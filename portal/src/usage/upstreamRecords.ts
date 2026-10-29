import { parseMetricsLine } from "../../upstream/src/domain/metricsParser";
import type { CopilotClientUsageTotals, CopilotMetrics } from "../../upstream/src/types/metrics";
import type { CuratedBreakdownRow, CuratedDailyRow, CuratedFamilyRow } from "./curatedRows";

export type { CuratedBreakdownRow, CuratedDailyRow, CuratedFamilyRow } from "./curatedRows";

// Keys ingestion owns; extra_json can never override them.
const RECORD_KEYS = new Set([
  "report_start_day", "report_end_day", "day", "enterprise_id", "user_id", "user_login",
  "user_initiated_interaction_count", "code_generation_activity_count", "code_acceptance_activity_count",
  "loc_added_sum", "loc_deleted_sum", "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum", "ai_credits_used",
]);

function rowKey(row: { organization_id: number; user_id: number; usage_day: string }): string {
  return `${row.organization_id}|${row.usage_day}|${row.user_id}`;
}

function locCounts(row: CuratedDailyRow | CuratedBreakdownRow) {
  return {
    code_generation_activity_count: Number(row.code_generation_count),
    code_acceptance_activity_count: Number(row.code_acceptance_count),
    loc_added_sum: Number(row.loc_added),
    loc_deleted_sum: Number(row.loc_deleted),
    loc_suggested_to_add_sum: Number(row.loc_suggested_to_add),
    loc_suggested_to_delete_sum: Number(row.loc_suggested_to_delete),
  };
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clientTotals(row: CuratedBreakdownRow): CopilotClientUsageTotals {
  const requests = row.request_count ?? 0;
  const prompt = row.prompt_tokens ?? 0;
  const output = row.output_tokens ?? 0;
  return {
    session_count: row.session_count ?? 0,
    request_count: requests,
    prompt_count: row.prompt_count ?? 0,
    token_usage: {
      output_tokens_sum: output,
      prompt_tokens_sum: prompt,
      avg_tokens_per_request: requests > 0 ? (prompt + output) / requests : 0,
    },
  };
}

/**
 * Rebuilds the upstream per-user daily records from the curated facts so the pinned upstream
 * aggregator, and therefore every upstream view, runs unchanged on SQL data.
 * Each record goes through the upstream line parser, so its normalizations (language names,
 * the synthesized `copilot_app` IDE row) apply exactly as they do to a raw report.
 * Known losses from ingestion: `used_copilot_coding_agent` equals the cloud-agent flag, and
 * `totals_by_plugin` has no upstream consumer. Report window bounds are the requested range.
 */
export function toUpstreamRecords(
  daily: readonly CuratedDailyRow[],
  breakdown: readonly CuratedBreakdownRow[],
  families: readonly CuratedFamilyRow[],
  range: { from: string; to: string },
): CopilotMetrics[] {
  const records = new Map<string, CopilotMetrics>();
  for (const row of daily) {
    const extra = Object.fromEntries(
      Object.entries(parseJson(row.extra_json)).filter(([key]) => !RECORD_KEYS.has(key)),
    );
    const record: CopilotMetrics = {
      ...extra,
      report_start_day: range.from,
      report_end_day: range.to,
      day: row.usage_day,
      enterprise_id: "",
      user_id: Number(row.user_id),
      user_login: row.user_login ?? `user-${row.user_id}`,
      user_initiated_interaction_count: Number(row.interaction_count),
      ...locCounts(row),
      ai_credits_used: Number(row.ai_credits_used),
      totals_by_ide: [],
      totals_by_feature: [],
      totals_by_language_feature: [],
      totals_by_language_model: [],
      totals_by_model_feature: [],
      used_agent: Boolean(row.used_agent),
      used_vscode_agent: Boolean(row.used_vscode_agent),
      used_chat: Boolean(row.used_chat),
      used_cli: Boolean(row.used_cli),
      used_copilot_app: Boolean(row.used_copilot_app),
      used_copilot_coding_agent: Boolean(row.used_cloud_agent),
      used_copilot_cloud_agent: Boolean(row.used_cloud_agent),
      used_copilot_code_review_active: Boolean(row.used_code_review_active),
      used_copilot_code_review_passive: Boolean(row.used_code_review_passive),
      ...(row.ai_adoption_phase_number !== null && row.ai_adoption_phase !== null
        ? {
          ai_adoption_phase: {
            phase_number: Number(row.ai_adoption_phase_number),
            phase: row.ai_adoption_phase,
            version: row.ai_adoption_phase_version ?? "",
          },
        }
        : {}),
    };
    records.set(rowKey(row), record);
  }

  for (const row of breakdown) {
    const record = records.get(rowKey(row));
    if (!record) continue;
    const interactions = Number(row.interaction_count);
    switch (row.breakdown_kind) {
      case "ide": {
        const versions = parseJson(row.version_info) as Pick<
          CopilotMetrics["totals_by_ide"][number], "last_known_ide_version" | "last_known_plugin_version"
        >;
        record.totals_by_ide.push({
          ide: row.key_1, user_initiated_interaction_count: interactions, ...locCounts(row), ...versions,
        });
        break;
      }
      case "feature":
        record.totals_by_feature.push({ feature: row.key_1, user_initiated_interaction_count: interactions, ...locCounts(row) });
        break;
      case "language_feature":
        record.totals_by_language_feature.push({ language: row.key_1, feature: row.key_2, ...locCounts(row) });
        break;
      case "language_model":
        record.totals_by_language_model.push({ language: row.key_1, model: row.key_2, ...locCounts(row) });
        break;
      case "model_feature":
        record.totals_by_model_feature.push({
          model: row.key_1, feature: row.key_2, user_initiated_interaction_count: interactions, ...locCounts(row),
        });
        break;
      case "client":
        if (row.key_1 === "copilot_cli") {
          const version = (parseJson(row.version_info).last_known_cli_version ?? {}) as {
            cli_version?: string;
            sampled_at?: string;
          };
          record.totals_by_cli = {
            ...clientTotals(row),
            ...(version.cli_version && version.sampled_at
              ? { last_known_cli_version: { cli_version: version.cli_version, sampled_at: version.sampled_at } }
              : {}),
          };
        } else if (row.key_1 === "copilot_app") {
          record.totals_by_copilot_app = clientTotals(row);
        } else if (row.key_1 === "vscode_agent") {
          record.totals_by_vscode_agent = {
            session_count: row.session_count,
            total_user_messages: row.total_user_messages,
          };
        }
        break;
    }
  }

  for (const row of families) {
    const record = records.get(rowKey(row));
    if (!record || row.family === "plugin") continue;
    const field = `totals_by_${row.family}` as const;
    const items = (record[field] ?? []) as Array<Record<string, unknown>>;
    items.push({ [row.family]: row.item_name, interaction_count: Number(row.interaction_count) });
    (record as unknown as Record<string, unknown>)[field] = items;
  }

  return [...records.values()]
    .sort((left, right) => left.day.localeCompare(right.day) || left.user_id - right.user_id)
    .flatMap((record) => parseMetricsLine(JSON.stringify(record)) ?? []);
}

/** Replaces logins with stable placeholders when the deployment does not allow per-user detail. */
export function pseudonymizeLogins(records: readonly CopilotMetrics[]): CopilotMetrics[] {
  const aliases = new Map<number, string>();
  for (const id of [...new Set(records.map(({ user_id }) => user_id))].sort((left, right) => left - right)) {
    aliases.set(id, `user ${aliases.size + 1}`);
  }
  return records.map((record) => ({ ...record, user_login: aliases.get(record.user_id) ?? "user" }));
}
