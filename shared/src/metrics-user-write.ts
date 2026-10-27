import type { Guid } from "./rows";

export const METRICS_USER_WRITE_PROCEDURE = "portal.usp_write_metrics_users";
export const METRICS_USER_WRITE_PARAMETER_NAME = "run_id";

export interface MetricsUserWriteCommand {
  procedure: typeof METRICS_USER_WRITE_PROCEDURE;
  parameterName: typeof METRICS_USER_WRITE_PARAMETER_NAME;
  parameters: { run_id: Guid };
}

export function createMetricsUserWriteCommand(runId: Guid): MetricsUserWriteCommand {
  return {
    procedure: METRICS_USER_WRITE_PROCEDURE,
    parameterName: METRICS_USER_WRITE_PARAMETER_NAME,
    parameters: { run_id: runId },
  };
}
