import { createHash } from "node:crypto";
import { type AppConfig, channelTakes, inQuietHours, type Notification } from "@rocky/contracts";
import { appendAudit } from "../audit/append.ts";
import type { Db } from "../store/db.ts";
import type { ChannelHost } from "./host.ts";
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

export function phoneMessage(n: Notification, config: AppConfig): PhoneMessage {
  const host = config.daemon.allowedHosts[0];
  const generic =
    n.kind === "needs_you" && n.link === "/approvals"
      ? "An approval is waiting for you."
      : GENERIC[n.kind];
  return {
    // Fixed, plain titles: header values must be Latin-1, and they carry nothing personal.
    title: n.kind === "needs_you" ? "Rocky needs you" : "Rocky",
    text: config.notifications.ntfy.details ? n.sentence : generic,
    ...(host && n.link ? { click: `https://${host}${n.link}` } : {}),
    priority: n.kind === "needs_you" ? "high" : "default",
  };
}

/** Why a notification won't reach the phone, or null when it will. */
export function phoneSkipReason(n: Notification, config: AppConfig, now: Date): string | null {
  if (config.localOnly) return "local-only";
  if (!config.notifications.ntfy.enabled) return "no phone channel";
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

  /** Sends one notification if the settings allow it. Never throws: the in-app record stays. */
  async dispatch(n: Notification): Promise<"sent" | "skipped" | "failed"> {
    const config = this.config();
    if (phoneSkipReason(n, config, this.now())) return "skipped";
    const m = phoneMessage(n, config);
    try {
      await this.host.sendNtfy(m);
      appendAudit(this.db, {
        eventType: "notification_sent",
        actor: "system",
        subjectType: "notification",
        subjectId: n.id,
        meta: {
          channel: "ntfy",
          kind: n.kind,
          details: config.notifications.ntfy.details,
          textHash: createHash("sha256").update(m.text).digest("hex"),
        },
      });
      return "sent";
    } catch (err) {
      this.log?.(
        `phone notification not sent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "failed";
    }
  }
}
