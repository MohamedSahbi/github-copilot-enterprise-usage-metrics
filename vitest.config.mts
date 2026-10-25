import { defineConfig } from "vitest/config";

const roots = "{portal/src,functions/src,shared/src,scripts}";

// `unit` is the default run. `integration` needs the local stack (Docker): npm run stack:up && npm run test:integration.
export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [`${roots}/**/*.test.ts`],
          exclude: ["**/node_modules/**", "**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["scripts/integration/**/*.int.test.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
