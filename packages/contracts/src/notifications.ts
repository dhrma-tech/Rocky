import { z } from "zod";

/**
 * Notifications (UI spec 16): the few things worth interrupting the user for, and a record of the
 * rest. Derived on the engine from the event stream, so every screen and channel agrees.
 */

/** needs_you: an approval or a failure waiting on the user. update: background work finished.
 * heads_up: a commitment nudge (roadmap A7). system: Rocky itself (a routine paused, a backup). */
export const NotificationKindSchema = z.enum(["needs_you", "update", "heads_up", "system"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  at: z.number().int(),
  kind: NotificationKindSchema,
  /** One plain sentence. Never the payload of an action. */
  sentence: z.string(),
  /** Where "Open" or "Review" goes inside the app ("/approvals", "/runs/<id>"). */
  link: z.string().nullable(),
  /** "Review" for approvals: a glance can never approve (UI spec 16). */
  actionLabel: z.string(),
  runId: z.string().nullable(),
  readAt: z.number().int().nullable(),
  snoozedUntil: z.number().int().nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListQuerySchema = z.object({
  tab: z.enum(["all", "needs_you", "updates"]).default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Only rows newer than this id (ULIDs sort by time). */
  after: z.string().max(26).optional(),
});
export type NotificationListQuery = z.input<typeof NotificationListQuerySchema>;

export const NotificationListSchema = z.object({
  notifications: z.array(NotificationSchema),
  unread: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

const Ids = z.array(z.string().min(1).max(26)).min(1).max(500);

export const NotificationIdsSchema = z.object({ ids: Ids }).strict();

export const SnoozeSchema = z.object({ ids: Ids, until: z.number().int().positive() }).strict();

/** Which kinds reach a channel. In-app always keeps the full record. */
const ChannelPrefs = z.object({
  needsYou: z.boolean(),
  updates: z.boolean(),
  headsUp: z.boolean(),
});
export type ChannelPrefs = z.infer<typeof ChannelPrefs>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour");

export const NotificationPrefsSchema = z.object({
  /** The computer's own notifications, shown by the open app or the installed web app. */
  system: ChannelPrefs.default({ needsYou: true, updates: false, headsUp: true }),
  /** Phone channels (ntfy, Telegram), each also switched on in its own settings. */
  phone: ChannelPrefs.default({ needsYou: true, updates: false, headsUp: true }),
  /** Quiet hours silence system and phone channels; the in-app record stays. */
  quietHours: z
    .object({
      enabled: z.boolean().default(false),
      start: HHMM.default("22:00"),
      end: HHMM.default("07:00"),
    })
    .prefault({}),
  /** Heads-ups about commitments (roadmap A7, D-067): at most this many a day; 0 turns them off. */
  headsUp: z.object({ perDay: z.number().int().min(0).max(10).default(3) }).prefault({}),
  /**
   * ntfy (D-065): off by default. The topic and an optional access token are secrets in the
   * keychain, never here. Without `details`, a message says only what kind of thing is waiting.
   */
  ntfy: z
    .object({
      enabled: z.boolean().default(false),
      server: z
        .url()
        .refine(
          (u) =>
            u.startsWith("https://") || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u),
          "an https:// address (http only for a server on this computer)",
        )
        .default("https://ntfy.sh"),
      details: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Telegram (D-066): off by default. The bot token is a secret in the keychain. Only these user
   * IDs are heard; Approve in the chat only for low-risk writes, and only with this switch on
   * (D-002). Sends, spends and deletes always get a Review link.
   */
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      userIds: z.array(z.number().int().positive()).max(5).default([]),
      approveLowRiskInChat: z.boolean().default(false),
      /** As for ntfy: without it, a notification names only the kind of thing waiting. */
      details: z.boolean().default(false),
    })
    .prefault({}),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** Does this channel take this kind? System messages ride with needs-you. */
export function channelTakes(prefs: ChannelPrefs, kind: NotificationKind): boolean {
  if (kind === "update") return prefs.updates;
  if (kind === "heads_up") return prefs.headsUp;
  return prefs.needsYou;
}

/** Inside quiet hours at this local time? A window may cross midnight (22:00–07:00). */
export function inQuietHours(q: NotificationPrefs["quietHours"], now: Date): boolean {
  if (!q.enabled || q.start === q.end) return false;
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const t = now.getHours() * 60 + now.getMinutes();
  const start = mins(q.start);
  const end = mins(q.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}
