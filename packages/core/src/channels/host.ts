import type { AppConfig } from "@rocky/contracts";
import type { SecretStore } from "../secrets/keychain.ts";
import { ntfyRequest, type PhoneMessage } from "./ntfy.ts";

/**
 * Phone channels (roadmap A3, D-065). Their secrets (the ntfy topic and token, later the Telegram
 * bot token) are read only in the channel host process, which may reach nothing but the ntfy
 * server in the settings and api.telegram.org. The daemon asks it to send; it never sees them.
 */

export const CHANNEL_SECRETS = ["channel.ntfy-topic", "channel.ntfy-token"] as const;
export type ChannelSecret = (typeof CHANNEL_SECRETS)[number];

export class ChannelBlocked extends Error {
  readonly code = "EGRESS_BLOCKED";
}

export interface ChannelStatus {
  ntfy: { topicSet: boolean; tokenSet: boolean };
}

export interface ChannelHost {
  sendNtfy(m: PhoneMessage): Promise<void>;
  setSecret(name: ChannelSecret, value: string): Promise<void>;
  deleteSecrets(): Promise<void>;
  status(): Promise<ChannelStatus>;
  close(): Promise<void>;
}

/** The hosts the channel host may reach, from the current settings. */
export function channelEgress(config: AppConfig): string[] {
  const hosts = ["api.telegram.org"];
  try {
    hosts.push(new URL(config.notifications.ntfy.server).hostname);
  } catch {}
  return hosts;
}

/** Runs channel code in the calling process; the forked host wraps one of these. */
export class InProcessChannelHost implements ChannelHost {
  private readonly secrets: SecretStore;
  private readonly fetch: typeof fetch;
  private readonly config: () => AppConfig;

  constructor(opts: { secrets: SecretStore; fetch: typeof fetch; config: () => AppConfig }) {
    this.secrets = opts.secrets;
    this.fetch = opts.fetch;
    this.config = opts.config;
  }

  async sendNtfy(m: PhoneMessage): Promise<void> {
    const config = this.config();
    // Checked again here, not only in the daemon: local-only means nothing leaves (D-065).
    if (config.localOnly)
      throw new ChannelBlocked("Local-only mode is on, so phone notifications are off.");
    const ntfy = config.notifications.ntfy;
    if (!ntfy.enabled) throw new ChannelBlocked("ntfy is switched off in Settings.");
    const topic = this.secrets.get("channel.ntfy-topic");
    if (!topic) throw new ChannelBlocked("No ntfy topic is set.");
    const { url, init } = ntfyRequest(
      ntfy.server,
      topic,
      this.secrets.get("channel.ntfy-token"),
      m,
    );
    const res = await this.fetch(url, init);
    if (!res.ok)
      throw new Error(
        res.status === 429
          ? "ntfy is rate-limiting this server. Rocky will try again with the next notification."
          : `ntfy answered ${res.status}.`,
      );
  }

  async setSecret(name: ChannelSecret, value: string): Promise<void> {
    if (!CHANNEL_SECRETS.includes(name)) throw new Error(`Unknown channel secret ${name}`);
    this.secrets.set(name, value);
  }

  async deleteSecrets(): Promise<void> {
    for (const n of CHANNEL_SECRETS) this.secrets.delete(n);
  }

  async status(): Promise<ChannelStatus> {
    return {
      ntfy: {
        topicSet: this.secrets.has("channel.ntfy-topic"),
        tokenSet: this.secrets.has("channel.ntfy-token"),
      },
    };
  }

  async close(): Promise<void> {}
}
