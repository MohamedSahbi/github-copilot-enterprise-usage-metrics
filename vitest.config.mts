import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{portal/src,functions/src,shared/src,scripts}/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
