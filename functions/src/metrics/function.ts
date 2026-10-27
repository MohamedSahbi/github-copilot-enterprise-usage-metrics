import { app } from "@azure/functions";
import { createMetricsRuntimeHandler } from "./runtime.js";

const handler = createMetricsRuntimeHandler(process.env);

app.timer("metricsSync", {
  schedule: "%METRICS_SYNC_SCHEDULE%",
  runOnStartup: false,
  handler: (timer, context) => handler(timer, {
    invocationId: context.invocationId,
    info: (message) => context.info(message),
    error: (message) => context.error(message),
  }),
});
