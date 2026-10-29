import { describe, expect, it } from "vitest";
import { parseRemoveRunsArguments } from "./remove-runs";

const RUN = "00000000-0000-4000-8000-0000000000c2";
const OTHER = "00000000-0000-4000-8000-0000000000c3";

describe("remove-runs command arguments", () => {
  it("defaults to a dry run and needs at least one run id", () => {
    expect(parseRemoveRunsArguments(["--run-id", RUN, "--run-id", OTHER, "--user-id", "7", "--organization-id", "9"])).toEqual({
      runIds: [RUN, OTHER],
      synthetic: false,
      userIds: [7],
      organizationIds: [9],
      execute: false,
    });
    expect(() => parseRemoveRunsArguments([])).toThrow();
    expect(() => parseRemoveRunsArguments(["--user-id", "7"])).toThrow();
  });

  it("commits only with --execute plus the expected fact-row count from the dry run", () => {
    expect(parseRemoveRunsArguments(["--run-id", RUN, "--execute", "--expect-fact-rows", "63"])).toMatchObject({
      execute: true,
      expectFactRows: 63,
    });
    expect(() => parseRemoveRunsArguments(["--run-id", RUN, "--execute"])).toThrow();
    expect(() => parseRemoveRunsArguments(["--run-id", RUN, "--expect-fact-rows", "63"])).toThrow();
  });

  it("rejects malformed, duplicate and unknown arguments", () => {
    expect(() => parseRemoveRunsArguments(["--run-id", "not-a-uuid"])).toThrow();
    expect(() => parseRemoveRunsArguments(["--run-id", RUN, "--run-id", RUN.toUpperCase()])).toThrow();
    expect(() => parseRemoveRunsArguments(["--run-id", RUN, "--user-id", "0"])).toThrow();
    expect(() => parseRemoveRunsArguments(["--run-id", "--execute"])).toThrow();
    expect(() => parseRemoveRunsArguments(["--run-id", RUN, "--unexpected", "x"])).toThrow();
  });

  it("--synthetic replaces run ids and keeps the execute gate", () => {
    expect(parseRemoveRunsArguments(["--synthetic"])).toMatchObject({ runIds: [], synthetic: true, execute: false });
    expect(parseRemoveRunsArguments(["--synthetic", "--execute", "--expect-fact-rows", "0"])).toMatchObject({ synthetic: true, execute: true, expectFactRows: 0 });
    expect(() => parseRemoveRunsArguments(["--synthetic", "--run-id", RUN])).toThrow();
    expect(() => parseRemoveRunsArguments(["--synthetic", "--synthetic"])).toThrow();
    expect(() => parseRemoveRunsArguments(["--synthetic", "--execute"])).toThrow();
  });
});
