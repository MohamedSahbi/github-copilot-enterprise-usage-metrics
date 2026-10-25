import { describe, expect, it } from "vitest";
import { validateSettings } from "./settings";
import { DirectoryUserSchema, parseDirectoryCsv, DirectoryInputError } from "./directory-input";

const oid = "00000000-0000-0000-0000-000000000001";
const header = "user_id,entra_object_id,state,entra_account_enabled";
const csv = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("ingestion settings bounds", () => {
  it("uses the existing Terraform provider spelling and defaults to Graph", () => {
    expect(validateSettings({})).toMatchObject({ ok: true, settings: { organization: { directory_provider: "entra" } } });
    expect(validateSettings({ organization: { directory_provider: "csv" } }).ok).toBe(true);
    for (const value of ["graph", "", null, 1]) {
      expect(validateSettings({ organization: { directory_provider: value } }).ok).toBe(false);
    }
    expect(validateSettings({ organization: null }).ok).toBe(false);
  });

  it("accepts inclusive rolling bounds and rejects future, malformed and older dates", () => {
    const today = "2026-10-25";
    for (const backfillFrom of ["2025-10-25", "2026-10-25"]) {
      expect(validateSettings({ backfillFrom }, today).ok).toBe(true);
    }
    for (const backfillFrom of ["2025-10-24", "2026-10-26", "2026-02-30", "2026-1-01", "", null, 42]) {
      expect(validateSettings({ backfillFrom }, today)).toMatchObject({ ok: false });
    }
    expect(validateSettings({}, today)).toMatchObject({ ok: true });
  });

  it("enforces API inception and UTC date arithmetic across leap years", () => {
    expect(validateSettings({ backfillFrom: "2025-10-09" }, "2025-11-01").ok).toBe(false);
    expect(validateSettings({ backfillFrom: "2025-10-10" }, "2025-11-01").ok).toBe(true);
    expect(validateSettings({ backfillFrom: "2027-03-01" }, "2028-02-29").ok).toBe(true);
    expect(validateSettings({ backfillFrom: "2027-02-28" }, "2028-02-29").ok).toBe(false);
    expect(() => validateSettings({}, "bad-date")).toThrow();
  });
});

describe("canonical directory schema and CSV boundary", () => {
  it("validates a synthetic normalized adapter fixture without provider-specific fields", () => {
    const row = DirectoryUserSchema.parse({
      user_id: 42, entra_object_id: oid, state: "active", login: "fixture-user",
      entra_account_enabled: false,
      email: "fixture@example.invalid", display_name: "Fixture User",
      department: " Engineering ", business_area: " Example   Area ",
      manager_entra_object_id: null, manager_email: null,
    });
    expect(row.department).toBe("engineering");
    expect(row.business_area).toBe("example area");
    expect(row.entra_account_enabled).toBe(false);
    expect(DirectoryUserSchema.safeParse({ ...row, entra_account_enabled: "false" }).success).toBe(false);
    expect(DirectoryUserSchema.safeParse({ ...row, user_id: "42" }).success).toBe(false);
    expect(DirectoryUserSchema.safeParse({ ...row, state: "disabled" }).success).toBe(false);
    expect(DirectoryUserSchema.safeParse({ ...row, department: "x".repeat(101) }).success).toBe(false);
    expect(DirectoryUserSchema.parse({ ...row, department: "", business_area: "  " }))
      .toMatchObject({ department: null, business_area: null });
  });

  it("accepts UTF-8 with/without BOM, reordered headers, CRLF, quoted commas and multiline cells", () => {
    for (const bom of ["", "\uFEFF"]) {
      const rows = parseDirectoryCsv(csv(`${bom}state,entra_object_id,user_id,entra_account_enabled,display_name,department\r\nactive,${oid},42,false,"Fixture, ""User""\nTwo", Engineering`));
      expect(rows).toEqual([{
        user_id: 42, entra_object_id: oid, state: "active", login: null, email: null,
        entra_account_enabled: false,
        display_name: 'Fixture, "User"\nTwo', manager_entra_object_id: null, manager_email: null,
        department: "engineering", business_area: null,
      }]);
    }
  });

  it("accepts optional empty values and the existing active/deleted/suspended states", () => {
    for (const state of ["active", "deleted", "suspended"]) {
      const rows = parseDirectoryCsv(csv(`${header},login\n42,${oid},${state},true,\n`));
      expect(rows[0]).toMatchObject({ state, login: null });
    }
  });

  it.each([
    ["", "invalid_header"],
    ["user_id,state\n42,active", "invalid_header"],
    [`${header},state\n42,${oid},active,true,active`, "invalid_header"],
    [`${header},\n42,${oid},active,true,`, "invalid_header"],
    [`${header},unknown\n42,${oid},active,true,x`, "invalid_header"],
    [`${header.toUpperCase()}\n42,${oid},active,true`, "invalid_header"],
    [`${header}\n42,${oid}`, "invalid_row"],
    [`${header}\n0,${oid},active,true`, "invalid_row"],
    [`${header}\n9007199254740992,${oid},active,true`, "invalid_row"],
    [`${header}\n42,not-guid,active,true`, "invalid_row"],
    [`${header}\n42,${oid},disabled,true`, "invalid_row"],
    [`${header}\n42,${oid},active,yes`, "invalid_row"],
    [`${header}\n42,${oid},active,`, "invalid_row"],
    [`${header}\n42,${oid},active,true\n42,${oid},active,true`, "duplicate_identity"],
    [`${header}\n42,${oid},active,true\n43,${oid},active,true`, "duplicate_identity"],
    [`${header}\n"42,${oid},active`, "invalid_csv"],
    [`${header}\n"42"x,${oid},active`, "invalid_csv"],
    [`${header}\n4"2,${oid},active`, "invalid_csv"],
  ])("rejects invalid input atomically with a typed %s error", (text, code) => {
    try {
      parseDirectoryCsv(csv(text));
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DirectoryInputError);
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain(oid);
    }
  });

  it("rejects invalid UTF-8, UTF-16 and NUL-containing input", () => {
    for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xff, 0xfe, 0x41, 0]), csv(`${header}\n42,${oid},active\0`)]) {
      expect(() => parseDirectoryCsv(bytes)).toThrow(DirectoryInputError);
      try { parseDirectoryCsv(bytes); } catch (error) { expect(error).toMatchObject({ code: "invalid_encoding" }); }
    }
  });
});
