import type { Connector } from "@rocky/connector-sdk";
import { github } from "./github/index.ts";
import { notion } from "./notion/index.ts";

export { github, notion };

/** Built-in connectors, registered by the daemon and CLI (core never imports this package). */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own config and cursor types.
export const builtinConnectors: Connector<any, any>[] = [github, notion];
