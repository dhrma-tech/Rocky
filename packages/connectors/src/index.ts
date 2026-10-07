import type { Connector } from "@rocky/connector-sdk";
import { asana } from "./asana/index.ts";
import { caldav } from "./caldav/index.ts";
import { github } from "./github/index.ts";
import { GOOGLE_GROUP } from "./google/common.ts";
import { gcal } from "./google/gcal.ts";
import { gdrive } from "./google/gdrive.ts";
import { gmail } from "./google/gmail.ts";
import { linear } from "./linear/index.ts";
import { notion } from "./notion/index.ts";
import { notionCalendar } from "./notion-calendar/index.ts";
import { posthog } from "./posthog/index.ts";
import { slackConnector as slack } from "./slack/index.ts";
import { todoist } from "./todoist/index.ts";

export {
  asana,
  caldav,
  GOOGLE_GROUP,
  gcal,
  gdrive,
  github,
  gmail,
  linear,
  notion,
  notionCalendar,
  posthog,
  slack,
  todoist,
};

/** Built-in connectors (the 12 of PLAN.md), registered by the daemon and CLI (core never imports this package). */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own config and cursor types.
export const builtinConnectors: Connector<any, any>[] = [
  github,
  notion,
  gmail,
  gcal,
  gdrive,
  linear,
  todoist,
  slack,
  caldav,
  asana,
  posthog,
  notionCalendar,
];
