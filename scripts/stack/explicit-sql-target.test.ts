import { describe, expect, it } from "vitest";
import { assertExplicitLocalConnection, localConnectionString } from "./config";

describe("explicit synthetic SQL target agreement", () => {
  const allocated = {
    LOCAL_SQL_PORT: "14504",
    LOCAL_SQL_SA_PASSWORD: "Synthetic-Target-Only-1!",
  };
  const connection = localConnectionString(allocated);

  it("accepts an exact explicitly supplied target without changing the general stack default", () => {
    expect(() => assertExplicitLocalConnection({ ...allocated, SQL_CONNECTION_STRING: connection })).not.toThrow();
    expect(localConnectionString({})).toContain("Server=127.0.0.1,14330;Database=portal_local;");
  });

  it.each([
    { ...allocated },
    { ...allocated, SQL_CONNECTION_STRING: "" },
    { SQL_CONNECTION_STRING: connection, LOCAL_SQL_SA_PASSWORD: allocated.LOCAL_SQL_SA_PASSWORD },
    { ...allocated, LOCAL_SQL_PORT: "" },
  ])("rejects missing explicit connection or port without a fallback", (env) => {
    expect(() => assertExplicitLocalConnection(env)).toThrow(/explicit/i);
  });

  it.each([
    connection.replace(",14504;", ",14330;"),
    connection.replace("Database=portal_local;", "Database=other;"),
    `${connection};Server=127.0.0.1,14330`,
  ])("rejects a supplied target that disagrees with the allocated stack without exposing credentials", (SQL_CONNECTION_STRING) => {
    let error: unknown;
    try {
      assertExplicitLocalConnection({ ...allocated, SQL_CONNECTION_STRING });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(allocated.LOCAL_SQL_SA_PASSWORD);
  });
});
