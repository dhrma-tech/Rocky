import type { Connector } from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * Notion Calendar (CONNECTORS.md #12): a virtual connector. Notion Calendar has no public data
 * API (confirmed 2026-10-07); it shows Google Calendar and Notion databases, which Rocky already
 * syncs. Turning this on adds "Open in Notion Calendar" links (its local cron://showEvent deep
 * link) to Google Calendar events on the timeline. It stores nothing and calls nothing.
 */

export const NotionCalendarConfigSchema = z.object({
  /** The Google account Notion Calendar is signed in with. */
  accountEmail: z.email(),
});
export type NotionCalendarConfig = z.infer<typeof NotionCalendarConfigSchema>;

export const notionCalendar: Connector<NotionCalendarConfig, Record<string, never>> = {
  id: "notion-calendar",
  tier: "link-only",
  egress: () => [],
  displayName: "Notion Calendar",
  permissions: "No access of its own: adds Open in Notion Calendar links to Google Calendar events",
  configSchema: NotionCalendarConfigSchema,
  secrets: [],
  defaultIntervalMin: 1440,
  readOnlyCapable: true,
  async *sync() {
    yield { documents: [], cursor: {} };
  },
  async health(ctx) {
    return {
      status: "ok",
      message: `Links open Notion Calendar for ${ctx.config.accountEmail}. Connect Google Calendar for the events themselves.`,
      account: ctx.config.accountEmail,
    };
  },
};
