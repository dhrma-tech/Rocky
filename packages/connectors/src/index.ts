import type { Connector } from "@rocky/connector-sdk";
import { github } from "./github/index.ts";

export { github };

/** Built-in connectors, registered by the daemon and CLI (core never imports this package). */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own config and cursor types.
export const builtinConnectors: Connector<any, any>[] = [github];
