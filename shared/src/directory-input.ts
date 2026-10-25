import { z } from "zod";
import { isGuid } from "./access";
import { csvRecords, CsvSyntaxError } from "./csv";
import { normalizeDirectoryValue } from "./settings";
import type { DimUserRow } from "./rows";

const guid = z.string().refine(isGuid, "must be a GUID");
const text = (max: number) => z.string().trim().min(1).max(max).nullable().default(null);
const attribute = (max: number) => z.string().transform((value) => normalizeDirectoryValue(value) || null)
  .pipe(z.string().max(max).nullable()).nullable().default(null);

// Canonical directory adapter output, not a provider response or an authorization decision.
export const DirectoryUserSchema = z.strictObject({
  user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entra_object_id: guid,
  entra_account_enabled: z.boolean(),
  state: z.enum(["active", "deleted", "suspended"]),
  login: text(255),
  email: text(320),
  display_name: text(255),
  manager_entra_object_id: guid.nullable().default(null),
  manager_email: text(320),
  department: attribute(100),
  business_area: attribute(50),
});
export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;
type DirectoryField = keyof DirectoryUser & (keyof DimUserRow | "entra_account_enabled");

export const DIRECTORY_CSV_REQUIRED = ["user_id", "entra_object_id", "state", "entra_account_enabled"] as const satisfies readonly DirectoryField[];
export const DIRECTORY_CSV_OPTIONAL = [
  "login", "email", "display_name", "manager_entra_object_id", "manager_email", "department", "business_area",
] as const satisfies readonly DirectoryField[];

export type DirectoryInputErrorCode =
  | "invalid_encoding" | "invalid_csv" | "invalid_header" | "invalid_row" | "duplicate_identity";

// Never retain offending values, source rows or schema-library error objects (they can contain PII).
export class DirectoryInputError extends Error {
  constructor(readonly code: DirectoryInputErrorCode, readonly lineNumber: number | null = null) {
    super(`Directory input rejected: ${code}`);
    this.name = "DirectoryInputError";
  }
}

export function parseDirectoryCsv(bytes: Uint8Array): DirectoryUser[] {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new DirectoryInputError("invalid_encoding");
  }
  if (source.includes("\0")) throw new DirectoryInputError("invalid_encoding");
  let records;
  try {
    records = csvRecords(source);
  } catch (error) {
    if (!(error instanceof CsvSyntaxError)) throw error;
    throw new DirectoryInputError("invalid_csv", error.lineNumber);
  }
  const first = records[0];
  const allowed: readonly string[] = [...DIRECTORY_CSV_REQUIRED, ...DIRECTORY_CSV_OPTIONAL];
  if (!first || new Set(first.cells).size !== first.cells.length ||
      first.cells.some((field) => !allowed.includes(field)) ||
      DIRECTORY_CSV_REQUIRED.some((field) => !first.cells.includes(field))) {
    throw new DirectoryInputError("invalid_header", first?.lineNumber ?? null);
  }
  const ids = new Set<number>(), entraIds = new Set<string>();
  return records.slice(1).map(({ cells, lineNumber }) => {
    if (cells.length !== first.cells.length) throw new DirectoryInputError("invalid_row", lineNumber);
    const input: Record<string, unknown> = {};
    first.cells.forEach((field, index) => {
      const value = cells[index]!.trim();
      if (field === "user_id") input[field] = /^[1-9]\d*$/.test(value) ? Number(value) : value;
      else if (field === "entra_account_enabled") input[field] = value === "true" ? true : value === "false" ? false : value;
      else input[field] = value === "" ? null : value;
    });
    const result = DirectoryUserSchema.safeParse(input);
    if (!result.success) throw new DirectoryInputError("invalid_row", lineNumber);
    const row = result.data;
    const entraId = row.entra_object_id.toLowerCase();
    if (ids.has(row.user_id) || entraIds.has(entraId)) throw new DirectoryInputError("duplicate_identity", lineNumber);
    ids.add(row.user_id);
    entraIds.add(entraId);
    return row;
  });
}
