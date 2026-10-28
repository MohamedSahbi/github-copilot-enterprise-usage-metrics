import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import sql from "mssql";
import { describe, expect, it } from "vitest";
import { connectionString } from "./db";
import { AUTH_OBJECTS, AUTH_TENANT, seedAuth } from "./auth-seed";
import { assertLocalHost } from "../stack/config";
import { SqlAccessRepository } from "../../portal/src/authz/sql-access";
import { canAccess, resolveAccess, type AccessRepository, type Identity } from "../../portal/src/authz/access";
import { readAccessSettings } from "../../portal/src/auth/settings";

describe("real refused SQL transport and recovery", () => {
  it("allows emergency surfaces only until the next successful SQL read, without caching a grant", async () => {
    assertLocalHost(connectionString);
    const config = sql.ConnectionPool.parseConnectionString(connectionString);
    const target = new sql.ConnectionPool(connectionString);
    const sockets = new Set<Socket>();
    const proxy = createServer((client) => {
      const upstream = createConnection({ host: config.server, port: config.port ?? 1433 });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      }
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected an isolated loopback TCP port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));

    const group = "00000000-0000-4000-8000-000000000170";
    const settings = { ...readAccessSettings({}), breakGlassGroupId: group };
    const identity: Identity = {
      provider: "entra", tenantId: AUTH_TENANT,
      objectId: "00000000-0000-4000-8000-000000009170",
      groups: [group],
    };
    let connected: sql.ConnectionPool | undefined;
    const repository: AccessRepository = {
      async read(caller) {
        if (!connected) {
          const candidate = new sql.ConnectionPool({
            ...config, server: "127.0.0.1", port,
            connectionTimeout: 2000, pool: { min: 0, max: 1 },
          });
          try { connected = await candidate.connect(); }
          catch (error) { await candidate.close(); throw error; }
        }
        return new SqlAccessRepository(connected).read(caller);
      },
    };
    try {
      await target.connect();
      await seedAuth(target);
      const now = new Date();
      identity.groupsVerifiedAt = now.getTime();
      const outage = await resolveAccess(identity, repository, settings, now);
      expect(outage).toEqual({ state: "unavailable", breakGlass: true });
      expect(canAccess(outage, "admin")).toBe(true);
      expect(canAccess(outage, "health")).toBe(true);
      expect(canAccess(outage, "data")).toBe(false);
      expect(canAccess(outage, "feedback")).toBe(false);

      // Restore the same endpoint, forwarding only to the explicitly local SQL test instance.
      proxy.listen(port, "127.0.0.1");
      await once(proxy, "listening");
      const recovered = await resolveAccess(identity, repository, settings, now);
      expect(recovered).toEqual({ state: "no-access", breakGlass: false });
      expect(canAccess(recovered, "admin")).toBe(false);
      expect(canAccess(recovered, "health")).toBe(false);
      const sqlAdmin = await resolveAccess({ ...identity, objectId: AUTH_OBJECTS[0]! }, repository, settings, now);
      expect(sqlAdmin.state).toBe("authorized");
      expect(sqlAdmin.breakGlass).toBe(false);
      expect(canAccess(sqlAdmin, "admin")).toBe(true);
    } finally {
      await connected?.close();
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) {
        await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      }
      await target.close();
    }
  });
});
