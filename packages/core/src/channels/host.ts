import type { AppConfig } from "@rocky/contracts";
import type { SecretStore } from "../secrets/keychain.ts";
import { ntfyRequest, type PhoneMessage } from "./ntfy.ts";
import {
  sendMessageBody,
  type TelegramInbound,
  type TelegramOutbound,
  TelegramPoller,
  telegramCall,
} from "./telegram.ts";

/**
 * Phone channels (roadmap A3, D-065, D-066). Their secrets (the ntfy topic and token, the
 * Telegram bot token) are read only in the channel host process, which may reach nothing but
 * the ntfy server in the settings and api.telegram.org. The daemon asks it to send; it never
 * sees them.
 */

export const CHANNEL_SECRETS = [
  "channel.ntfy-topic",
  "channel.ntfy-token",
  "channel.telegram-token",
] as const;
export type ChannelSecret = (typeof CHANNEL_SECRETS)[number];
export type ChannelName = "ntfy" | "telegram";

const SECRETS_OF: Record<ChannelName, ChannelSecret[]> = {
  ntfy: ["channel.ntfy-topic", "channel.ntfy-token"],
  telegram: ["channel.telegram-token"],
};

export class ChannelBlocked extends Error {
  readonly code = "EGRESS_BLOCKED";
}

export interface ChannelStatus {
  ntfy: { topicSet: boolean; tokenSet: boolean };
  telegram: {
    tokenSet: boolean;
    /** The bot's @username, learned when the token was saved. */
    bot: string | null;
    /** The last person who sent /start but isn't allowed yet, so Settings can offer to add them. */
    stranger: { id: number; name: string; at: number } | null;
  };
}

export interface ChannelHost {
  sendNtfy(m: PhoneMessage): Promise<void>;
  sendTelegram(m: TelegramOutbound): Promise<void>;
  answerCallback(callbackId: string, text: string): Promise<void>;
  setSecret(name: ChannelSecret, value: string): Promise<void>;
  /** Checks a newly saved bot token with getMe and returns the bot's @username. */
  telegramIdentity(): Promise<string>;
  deleteSecrets(channel: ChannelName): Promise<void>;
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
  private bot: string | null = null;
  private stranger: ChannelStatus["telegram"]["stranger"] = null;
  private readonly now: () => number;

  constructor(opts: {
    secrets: SecretStore;
    fetch: typeof fetch;
    config: () => AppConfig;
    now?: () => number;
  }) {
    this.secrets = opts.secrets;
    this.fetch = opts.fetch;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
  }

  /** Checked here, not only in the daemon: local-only means nothing leaves (D-065). */
  private guard(channel: ChannelName): AppConfig {
    const config = this.config();
    if (config.localOnly)
      throw new ChannelBlocked("Local-only mode is on, so phone notifications are off.");
    if (!config.notifications[channel].enabled)
      throw new ChannelBlocked(
        `${channel === "ntfy" ? "ntfy" : "Telegram"} is switched off in Settings.`,
      );
    return config;
  }

  async sendNtfy(m: PhoneMessage): Promise<void> {
    const ntfy = this.guard("ntfy").notifications.ntfy;
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
          ? "ntfy is rate-limiting this server; this notification was dropped."
          : `ntfy answered ${res.status}.`,
      );
  }

  private telegramToken(): string {
    const token = this.secrets.get("channel.telegram-token");
    if (!token) throw new ChannelBlocked("No Telegram bot token is set.");
    return token;
  }

  async sendTelegram(m: TelegramOutbound): Promise<void> {
    const config = this.guard("telegram");
    // Only to people the user allowed, whatever the daemon asks.
    if (!config.notifications.telegram.userIds.includes(m.chatId))
      throw new ChannelBlocked("That Telegram user isn't on the allowed list.");
    await telegramCall(this.fetch, this.telegramToken(), "sendMessage", sendMessageBody(m));
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    this.guard("telegram");
    await telegramCall(this.fetch, this.telegramToken(), "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: text.slice(0, 200),
    });
  }

  async telegramIdentity(): Promise<string> {
    if (this.config().localOnly)
      throw new ChannelBlocked("Local-only mode is on, so Rocky can't reach Telegram.");
    const me = await telegramCall<{ username?: string }>(
      this.fetch,
      this.telegramToken(),
      "getMe",
      {},
    );
    this.bot = me.username ?? null;
    return this.bot ?? "";
  }

  /** The poller the host process runs; allowed users from the current settings. */
  poller(onInbound: (m: TelegramInbound) => void): TelegramPoller {
    return new TelegramPoller({
      fetch: this.fetch,
      token: () => {
        const c = this.config();
        return c.localOnly || !c.notifications.telegram.enabled
          ? null
          : this.secrets.get("channel.telegram-token");
      },
      allowed: () => this.config().notifications.telegram.userIds,
      onInbound: (m) => {
        // A stranger's /start stays here: Settings shows the ID so the user can allow it.
        if (m.kind === "stranger") this.stranger = { id: m.fromId, name: m.name, at: this.now() };
        else onInbound(m);
      },
    });
  }

  async setSecret(name: ChannelSecret, value: string): Promise<void> {
    if (!CHANNEL_SECRETS.includes(name)) throw new Error(`Unknown channel secret ${name}`);
    this.secrets.set(name, value);
    if (name === "channel.telegram-token") this.bot = null;
  }

  async deleteSecrets(channel: ChannelName): Promise<void> {
    for (const n of SECRETS_OF[channel]) this.secrets.delete(n);
    if (channel === "telegram") {
      this.bot = null;
      this.stranger = null;
    }
  }

  async status(): Promise<ChannelStatus> {
    return {
      ntfy: {
        topicSet: this.secrets.has("channel.ntfy-topic"),
        tokenSet: this.secrets.has("channel.ntfy-token"),
      },
      telegram: {
        tokenSet: this.secrets.has("channel.telegram-token"),
        bot: this.bot,
        stranger: this.stranger,
      },
    };
  }

  async close(): Promise<void> {}
}
