import { app } from "@azure/functions";
import { createDirectoryRuntimeHandler } from "./runtime.js";

const handler = createDirectoryRuntimeHandler(process.env);

app.timer("directorySync", {
  schedule: "%DIRECTORY_SYNC_SCHEDULE%",
  runOnStartup: false,
  handler: (timer, context) => handler(timer, {
    invocationId: context.invocationId,
    info: (message) => context.info(message),
    warn: (message) => context.warn(message),
    error: (message) => context.error(message),
  }),
});
