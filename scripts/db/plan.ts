// Pure migration rules: file naming (D-48) and the plan of what to apply, given the files and the history table.

export type MigrationErrorCode =
  | "INVALID_NAME"
  | "CHECKSUM_MISMATCH"
  | "CHECKSUM_MISSING"
  | "FILE_MISSING"
  | "LOCK_TIMEOUT";

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationFile {
  version: number;
  name: string;
  md5: string;
  filename: string;
}

export interface AppliedMigration {
  version: number;
  name: string | null;
  md5: string | null;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  outOfOrder: number[];
}

// Forward-only `.do.` names only. The restricted description keeps names safe to embed in the history insert.
const NAME = /^(\d{14})\.do\.([a-z0-9][a-z0-9_-]*)\.sql$/;

export function parseMigrationName(filename: string): { version: number; name: string } {
  const m = NAME.exec(filename);
  if (!m) {
    throw new MigrationError(
      "INVALID_NAME",
      `Invalid migration file name "${filename}"; expected yyyyMMddHHmmss.do.description.sql (lowercase, forward-only)`,
    );
  }
  return { version: Number(m[1]), name: m[2] as string };
}

// Validates every applied migration first, so a changed or missing file applies nothing.
// A file older than the newest applied version is still applied (parallel PRs can merge out of timestamp order).
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const appliedVersions = new Set(applied.map((a) => a.version));

  for (const row of [...applied].sort((a, b) => a.version - b.version)) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError("FILE_MISSING", `Applied migration ${row.version} (${row.name ?? "unnamed"}) has no file on disk`);
    }
    if (!row.md5) {
      throw new MigrationError("CHECKSUM_MISSING", `Applied migration ${row.version} has no recorded checksum; refusing to continue`);
    }
    if (row.md5 !== file.md5) {
      throw new MigrationError(
        "CHECKSUM_MISMATCH",
        `Checksum of applied migration ${row.version} (${file.name}) changed since it was applied; add a new migration instead of editing a merged one`,
      );
    }
  }

  const newest = Math.max(0, ...appliedVersions);
  const pending = files.filter((f) => !appliedVersions.has(f.version)).sort((a, b) => a.version - b.version);
  return { pending, outOfOrder: pending.filter((f) => f.version < newest).map((f) => f.version) };
}
