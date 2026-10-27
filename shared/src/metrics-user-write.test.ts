import { describe, expect, it } from "vitest";
import {
  createMetricsUserWriteCommand,
  METRICS_USER_WRITE_PARAMETER_NAME,
  METRICS_USER_WRITE_PROCEDURE,
} from "./metrics-user-write";

describe("metrics user write SQL contract", () => {
  it("binds only the run ID to the fixed metrics procedure", () => {
    const runId = "00000000-0000-4000-8000-000000000001";

    expect(METRICS_USER_WRITE_PROCEDURE).toBe("portal.usp_write_metrics_users");
    expect(METRICS_USER_WRITE_PARAMETER_NAME).toBe("run_id");
    expect(createMetricsUserWriteCommand(runId)).toEqual({
      procedure: "portal.usp_write_metrics_users",
      parameterName: "run_id",
      parameters: { run_id: runId },
    });
  });
});
