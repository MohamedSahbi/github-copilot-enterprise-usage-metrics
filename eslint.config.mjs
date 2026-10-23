import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import nextVitals from "eslint-config-next/core-web-vitals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "portal/upstream/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  ...nextVitals.map((config) => ({ ...config, files: ["portal/**/*.{ts,tsx}"] })),
  {
    files: ["portal/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "portal" } },
  },
);
