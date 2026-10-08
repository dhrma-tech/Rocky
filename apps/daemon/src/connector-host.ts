/**
 * The connector host process (roadmap I1). Forked by the daemon and the CLI; it is the only Rocky
 * process that reads or writes connector tokens, and the only one that runs connector network
 * code. Model calls never happen here. Its fetch is limited to hosts the connectors declared.
 * Talks to its parent over the IPC channel (packages/core/src/connectors/host-ipc.ts).
 */
import { parseArgs } from "node:util";
import {
  ConnectorRegistry,
  connectorOnlySecrets,
  guardFetch,
  InProcessConnectorHost,
  keychainSecrets,
  loadAppConfig,
  serveConnectorHost,
} from "@rocky/core";
import { loadConnectorDefinitions } from "./connectors.ts";

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
const dataDir = values["data-dir"];
if (!dataDir || !process.send) {
  console.error("connector-host: run by the daemon, with --data-dir");
  process.exit(2);
}

const log = (msg: string) => process.send?.({ t: "log", msg });
const config = loadAppConfig(dataDir);
const registry = new ConnectorRegistry();
await loadConnectorDefinitions(registry, config.plugins, dataDir, log);

const realFetch = globalThis.fetch;
const host = new InProcessConnectorHost({
  registry,
  secrets: connectorOnlySecrets(keychainSecrets()),
  fetch: realFetch,
  log,
});
// A connector calling the global fetch directly still meets the allowlist.
globalThis.fetch = guardFetch(realFetch, () => host.allowedHosts, "Connector code");

serveConnectorHost(
  {
    send: (m) => process.send?.(m),
    onMessage: (cb) => process.on("message", cb),
  },
  host,
  () => registry.list().map((c) => c.id),
);
// The parent went away: nothing left to serve.
process.on("disconnect", () => {
  void host.close().finally(() => process.exit(0));
});
