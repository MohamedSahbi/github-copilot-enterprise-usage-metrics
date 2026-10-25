import { describe, expect, it } from "vitest";
import { MigrationError, parseMigrationName, planMigrations } from "./plan";
import { splitBatches } from "./split-go";

describe("splitBatches", () => {
  it("splits on GO lines, case-insensitive, ignoring surrounding whitespace", () => {
    expect(splitBatches("SELECT 1;\nGO\nSELECT 2;\n  go  \nSELECT 3;")).toEqual(["SELECT 1;", "SELECT 2;", "SELECT 3;"]);
  });

  it("repeats a batch for GO <n>", () => {
    expect(splitBatches("SELECT 1;\nGO 3\n")).toEqual(["SELECT 1;", "SELECT 1;", "SELECT 1;"]);
  });

  it("allows a trailing line comment on the GO line", () => {
    expect(splitBatches("SELECT 1;\nGO -- end\nSELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("does not split on GO inside a string, block comment, bracketed identifier or a larger word", () => {
    const sql = [
      "SELECT 'a",
      "GO",
      "b';",
      "/* comment",
      "GO",
      "*/",
      "SELECT [x",
      "GO",
      "y];",
      "GOTO label;",
      "-- GO",
    ].join("\n");
    expect(splitBatches(sql)).toEqual([sql]);
  });

  it("handles escaped quotes and CRLF line endings", () => {
    expect(splitBatches("SELECT 'it''s';\r\nGO\r\nSELECT 2;\r\n")).toEqual(["SELECT 'it''s';", "SELECT 2;"]);
  });

  it("drops empty batches", () => {
    expect(splitBatches("\nGO\n\nGO\nSELECT 1;\nGO\n")).toEqual(["SELECT 1;"]);
  });
});

describe("parseMigrationName", () => {
  it("accepts yyyyMMddHHmmss.do.description.sql", () => {
    expect(parseMigrationName("20261026000100.do.portal-schema-and-history.sql")).toEqual({
      version: 20261026000100,
      name: "portal-schema-and-history",
    });
  });

  it.each([
    "20261026000100.undo.something.sql",
    "20261026000100.sql",
    "2026102600010.do.short-timestamp.sql",
    "20261026000100.do.Upper.sql",
    "20261026000100.do.has.dots.sql",
    "20261026000100.do.quote'.sql",
    "20261026000100.do.something.txt",
  ])("rejects %s", (file) => {
    expect(() => parseMigrationName(file)).toThrowError(MigrationError);
  });
});

describe("planMigrations", () => {
  const file = (version: number, md5: string) => ({ version, name: `m${version}`, md5, filename: `${version}.do.m${version}.sql` });
  const row = (version: number, md5: string | null) => ({ version, name: `m${version}`, md5 });

  it("returns every migration, ascending, when nothing is applied", () => {
    const plan = planMigrations([file(3, "c"), file(1, "a"), file(2, "b")], []);
    expect(plan.pending.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it("is a no-op when everything is applied with matching checksums", () => {
    expect(planMigrations([file(1, "a"), file(2, "b")], [row(1, "a"), row(2, "b")]).pending).toEqual([]);
  });

  it("refuses when an applied migration's checksum changed", () => {
    expect(() => planMigrations([file(1, "a"), file(2, "CHANGED")], [row(1, "a"), row(2, "b")])).toThrowError(
      expect.objectContaining({ code: "CHECKSUM_MISMATCH" }),
    );
  });

  it("refuses when an applied migration has no recorded checksum", () => {
    expect(() => planMigrations([file(1, "a")], [row(1, null)])).toThrowError(
      expect.objectContaining({ code: "CHECKSUM_MISSING" }),
    );
  });

  it("refuses when an applied migration's file is gone", () => {
    expect(() => planMigrations([file(2, "b")], [row(1, "a"), row(2, "b")])).toThrowError(
      expect.objectContaining({ code: "FILE_MISSING" }),
    );
  });

  it("rejects a pending migration older than the newest applied one and names it", () => {
    const run = () => planMigrations([file(1, "a"), file(2, "b"), file(3, "c")], [row(1, "a"), row(3, "c")]);
    expect(run).toThrowError(expect.objectContaining({ code: "OUT_OF_ORDER", message: expect.stringContaining("2") }));
  });

  it("still plans newer pending migrations", () => {
    const plan = planMigrations([file(1, "a"), file(2, "b"), file(3, "c")], [row(1, "a"), row(2, "b")]);
    expect(plan.pending.map((m) => m.version)).toEqual([3]);
  });

  it("checks checksums before planning anything, so a mismatch applies nothing", () => {
    expect(() => planMigrations([file(1, "CHANGED"), file(2, "b")], [row(1, "a")])).toThrowError(MigrationError);
  });
});
