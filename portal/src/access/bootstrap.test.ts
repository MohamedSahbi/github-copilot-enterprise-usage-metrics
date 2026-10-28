import { describe, expect, it } from "vitest";
import {
  assertBootstrapEnvironment,
  BootstrapError,
  parseAccessBootstrapInput,
} from "./bootstrap";

const validInput = {
  expectedSqlServer: "portal.example.database.windows.net",
  expectedSqlDatabase: "portal",
  tenantId: "00000000-0000-4000-8000-000000000001",
  operatorObjectId: "00000000-0000-4000-8000-000000000002",
  targetObjectId: "00000000-0000-4000-8000-000000000003",
  grant: { role: "admin", scope: "company", scopeValue: "" },
  approvalReference: "CHANGE-1234",
};

describe("access bootstrap input", () => {
  it("accepts explicit immutable identities and one existing grant shape", () => {
    expect(parseAccessBootstrapInput(validInput)).toEqual(validInput);
  });

  it("rejects malformed, unknown, and extra fields without echoing input", () => {
    expect(() => parseAccessBootstrapInput({ ...validInput, targetObjectId: "user@example.invalid" }))
      .toThrowError(new BootstrapError("invalid_input"));
    expect(() => parseAccessBootstrapInput({ ...validInput, grant: { role: "owner", scope: "company" } }))
      .toThrowError(new BootstrapError("invalid_input"));
    expect(() => parseAccessBootstrapInput({ ...validInput, email: "user@example.invalid" }))
      .toThrowError(new BootstrapError("invalid_input"));
  });

  it("requires the manifest server, database, and tenant to match the configured deployment", () => {
    const input = parseAccessBootstrapInput(validInput);
    expect(() => assertBootstrapEnvironment(input, {
      SQL_SERVER: "PORTAL.EXAMPLE.DATABASE.WINDOWS.NET.",
      SQL_DATABASE: "portal",
      ENTRA_TENANT_ID: input.tenantId,
    })).not.toThrow();
    expect(() => assertBootstrapEnvironment(input, {
      SQL_SERVER: "other.example.database.windows.net",
      SQL_DATABASE: "portal",
      ENTRA_TENANT_ID: input.tenantId,
    })).toThrowError(new BootstrapError("configuration_mismatch"));
    expect(() => assertBootstrapEnvironment(input, {
      SQL_SERVER: input.expectedSqlServer,
      SQL_DATABASE: "legacy",
      ENTRA_TENANT_ID: input.tenantId,
    })).toThrowError(new BootstrapError("configuration_mismatch"));
    expect(() => assertBootstrapEnvironment(input, {
      SQL_SERVER: input.expectedSqlServer,
      SQL_DATABASE: "portal",
      ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000099",
    })).toThrowError(new BootstrapError("configuration_mismatch"));
  });
});
