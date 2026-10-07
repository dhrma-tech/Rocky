import type { Connector } from "@rocky/connector-sdk";
import { github } from "./github/index.ts";
import { GOOGLE_GROUP } from "./google/common.ts";
import { gcal } from "./google/gcal.ts";
import { gdrive } from "./google/gdrive.ts";
import { gmail } from "./google/gmail.ts";
import { linear } from "./linear/index.ts";
import { notion } from "./notion/index.ts";
import { todoist } from "./todoist/index.ts";

export { GOOGLE_GROUP, gcal, gdrive, github, gmail, linear, notion, todoist };

/** Built-in connectors, registered by the daemon and CLI (core never imports this package). */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own config and cursor types.
export const builtinConnectors: Connector<any, any>[] = [
  github,
  notion,
  gmail,
  gcal,
  gdrive,
  linear,
];
