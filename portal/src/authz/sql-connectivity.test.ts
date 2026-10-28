import sql from "mssql";
import { describe, expect, it } from "vitest";
import { isSqlConnectivityOutage } from "./sql-connectivity";

const network = (code: string) => Object.assign(new Error("synthetic transport"), { code });
const connection = (cause: unknown, code = "ESOCKET") =>
  new sql.ConnectionError(Object.assign(new Error("synthetic driver", { cause }), { code }), code);

describe("conservative SQL transport classification", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"])(
    "accepts typed ESOCKET with native %s evidence", (code) => {
      expect(isSqlConnectivityOutage(connection(network(code)))).toBe(true);
    },
  );
  it("accepts the driver's aggregate of refused IPv4/IPv6 endpoints", () => {
    expect(isSqlConnectivityOutage(connection(new AggregateError([
      network("ECONNREFUSED"), network("ENETUNREACH"),
    ])))).toBe(true);
  });
  it.each([
    undefined, null, new Error("ESOCKET ECONNREFUSED"),
    { code: "ESOCKET", originalError: { cause: network("ECONNREFUSED") } },
    new sql.ConnectionError("ECONNREFUSED", "ESOCKET"),
    connection(network("ECONNREFUSED"), "ELOGIN"),
    connection(network("ECONNREFUSED"), "ETIMEOUT"),
    connection(network("ERR_TLS_CERT_ALTNAME_INVALID")),
    connection(network("ELOGIN")),
    connection({ code: "ECONNREFUSED" }),
    connection(new AggregateError([])),
    connection(new AggregateError([network("ECONNREFUSED"), network("ELOGIN")])),
    new sql.RequestError("ECONNREFUSED", "ESOCKET"),
  ])("rejects unknown, authentication, TLS and request errors %#", (error) => {
    expect(isSqlConnectivityOutage(error)).toBe(false);
  });
  it("fails closed on a cyclic aggregate rather than recursing indefinitely", () => {
    const cycle = new AggregateError([]);
    cycle.errors.push(cycle);
    expect(isSqlConnectivityOutage(connection(cycle))).toBe(false);
  });
});
