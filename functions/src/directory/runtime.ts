import { ClientSecretCredential, ManagedIdentityCredential, type TokenCredential } from "@azure/identity";
import sql from "mssql";
import { z } from "zod";
import { isGuid } from "../../../shared/src/access.js";
import { DirectoryProviderSchema } from "../../../shared/src/ingestion-settings.js";
import { validateSettings } from "../../../shared/src/settings.js";
import { createDirectoryHandler } from "./handler.js";
import { DirectoryProviderError, type DirectoryTransport } from "./providers.js";
import { createDirectorySqlWriter, DirectoryWriteError } from "./sql-writer.js";
import type { DirectorySyncInput, DirectoryWriter } from "./sync.js";

type Environment = Readonly<Record<string, string | undefined>>;
const graphManagerNotFound = z.object({
  error: z.object({ code: z.literal("Request_ResourceNotFound") }).passthrough(),
}).passthrough();

export interface DirectoryRuntimeConfig {
  provider: "entra" | "csv";
  enterprise: string;
  organizations: string[];
  attributes: { departmentAttribute: string; businessAreaAttribute: string };
  sqlServer: string;
  sqlDatabase: string;
  managedIdentityClientId: string;
  directoryPat: string | null;
  entraTenantId: string | null;
  /** Optional app registration for Microsoft Graph; null keeps Graph on the managed identity. */
  graphClient: { clientId: string; clientSecret: string } | null;
}

export function readDirectoryRuntimeConfig(env: Environment): DirectoryRuntimeConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error("directory_configuration_invalid");
    return value;
  };
  const provider = DirectoryProviderSchema.safeParse(required("DIRECTORY_PROVIDER"));
  const settings = validateSettings({ directory: {
    departmentAttribute: env.DIRECTORY_DEPARTMENT_ATTRIBUTE,
    businessAreaAttribute: env.DIRECTORY_BUSINESS_AREA_ATTRIBUTE,
  } });
  const enterprise = required("ENTERPRISE_SLUG");
  const organizations = required("ORGANIZATIONS").split(",").map((value) => value.trim());
  const sqlServer = required("SQL_SERVER");
  const sqlDatabase = required("SQL_DATABASE");
  const managedIdentityClientId = required("AZURE_CLIENT_ID");
  if (!provider.success || !settings.ok || !isGuid(managedIdentityClientId) ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(sqlServer) || sqlDatabase.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(enterprise) ||
      organizations.some((org) => !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(org)) ||
      new Set(organizations.map((org) => org.toLowerCase())).size !== organizations.length) {
    throw new Error("directory_configuration_invalid");
  }
  const directoryPat = provider.data === "entra" ? required("GITHUB_DIRECTORY_PAT") : null;
  if (directoryPat?.startsWith("@Microsoft.KeyVault(")) throw new Error("directory_configuration_invalid");
  const entraTenantId = env.ENTRA_TENANT_ID?.trim() || null;
  if (entraTenantId !== null && !isGuid(entraTenantId)) throw new Error("directory_configuration_invalid");
  const graphClientId = env.GRAPH_CLIENT_ID?.trim() || null;
  let graphClient: DirectoryRuntimeConfig["graphClient"] = null;
  if (graphClientId !== null) {
    const clientSecret = required("GRAPH_CLIENT_SECRET");
    if (!isGuid(graphClientId) || entraTenantId === null || clientSecret.startsWith("@Microsoft.KeyVault(")) {
      throw new Error("directory_configuration_invalid");
    }
    graphClient = { clientId: graphClientId, clientSecret };
  }
  return {
    provider: provider.data, enterprise, organizations, sqlServer, sqlDatabase, managedIdentityClientId, directoryPat,
    entraTenantId, graphClient,
    attributes: { departmentAttribute: settings.settings.directory.departmentAttribute,
      businessAreaAttribute: settings.settings.directory.businessAreaAttribute },
  };
}

export function createDirectoryTransport(
  provider: "github" | "graph", token: () => Promise<string>, fetcher: typeof fetch, correlationId?: string,
): DirectoryTransport {
  const origin = provider === "github" ? "https://api.github.com" : "https://graph.microsoft.com";
  return async (path) => {
    try {
      if (!path.startsWith("/") || path.startsWith("//")) throw new DirectoryProviderError("source_read_failed");
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new DirectoryProviderError("source_read_failed");
      const authorization = await token();
      if (!authorization || authorization.startsWith("@Microsoft.KeyVault(")) throw new DirectoryProviderError("source_read_failed");
      const response = await fetcher(url, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${authorization}`,
          Accept: provider === "github" && path.startsWith("/scim/") ? "application/scim+json" : "application/json",
          ...(provider === "github" ? { "X-GitHub-Api-Version": "2026-03-10" } : {}),
          ...(correlationId ? { "X-Correlation-ID": correlationId } : {}),
        },
      });
      const managerRequest = /^\/v1\.0\/users\/([^/]+)\/manager$/.exec(url.pathname);
      if (provider === "graph" && response.status === 404 && managerRequest && isGuid(managerRequest[1] ?? "")) {
        try {
          if (graphManagerNotFound.safeParse(await response.json()).success) {
            return { status: 404, body: null, authoritativeNoManager: true };
          }
        } catch {
          // An unreadable error response is not evidence that the user has no manager.
        }
        return { status: 404, body: null };
      }
      return { status: response.status, body: response.status === 200 ? await response.json() : null };
    } catch {
      throw new DirectoryProviderError("source_read_failed");
    }
  };
}

export function graphTokenCredential(config: DirectoryRuntimeConfig): TokenCredential {
  if (config.graphClient && config.entraTenantId) {
    return new ClientSecretCredential(config.entraTenantId, config.graphClient.clientId, config.graphClient.clientSecret);
  }
  return new ManagedIdentityCredential({ clientId: config.managedIdentityClientId });
}

function tokenProvider(credential: TokenCredential): () => Promise<string> {
  return async () => {
    const token = await credential.getToken("https://graph.microsoft.com/.default");
    if (!token) throw new DirectoryProviderError("source_read_failed");
    return token.token;
  };
}

function runtimeWriter(config: DirectoryRuntimeConfig): DirectoryWriter {
  return {
    async commit(command) {
      const pool = new sql.ConnectionPool({
        server: config.sqlServer, database: config.sqlDatabase,
        authentication: { type: "token-credential", options: {
          credential: new ManagedIdentityCredential({ clientId: config.managedIdentityClientId }),
        } },
        options: { encrypt: true, trustServerCertificate: false }, pool: { min: 0, max: 1 },
      });
      let failure: DirectoryWriteError | null = null;
      try {
        await pool.connect();
        await createDirectorySqlWriter(() => new sql.Transaction(pool), { entraTenantId: config.entraTenantId })
          .commit(command);
      } catch {
        failure = new DirectoryWriteError("directory_write_failed");
      }
      try {
        await pool.close();
      } catch {
        failure ??= new DirectoryWriteError("directory_write_failed");
      }
      if (failure) throw failure;
    },
  };
}

export interface DirectoryRuntimeOverrides {
  fetch?: typeof fetch;
  graphToken?: () => Promise<string>;
  writer?: DirectoryWriter;
  now?: () => Date;
  readCsv?: () => Promise<Uint8Array>;
}

export function createDirectoryRuntimeHandler(env: Environment, overrides: DirectoryRuntimeOverrides = {}) {
  const config = readDirectoryRuntimeConfig(env);
  if (config.provider === "csv" && !overrides.readCsv) throw new Error("directory_csv_source_required");
  const graphToken = overrides.graphToken ?? tokenProvider(graphTokenCredential(config));
  return createDirectoryHandler(async (): Promise<DirectorySyncInput> => {
    const common = { enterprise: config.enterprise, organizations: config.organizations, attributes: config.attributes };
    if (config.provider === "csv") {
      if (!overrides.readCsv) throw new Error("directory_csv_source_required");
      return { ...common, provider: "csv", content: await overrides.readCsv() };
    }
    return { ...common, provider: "entra" };
  }, async (context) => ({
    github: createDirectoryTransport("github", async () => {
      if (!config.directoryPat) throw new DirectoryProviderError("source_read_failed");
      return config.directoryPat;
    }, overrides.fetch ?? fetch, context.invocationId),
    graph: createDirectoryTransport("graph", graphToken, overrides.fetch ?? fetch, context.invocationId),
    writer: overrides.writer ?? runtimeWriter(config), now: overrides.now ?? (() => new Date()),
  }));
}
