import { describe, expect, it } from "vitest";
import { parseBootstrapArguments } from "./bootstrap";

describe("access bootstrap command arguments", () => {
  it("defaults to validation-only and requires a private input file", () => {
    expect(parseBootstrapArguments(["--input", "/private/access.json"])).toEqual({
      inputPath: "/private/access.json",
      apply: false,
    });
    expect(() => parseBootstrapArguments([])).toThrow();
  });

  it("requires an explicit apply switch and rejects ambiguous arguments", () => {
    expect(parseBootstrapArguments(["--input", "/private/access.json", "--apply"])).toEqual({
      inputPath: "/private/access.json",
      apply: true,
    });
    expect(() => parseBootstrapArguments(["--input", "--apply"])).toThrow();
    expect(() => parseBootstrapArguments(["--input", "/private/access.json", "--apply", "--apply"])).toThrow();
    expect(() => parseBootstrapArguments(["--input", "/private/access.json", "--unexpected"])).toThrow();
  });
});
