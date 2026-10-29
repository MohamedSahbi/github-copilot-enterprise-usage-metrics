import { randomUUID } from "node:crypto";
import { isGuid, type DirectoryAttributeSettings } from "../../../shared/src/access.js";
import { DirectoryInputError, parseDirectoryCsv } from "../../../shared/src/directory-input.js";
import type { DirectorySyncStateRow, IngestionRunRow } from "../../../shared/src/rows.js";
import { collectDirectoryIdentities, DirectoryProviderError, readGraphProfile,
  type DirectoryProfile, type DirectoryTransport } from "./providers.js";

export interface DirectoryCommit {
  run: IngestionRunRow;
  users: DirectoryProfile[];
  sync: DirectorySyncStateRow[];
  managerCheckUserIds: number[];
}
export interface DirectoryWriter {
  commit(command: DirectoryCommit): Promise<void>;
}
export interface DirectoryLogger {
  info(event: Readonly<Record<string, string | number>>): void;
  warn(event: Readonly<Record<string, string | number>>): void;
  error(event: Readonly<Record<string, string | number>>): void;
}
export interface DirectorySyncDependencies {
  github: DirectoryTransport;
  graph: DirectoryTransport;
  writer: DirectoryWriter;
  logger: DirectoryLogger;
  now: () => Date;
}
interface DirectorySyncBase {
  enterprise: string;
  organizations: readonly string[];
  attributes: DirectoryAttributeSettings;
  runId?: string;
  correlationId?: string;
}
export type DirectorySyncInput = DirectorySyncBase & (
  | { provider: "entra" }
  | { provider: "csv"; content: Uint8Array }
);
export interface DirectorySyncResult {
  runId: string;
  status: "published" | "failed";
  rowsLoaded: number;
  unmappedLicensedProfiles: number;
}

export async function syncDirectory(input: DirectorySyncInput, deps: DirectorySyncDependencies): Promise<DirectorySyncResult> {
  const runId = input.runId ?? randomUUID();
  const correlationId = input.correlationId ?? runId;
  if (!isGuid(runId) || !isGuid(correlationId) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(input.enterprise)) {
    throw new DirectoryProviderError("invalid_population");
  }
  const startedAt = deps.now().toISOString();
  const users: DirectoryProfile[] = [];
  let managerCheckUserIds: number[] = [];
  let rowsRead: number | null = null;
  let unmapped: number | null = null;
  let profilesFailed = 0;
  let errorCode: string | null = null;
  deps.logger.info({ event: "directory.started", correlation_id: correlationId });
  try {
    if (input.provider === "csv") {
      const rows = parseDirectoryCsv(input.content);
      if (rows.some((row) => row.manager_entra_object_id !== null &&
          (row.manager_email === null || !/^[^\s@]+@[^\s@]+$/.test(row.manager_email)))) {
        throw new DirectoryInputError("invalid_row");
      }
      users.push(...rows.map((user) => ({ user, managerResolved: true, errorCode: null } as const)));
      managerCheckUserIds = rows.map(({ user_id }) => user_id);
      rowsRead = rows.length;
      unmapped = 0;
    } else {
      const population = await collectDirectoryIdentities(deps.github, input.enterprise, input.organizations);
      managerCheckUserIds = population.licensedUserIds;
      rowsRead = population.licensedSeats;
      unmapped = population.unmappedLicensedProfiles;
      if (unmapped > 0) {
        errorCode = "unmapped_licensed_profiles";
        deps.logger.warn({ event: "directory.unmapped_licensed_profiles", code: "unmapped_licensed_profiles",
          correlation_id: correlationId, unmapped_licensed_count: unmapped });
      }
      for (const identity of population.identities) {
        try {
          const profile = await readGraphProfile(deps.graph, identity, input.attributes);
          users.push(profile);
          errorCode ??= profile.errorCode;
        } catch (error) {
          if (!(error instanceof DirectoryProviderError)) throw error;
          if (error.code === "profile_read_failed") {
            profilesFailed++;
            deps.logger.warn({ event: "directory.profile_skipped", code: error.code,
              correlation_id: correlationId, login: identity.login, user_id: identity.userId });
          } else {
            errorCode ??= error.code;
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof DirectoryInputError) && !(error instanceof DirectoryProviderError)) throw error;
    errorCode = error.code;
  }
  const completedAt = deps.now().toISOString();
  const quarantined = (unmapped ?? 0) + profilesFailed;
  const status = errorCode === null ? "published" : "failed";
  const sources: DirectorySyncStateRow["source"][] = input.provider === "csv" ? ["csv"] : ["scim", "seats", "graph"];
  const run: IngestionRunRow = {
    run_id: runId, source_kind: "directory", scope_key: input.enterprise,
    report_day: null, range_start: null, range_end: null, status, is_current: false,
    transform_version: "1", attempt: 1, rows_read: rowsRead, rows_loaded: users.length,
    rows_quarantined: quarantined > 0 || unmapped !== null ? quarantined : null,
    error_code: errorCode, correlation_id: correlationId,
    started_at: startedAt, completed_at: completedAt,
  };
  // A NULL success is a preserve instruction to the SQL writer, never a successful empty result.
  await deps.writer.commit({ run, users, sync: sources.map((source) => ({
    source, last_attempt_at: completedAt, last_success_at: status === "published" ? completedAt : null,
    last_error_code: errorCode,
  })), managerCheckUserIds });
  const event = { event: "directory.completed", correlation_id: correlationId, status,
    rows_read: rowsRead ?? 0, rows_loaded: users.length, code: errorCode ?? "complete" };
  if (status === "failed") deps.logger.error(event);
  else deps.logger.info(event);
  return { runId, status, rowsLoaded: users.length, unmappedLicensedProfiles: unmapped ?? 0 };
}
