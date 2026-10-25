import { createHash } from "node:crypto";
import { type AppConfig, channelTakes, inQuietHours, type Notification } from "@rocky/contracts";
import { appendAudit } from "../audit/append.ts";
import type { Db } from "../store/db.ts";
import type { ChannelHost, ChannelName } from "./host.ts";
import type { PhoneMessage } from "./ntfy.ts";

/**
 * Which notifications reach the phone, and in what words (UI spec 16, D-065). Nothing goes out in
 * local-only mode or quiet hours, or for kinds the preferences keep in Rocky. Unless the user
 * turns details on, the message says only what kind of thing is waiting, never what it is: the
 * text passes through the ntfy server. Every send is audited with a hash, never the text.
 */

const GENERIC: Record<Notification["kind"], string> = {
  needs_you: "Something needs a look.",
  update: "Rocky finished something in the background.",
  heads_up: "A commitment is coming due.",
  system: "Rocky needs a look.",
};

export function phoneMessage(
  n: Notification,
  config: AppConfig,
  channel: ChannelName = "ntfy",
): PhoneMessage {
  const host = config.daemon.allowedHosts[0];
  const generic =
    n.kind === "needs_you" && n.link === "/approvals"
      ? "An approval is waiting for you."
      : GENERIC[n.kind];
  return {
    // Fixed, plain titles: header values must be Latin-1, and they carry nothing personal.
    title: n.kind === "needs_you" ? "Rocky needs you" : "Rocky",
    text: config.notifications[channel].details ? n.sentence : generic,
    ...(host && n.link ? { click: `https://${host}${n.link}` } : {}),
    priority: n.kind === "needs_you" ? "high" : "default",
  };
}

/** Why a notification won't reach the phone, or null when it will. */
export function phoneSkipReason(n: Notification, config: AppConfig, now: Date): string | null {
  if (config.localOnly) return "local-only";
  if (!config.notifications.ntfy.enabled && !config.notifications.telegram.enabled)
    return "no phone channel";
  if (!channelTakes(config.notifications.phone, n.kind)) return "kept in Rocky";
  if (inQuietHours(config.notifications.quietHours, now)) return "quiet hours";
  return null;
}

export class PhoneDispatcher {
  private readonly db: Db;
  private readonly host: ChannelHost;
  private readonly config: () => AppConfig;
  private readonly log: ((msg: string) => void) | undefined;
  private readonly now: () => Date;

  constructor(opts: {
    db: Db;
    host: ChannelHost;
    config: () => AppConfig;
    log?: (msg: string) => void;
    now?: () => Date;
  }) {
    this.db = opts.db;
    this.host = opts.host;
    this.config = opts.config;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  /** Sends one notification to each phone channel that is on. Never throws: the in-app record
   * stays whatever happens. */
  async dispatch(n: Notification): Promise<"sent" | "skipped" | "failed"> {
    const config = this.config();
    if (phoneSkipReason(n, config, this.now())) return "skipped";
    const tg = config.notifications.telegram;
    const sends: [ChannelName, () => Promise<string>][] = [];
    if (config.notifications.ntfy.enabled)
      sends.push([
        "ntfy",
        async () => {
          const m = phoneMessage(n, config, "ntfy");
          await this.host.sendNtfy(m);
          return m.text;
        },
      ]);
    if (tg.enabled && tg.userIds.length)
      sends.push([
        "telegram",
        async () => {
          const m = phoneMessage(n, config, "telegram");
          // Approvals carry a Review link only; in-chat Approve exists only under /approvals.
          for (const chatId of tg.userIds)
            await this.host.sendTelegram({
              chatId,
              text: `${m.title}: ${m.text}`,
              ...(m.click ? { buttons: [{ text: n.actionLabel, url: m.click }] } : {}),
            });
          return m.text;
        },
      ]);
    let sent = 0;
    for (const [channel, send] of sends) {
      try {
        const text = await send();
        appendAudit(this.db, {
          eventType: "notification_sent",
          actor: "system",
          subjectType: "notification",
          subjectId: n.id,
          meta: {
            channel,
            kind: n.kind,
            details: config.notifications[channel].details,
            textHash: createHash("sha256").update(text).digest("hex"),
          },
        });
        sent++;
      } catch (err) {
        this.log?.(
          `${channel} notification not sent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent ? "sent" : "failed";
  }
}
