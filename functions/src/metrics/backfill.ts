import { randomUUID } from "node:crypto";
import { z } from "zod";
import { backfillFromSchema } from "../../../shared/src/ingestion-settings.js";
import type { MetricsDayLoadInput, MetricsDayLoadResult, StructuredLogger } from "./day-loader.js";
import { MetricsAcquisitionError, type MetricsAcquisitionCode } from "./report-provider.js";

export interface AcquisitionFailure {
  runId: string;
  correlationId: string;
  organizationId?: number;
  organizationLogin: string;
  reportDay: string;
  errorCode: MetricsAcquisitionCode;
}

export interface MetricsBackfillDependencies {
  resolveOrganization(organization: string): Promise<number>;
  acquire(organization: string, day: string): Promise<{ organizationId: number; content: Uint8Array }>;
  load(input: MetricsDayLoadInput): Promise<MetricsDayLoadResult>;
  isComplete(organizationId: number, day: string): Promise<boolean>;
  recordFailure(failure: AcquisitionFailure): Promise<void>;
  logger: StructuredLogger;
}

export function metricsDays(backfillFrom: string | undefined, today: string): string[] {
  const date = z.iso.date().parse(today);
  const from = backfillFromSchema(date).parse(backfillFrom);
  const yesterday = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (from !== undefined && from > yesterday) throw new TypeError("Backfill must end by yesterday UTC");
  const start = from ?? yesterday;
  // Apply the canonical API-start/rolling-window validation even for the implicit date.
  backfillFromSchema(date).parse(start);
  const days: string[] = [];
  for (let cursor = Date.parse(`${start}T00:00:00Z`); cursor < Date.parse(`${date}T00:00:00Z`); cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

export async function runMetricsBackfill(
  input: {
    organizations: readonly string[];
    today?: string;
    backfillFrom?: string;
    dryRun?: boolean;
    resume?: boolean;
    correlationId?: string;
  },
  dependencies: MetricsBackfillDependencies,
): Promise<{ published: number; skipped: number; gaps: number; quarantined: number; dryRun: number }> {
  const days = metricsDays(input.backfillFrom, input.today ?? new Date().toISOString().slice(0, 10));
  const correlationId = z.uuid().parse(input.correlationId ?? randomUUID());
  const organizations = z.array(z.string().min(1).max(39).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/))
    .min(1).parse(input.organizations);
  if (new Set(organizations.map((org) => org.toLowerCase())).size !== organizations.length) {
    throw new TypeError("Duplicate organization identities");
  }
  const summary = { published: 0, skipped: 0, gaps: 0, quarantined: 0, dryRun: 0 };
  for (const organizationLogin of organizations) {
    for (const reportDay of days) {
      let organizationId: number | undefined;
      let acquired: Awaited<ReturnType<MetricsBackfillDependencies["acquire"]>>;
      try {
        organizationId = await dependencies.resolveOrganization(organizationLogin);
      } catch (error) {
        await gap(error);
        continue;
      }
      if (input.resume && await dependencies.isComplete(organizationId, reportDay)) {
        summary.skipped++;
        continue;
      }
      try {
        acquired = await dependencies.acquire(organizationLogin, reportDay);
        if (acquired.organizationId !== organizationId) throw new MetricsAcquisitionError("installation_identity", false);
        if (acquired.content.byteLength === 0) throw new MetricsAcquisitionError("incomplete_download", true);
      } catch (error) {
        await gap(error);
        continue;
      }
      if (input.dryRun) {
        summary.dryRun++;
        continue;
      }
      const result = await dependencies.load({
        reportDay, organizationId, organizationLogin, content: acquired.content, correlationId,
      });
      if (result.status === "published" && result.rowsRead > 0 &&
          result.rowsRead === result.rowsLoaded && result.rowsQuarantined === 0) {
        summary.published++;
      } else {
        summary.quarantined++;
      }

      async function gap(error: unknown): Promise<void> {
        const failure = error instanceof MetricsAcquisitionError ? error : new MetricsAcquisitionError("request_failed", true);
        const runId = randomUUID();
        dependencies.logger.error({
          event: "metrics_acquisition_failed", runId, correlationId, reportDay,
          source: "users_1_day", errorCode: failure.code, retryable: failure.retryable ? 1 : 0,
        });
        if (!input.dryRun) {
          await dependencies.recordFailure({
            runId, correlationId, organizationId, organizationLogin, reportDay, errorCode: failure.code,
          });
        }
        summary.gaps++;
      }
    }
  }
  dependencies.logger.info({ event: "metrics_backfill_completed", correlationId, source: "users_1_day", ...summary });
  return summary;
}
