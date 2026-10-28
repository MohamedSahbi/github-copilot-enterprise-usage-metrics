import sql from "mssql";

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);

function isNetworkFailure(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8) return false;
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every((child: unknown) => isNetworkFailure(child, depth + 1));
  }
  return "code" in error && typeof error.code === "string" && NETWORK_CODES.has(error.code);
}

export function isSqlConnectivityOutage(error: unknown): boolean {
  // mssql wraps Tedious' ESOCKET in originalError; Tedious retains the native
  // connect/socket failure in cause. ESOCKET alone also covers TLS errors.
  return error instanceof sql.ConnectionError && error.code === "ESOCKET" &&
    isNetworkFailure(error.originalError?.cause);
}
