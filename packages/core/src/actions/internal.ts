import type { ActionDefinition } from "./types.ts";

/**
 * Executors, keyed by registry. Only registry.ts (to store) and service.ts (to call) may import
 * this module; `security/no-write-without-approval.test.ts` enforces that statically.
 */
export const EXECUTORS = new WeakMap<object, Map<string, ActionDefinition["execute"]>>();
