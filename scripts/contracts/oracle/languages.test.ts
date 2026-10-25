import { describe, expect, it } from "vitest";
import { normalizeLanguage as upstream } from "../../../portal/upstream/src/domain/languageNormalizer";
import { LANGUAGE_ALIASES, normalizeLanguage } from "../../../shared/src/languages";

describe("language normalization parity with upstream", () => {
  it("agrees on every alias, case and whitespace variant, and unknown names", () => {
    for (const a of [...LANGUAGE_ALIASES, "Rust", "  Go ", "SHELLSCRIPT", "C#", "unknown-lang"]) {
      expect(normalizeLanguage(a)).toBe(upstream(a));
      expect(normalizeLanguage(a.toUpperCase())).toBe(upstream(a.toUpperCase()));
    }
  });
});
