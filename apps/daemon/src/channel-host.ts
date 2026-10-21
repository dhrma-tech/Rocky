/**
 * The channel host process (roadmap A3, D-065). Forked by the daemon on first use; the only Rocky
 * process that reads phone channel secrets (the ntfy topic and token). Model calls and connector
 * tokens never come here. Its fetch may reach only the ntfy server in the settings and
 * api.telegram.org. Talks to its parent over the IPC channel (packages/core/src/channels/host-ipc.ts).
 */
import { parseArgs } from "node:util";
import {
  channelEgress,
  channelOnlySecrets,
  guardFetch,
  InProcessChannelHost,
  keychainSecrets,
  loadAppConfig,
  serveChannelHost,
} from "@rocky/core";

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
const dataDir = values["data-dir"];
if (!dataDir || !process.send) {
  console.error("channel-host: run by the daemon, with --data-dir");
  process.exit(2);
}

// The settings are read on every send, so a change in Settings applies without a restart.
const config = () => loadAppConfig(dataDir);
const guarded = guardFetch(globalThis.fetch, () => channelEgress(config()), "The channel host");
globalThis.fetch = guarded;

serveChannelHost(
  {
    send: (m) => process.send?.(m),
    onMessage: (cb) => process.on("message", cb),
  },
  new InProcessChannelHost({
    secrets: channelOnlySecrets(keychainSecrets()),
    fetch: guarded,
    config,
  }),
);
// The parent went away: nothing left to serve.
process.on("disconnect", () => process.exit(0));
