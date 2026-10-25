import { assertTestAuthAllowed } from "./test-auth";
import { readAccessSettings } from "./settings";

export function validateStartup(): void {
  try {
    assertTestAuthAllowed();
    readAccessSettings();
  } catch (error) {
    // Next.js catches instrumentation errors and otherwise keeps a listening process alive.
    process.stderr.write(`${JSON.stringify({
      level: "error", event: "startup.invalid_configuration",
      message: error instanceof Error ? error.message : "Invalid startup configuration",
    })}\n`);
    process.exit(1);
  }
}
