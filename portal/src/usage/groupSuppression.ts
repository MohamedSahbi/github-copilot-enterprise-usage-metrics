import { CLI_CUSTOMIZATION_CATEGORIES } from "../../upstream/src/types/cliCustomizations";
import type { CopilotMetrics } from "../../upstream/src/types/metrics";

// Usage flags the upstream views count as user groups, with the totals that only exist for flagged users.
const FLAG_TOTALS = {
  used_agent: [],
  used_vscode_agent: ["totals_by_vscode_agent"],
  used_chat: [],
  used_cli: ["totals_by_cli"],
  used_copilot_app: ["totals_by_copilot_app"],
  used_copilot_coding_agent: [],
  used_copilot_cloud_agent: [],
  used_copilot_code_review_active: [],
  used_copilot_code_review_passive: [],
} as const satisfies Partial<Record<keyof CopilotMetrics, readonly (keyof CopilotMetrics)[]>>;

type FlagKey = keyof typeof FLAG_TOTALS;

class GroupCounter {
  private readonly users = new Map<string, Set<number>>();

  add(group: string, userId: number): void {
    const members = this.users.get(group) ?? new Set<number>();
    members.add(userId);
    this.users.set(group, members);
  }

  released(group: string, minGroupSize: number): boolean {
    return (this.users.get(group)?.size ?? 0) >= minGroupSize;
  }
}

function groupsOf(record: CopilotMetrics): string[] {
  const groups = [`day:${record.day}`];
  for (const row of record.totals_by_ide ?? []) {
    groups.push(`ide:${row.ide}`);
    if (row.last_known_ide_version) groups.push(`ide-version:${row.ide}|${row.last_known_ide_version.ide_version}`);
    if (row.last_known_plugin_version) {
      const { plugin, plugin_version } = row.last_known_plugin_version;
      groups.push(`plugin-version:${row.ide}|${plugin}|${plugin_version}`);
    }
  }
  for (const row of record.totals_by_feature ?? []) groups.push(`feature:${row.feature}`);
  for (const row of record.totals_by_language_feature ?? []) groups.push(`language-feature:${row.language}|${row.feature}`);
  for (const row of record.totals_by_language_model ?? []) groups.push(`language-model:${row.language}|${row.model}`);
  for (const row of record.totals_by_model_feature ?? []) groups.push(`model-feature:${row.model}|${row.feature}`);
  for (const flag of Object.keys(FLAG_TOTALS) as FlagKey[]) if (record[flag]) groups.push(`flag:${flag}`);
  if (record.ai_adoption_phase) groups.push(`phase:${record.ai_adoption_phase.phase_number}`);
  const cliVersion = record.totals_by_cli?.last_known_cli_version?.cli_version;
  if (cliVersion) groups.push(`cli-version:${cliVersion}`);
  for (const category of CLI_CUSTOMIZATION_CATEGORIES) {
    for (const row of record[`totals_by_${category}`] ?? []) {
      groups.push(`${category}:${(row as Record<string, unknown>)[category]}`);
    }
  }
  return groups;
}

/**
 * Per-group minimum-size suppression for the upstream views. Every group a view can show
 * (a day, IDE, client version, feature, language/model pair, usage flag, adoption phase or
 * CLI customization) that fewer than `minGroupSize` distinct users fall into is removed from
 * the records before aggregation, so no chart, table or derived total can show it.
 * Small days go first, and the remaining groups are counted on the days that stay.
 */
export function suppressSmallGroups(records: readonly CopilotMetrics[], minGroupSize: number): CopilotMetrics[] {
  const days = new GroupCounter();
  for (const record of records) days.add(`day:${record.day}`, record.user_id);
  const kept = records.filter((record) => days.released(`day:${record.day}`, minGroupSize));

  const counter = new GroupCounter();
  for (const record of kept) for (const group of groupsOf(record)) counter.add(group, record.user_id);
  const released = (group: string) => counter.released(group, minGroupSize);

  return kept.map((source) => {
    const record: CopilotMetrics = { ...source };
    record.totals_by_ide = (source.totals_by_ide ?? []).flatMap((row) => {
      if (!released(`ide:${row.ide}`)) return [];
      const next = { ...row };
      if (row.last_known_ide_version && !released(`ide-version:${row.ide}|${row.last_known_ide_version.ide_version}`)) {
        delete next.last_known_ide_version;
      }
      const plugin = row.last_known_plugin_version;
      if (plugin && !released(`plugin-version:${row.ide}|${plugin.plugin}|${plugin.plugin_version}`)) {
        delete next.last_known_plugin_version;
      }
      return [next];
    });
    record.totals_by_feature = (source.totals_by_feature ?? []).filter((row) => released(`feature:${row.feature}`));
    record.totals_by_language_feature = (source.totals_by_language_feature ?? [])
      .filter((row) => released(`language-feature:${row.language}|${row.feature}`));
    record.totals_by_language_model = (source.totals_by_language_model ?? [])
      .filter((row) => released(`language-model:${row.language}|${row.model}`));
    record.totals_by_model_feature = (source.totals_by_model_feature ?? [])
      .filter((row) => released(`model-feature:${row.model}|${row.feature}`));
    for (const [flag, totals] of Object.entries(FLAG_TOTALS) as [FlagKey, readonly (keyof CopilotMetrics)[]][]) {
      if (!source[flag] || released(`flag:${flag}`)) continue;
      record[flag] = false;
      for (const key of totals) delete record[key];
    }
    if (record.ai_adoption_phase && !released(`phase:${record.ai_adoption_phase.phase_number}`)) {
      delete record.ai_adoption_phase;
    }
    const cli = record.totals_by_cli;
    if (cli?.last_known_cli_version && !released(`cli-version:${cli.last_known_cli_version.cli_version}`)) {
      record.totals_by_cli = { ...cli };
      delete record.totals_by_cli.last_known_cli_version;
    }
    for (const category of CLI_CUSTOMIZATION_CATEGORIES) {
      const rows = source[`totals_by_${category}`];
      if (!rows) continue;
      const visible = rows.filter((row) => released(`${category}:${(row as Record<string, unknown>)[category]}`));
      Object.assign(record, { [`totals_by_${category}`]: visible });
      // A distinct-item count over a partly hidden list would reveal how many items were hidden.
      if (visible.length !== rows.length) Object.assign(record, { [`distinct_${category}_use_count`]: null });
    }
    return record;
  });
}
