// Forked by security/connector-host.test.ts: a connector host with an in-memory keychain, wired
// exactly like apps/daemon/src/connector-host.ts (connector-only secrets, global fetch guard).
import {
  ConnectorRegistry,
  connectorOnlySecrets,
  guardFetch,
  InProcessConnectorHost,
  memorySecrets,
  serveConnectorHost,
} from "../../src/index.ts";
import { fixtureConnector, fixtureFetch } from "./host-fixture.ts";

const registry = new ConnectorRegistry();
registry.register(fixtureConnector);
const host = new InProcessConnectorHost({
  registry,
  secrets: connectorOnlySecrets(memorySecrets({ anthropic: "model-key" })),
  fetch: fixtureFetch,
});
globalThis.fetch = guardFetch(fixtureFetch, () => host.allowedHosts, "Connector code");
serveConnectorHost(
  { send: (m) => process.send?.(m), onMessage: (cb) => process.on("message", cb) },
  host,
  () => registry.list().map((c) => c.id),
);
process.on("disconnect", () => process.exit(0));
