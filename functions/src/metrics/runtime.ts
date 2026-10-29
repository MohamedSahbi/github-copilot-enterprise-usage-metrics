import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { validateMetricsRuntimeSettings, type MetricsRuntimeSettings } from "../../../shared/src/metrics-runtime-settings.js";
import { metricsDays, runMetricsBackfill, type MetricsBackfillDependencies } from "./backfill.js";
import {
  createMetricsBlobContainerClient, createMetricsSqlConfig, loadMetricsDay, type StructuredLogger,
} from "./day-loader.js";
import { GitHubMetricsProvider } from "./report-provider.js";
import { createMetricsRunStore } from "./run-store.js";

type Environment = Readonly<Record<string, string | undefined>>;
interface MetricsRuntimeConfig {
  settings: MetricsRuntimeSettings;
  privateKey: string;
}

export function readMetricsRuntimeConfig(env: Environment, today: string): MetricsRuntimeConfig {
  const result = validateMetricsRuntimeSettings({
    githubAppId: env.GITHUB_APP_ID,
    organizations: env.ORGANIZATIONS?.split(",").map((value) => value.trim()),
    sqlServer: env.SQL_SERVER,
    sqlDatabase: env.SQL_DATABASE,
    managedIdentityClientId: env.AZURE_CLIENT_ID,
    rawArchiveAccount: env.RAW_ARCHIVE_ACCOUNT,
    rawArchiveContainer: env.RAW_ARCHIVE_CONTAINER,
    ...(env.BACKFILL_FROM === undefined ? {} : { backfillFrom: env.BACKFILL_FROM }),
  }, today);
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  // The Functions host validates NCRONTAB semantics when resolving the timer setting.
  const schedule = env.METRICS_SYNC_SCHEDULE?.trim();
  if (!result.ok || !privateKey || !schedule || schedule.split(/\s+/).length !== 6) {
    throw new Error("metrics_configuration_invalid");
  }
  try {
    if (privateKey.startsWith("@Microsoft.KeyVault(") || createPrivateKey(privateKey).asymmetricKeyType !== "rsa") {
      throw new Error("Invalid App key");
    }
    metricsDays(result.settings.backfillFrom, today);
  } catch {
    throw new Error("metrics_configuration_invalid");
  }
  return { settings: result.settings, privateKey };
}

function productionDependencies(
  config: MetricsRuntimeConfig, logger: StructuredLogger, correlationId: string,
): MetricsBackfillDependencies {
  const { settings } = config;
  const provider = new GitHubMetricsProvider({
    appId: settings.githubAppId, privateKey: config.privateKey, correlationId,
  });
  const sqlConfig = createMetricsSqlConfig(settings.sqlServer, settings.sqlDatabase, settings.managedIdentityClientId);
  const store = createMetricsRunStore(sqlConfig);
  const blobContainer = createMetricsBlobContainerClient(
    `https://${settings.rawArchiveAccount}.blob.core.windows.net`,
    settings.rawArchiveContainer, settings.managedIdentityClientId,
  );
  return {
    resolveOrganization: (organization) => provider.resolveOrganization(organization),
    acquire: (organization, day) => provider.acquire(organization, day),
    load: (input) => loadMetricsDay(input, { sqlConfig, blobContainer, logger }),
    isComplete: store.isComplete,
    recordFailure: store.recordFailure,
    logger,
  };
}

export interface MetricsRuntimeOverrides {
  now?: () => Date;
  dryRun?: boolean;
  createDependencies?: (
    config: MetricsRuntimeConfig, logger: StructuredLogger, correlationId: string,
  ) => MetricsBackfillDependencies;
}

export function createMetricsRuntimeHandler(env: Environment, overrides: MetricsRuntimeOverrides = {}) {
  const now = overrides.now ?? (() => new Date());
  readMetricsRuntimeConfig(env, now().toISOString().slice(0, 10));
  return async (_timer: unknown, context: {
    invocationId: string;
    info(message: string): void;
    error(message: string): void;
  }): Promise<void> => {
    const logger: StructuredLogger = {
      info: (event) => context.info(JSON.stringify(event)),
      error: (event) => context.error(JSON.stringify(event)),
    };
    const correlation = z.uuid().safeParse(context.invocationId);
    if (!correlation.success) {
      logger.error({ event: "metrics_runtime_failed", source: "users_1_day", errorCode: "invalid_correlation" });
      throw new Error("metrics_runtime_failed");
    }
    const correlationId = correlation.data;
    const today = now().toISOString().slice(0, 10);
    let config: MetricsRuntimeConfig;
    try {
      config = readMetricsRuntimeConfig(env, today);
    } catch {
      logger.error({ event: "metrics_runtime_failed", correlationId, source: "users_1_day", errorCode: "configuration_invalid" });
      throw new Error("metrics_configuration_invalid");
    }
    logger.info({ event: "metrics_runtime_started", correlationId, source: "users_1_day" });
    let result: Awaited<ReturnType<typeof runMetricsBackfill>>;
    try {
      const dependencies = (overrides.createDependencies ?? productionDependencies)(config, logger, correlationId);
      result = await runMetricsBackfill({
        organizations: config.settings.organizations, today,
        backfillFrom: config.settings.backfillFrom, correlationId, resume: true, dryRun: overrides.dryRun,
      }, { ...dependencies, logger });
    } catch {
      logger.error({ event: "metrics_runtime_failed", correlationId, source: "users_1_day", errorCode: "runtime_failed" });
      throw new Error("metrics_runtime_failed");
    }
    if (result.failed > 0) {
      logger.error({ event: "metrics_runtime_failed", correlationId, source: "users_1_day", errorCode: "load_failed", ...result });
      throw new Error("metrics_runtime_failed");
    }
    if (result.gaps > 0 || result.quarantined > 0) {
      logger.error({ event: "metrics_runtime_failed", correlationId, source: "users_1_day", errorCode: "incomplete", ...result });
      throw new Error("metrics_runtime_incomplete");
    }
    logger.info({ event: "metrics_runtime_completed", correlationId, source: "users_1_day", ...result });
  };
}
