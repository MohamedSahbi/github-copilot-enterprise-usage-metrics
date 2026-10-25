import { z } from "zod";

export const METRICS_API_START = "2025-10-10";
export const METRICS_HISTORY_DAYS = 365;

// Same values as Terraform organization.directory_provider / DIRECTORY_PROVIDER; "entra" means Graph.
export const DirectoryProviderSchema = z.enum(["entra", "csv"]).default("entra");

export function backfillFromSchema(today: string) {
  const day = z.iso.date().parse(today);
  const rollingStart = new Date(Date.parse(`${day}T00:00:00Z`) - METRICS_HISTORY_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const earliest = rollingStart > METRICS_API_START ? rollingStart : METRICS_API_START;
  return z.iso.date().refine((value) => value >= earliest && value <= day, {
    message: "must be within the API-start/365-day window and not in the future",
  }).optional();
}
