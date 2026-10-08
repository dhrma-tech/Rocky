import { fileURLToPath } from "node:url";
import { loadPlugins } from "@rocky/connector-sdk";
import { builtinConnectors } from "@rocky/connectors";
import { ConnectorCreateSchema, ConnectorUpdateSchema } from "@rocky/contracts";
import type { ConnectorRegistry, Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";

/** The connector host process entry (connector-host.ts). The daemon and the CLI fork it. */
export const CONNECTOR_HOST_ENTRY = fileURLToPath(new URL("./connector-host.ts", import.meta.url));

/** Built-ins plus the plugins in `config.plugins`; the daemon and the connector host load the same set. */
export async function loadConnectorDefinitions(
  registry: ConnectorRegistry,
  plugins: string[],
  dataDir: string,
  log: (msg: string) => void,
): Promise<{ spec: string; error?: string }[]> {
  for (const c of builtinConnectors) if (!registry.get(c.id)) registry.register(c);
  const results = await loadPlugins(plugins, { resolveFrom: dataDir });
  for (const r of results) {
    if (r.error) log(`plugin ${r.spec} not loaded: ${r.error}`);
    for (const c of r.connectors) {
      if (registry.get(c.id)) {
        log(`plugin ${r.spec}: connector "${c.id}" clashes with an existing one; skipped`);
        continue;
      }
      registry.register(c, { plugin: true });
    }
  }
  return results.map((r) => ({ spec: r.spec, ...(r.error ? { error: r.error } : {}) }));
}

/**
 * Registers the built-in connectors and the plugins listed in `config.plugins`, then the actions
 * of connectors that are already added. The daemon and the CLI both call this; core never
 * imports concrete connectors (security/boundaries.test.ts).
 */
export async function registerConnectors(
  rt: Runtime,
  log: (msg: string) => void = () => {},
): Promise<{ plugins: { spec: string; error?: string }[] }> {
  const plugins = await loadConnectorDefinitions(
    rt.connectorRegistry,
    rt.config.plugins,
    rt.dataDir,
    log,
  );
  rt.connectors.registerActions();
  try {
    await rt.connectors.host.refresh();
  } catch (err) {
    log(`connector host not ready: ${String(err)}`);
  }
  return { plugins };
}

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;

const SecretBody = z.object({ value: z.string().min(1).max(8192) }).strict();
const ClientBody = z.object({ json: z.string().min(2).max(20_000) }).strict();

/** Connectors screen (ui.md): setup, health, sync, log. Secrets are write-only. */
export function registerConnectorRoutes(
  api: Hono,
  { rt, body }: { rt: Runtime; body: Body },
): void {
  api.get("/connectors", (c) => c.json({ connectors: rt.connectors.list() }));
  api.get("/connectors/catalog", (c) => c.json({ catalog: rt.connectors.catalog() }));
  api.post("/connectors", async (c) => {
    const b = await body(c, ConnectorCreateSchema);
    return c.json(rt.connectors.add(b.kind, b.config, b.intervalMin), 201);
  });
  api.get("/connectors/:id", (c) => c.json(rt.connectors.get(c.req.param("id"))));
  api.patch("/connectors/:id", async (c) => {
    const patch = await body(c, ConnectorUpdateSchema);
    return c.json(rt.connectors.update(c.req.param("id"), patch));
  });
  api.delete("/connectors/:id", async (c) =>
    c.json(await rt.connectors.remove(c.req.param("id"), { purge: c.req.query("purge") === "1" })),
  );
  api.post("/connectors/:id/secrets/:name", async (c) => {
    const { value } = await body(c, SecretBody);
    await rt.connectors.setSecret(c.req.param("id"), c.req.param("name"), value);
    return c.json({ stored: true });
  });
  api.post("/connectors/oauth/:group/client", async (c) => {
    const { json } = await body(c, ClientBody);
    await rt.connectors.setOAuthClient(c.req.param("group"), json);
    return c.json({ stored: true });
  });
  api.post("/connectors/:id/auth", async (c) =>
    c.json(await rt.connectors.startOAuth(c.req.param("id"))),
  );
  api.post("/connectors/:id/test", async (c) =>
    c.json(await rt.connectors.test(c.req.param("id"))),
  );
  api.post("/connectors/:id/sync", (c) => {
    const id = c.req.param("id");
    rt.connectors.get(id); // 404 for unknown ids
    void rt.connectors.sync(id);
    return c.json({ started: true }, 202);
  });
  api.get("/connectors/:id/runs", (c) => c.json({ runs: rt.connectors.runs(c.req.param("id")) }));
}
