/**
 * The channel host process (roadmap A3, D-065, D-066). Forked by the daemon on first use; the only
 * Rocky process that reads phone channel secrets (the ntfy topic and token, the Telegram bot
 * token). Model calls and connector tokens never come here. While Telegram is on it long-polls
 * for messages and hands the daemon those from allowed users. Its fetch may reach only the ntfy server in the settings and
 * api.telegram.org. Talks to its parent over the IPC channel (packages/core/src/channels/host-ipc.ts).
 */
import { parseArgs } from "node:util";
import {
  channelEgress,
  channelOnlySecrets,
  emitInbound,
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

const wire = {
  send: (m: unknown) => process.send?.(m),
  onMessage: (cb: (m: unknown) => void) => process.on("message", cb),
};
const host = new InProcessChannelHost({
  secrets: channelOnlySecrets(keychainSecrets()),
  fetch: guarded,
  config,
});
serveChannelHost(wire, host);

// Telegram long polling. With Telegram off, local-only on or no token, the poller asks nothing
// and the loop checks again in 15 s; after an error it waits 10 s.
const poller = host.poller((m) => emitInbound(wire, m));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
void (async () => {
  for (;;) {
    try {
      if ((await poller.tick()) === null) await pause(15_000);
    } catch (err) {
      wire.send({ t: "log", msg: `telegram: ${err instanceof Error ? err.message : String(err)}` });
      await pause(10_000);
    }
  }
})();
// The parent went away: nothing left to serve.
process.on("disconnect", () => process.exit(0));
