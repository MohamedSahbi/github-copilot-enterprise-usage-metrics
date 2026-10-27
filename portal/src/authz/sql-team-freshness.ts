import sql from "mssql";
import { readAccessSettings } from "../auth/settings";

export function bindTeamFreshness(request: sql.Request): void {
  request.input("teamDirectoryStaleHours", sql.Int, readAccessSettings().directoryStaleHours);
}

export function eligibleManagerEdge(alias: "u" | "child"): string {
  return `${alias}.manager_resolved = 1
    AND ${alias}.manager_checked_at >= DATEADD(hour, -@teamDirectoryStaleHours, SYSUTCDATETIME())
    AND ${alias}.manager_checked_at <= DATEADD(millisecond, 500, SYSUTCDATETIME())`;
}
