import { EXECUTORS } from "./internal.ts";
import type { ActionDefinition, PublicActionDefinition } from "./types.ts";

/** Holds action definitions. Executors are stored out of reach; `get()` never returns one. */
export class ActionRegistry {
  private readonly defs = new Map<string, PublicActionDefinition>();

  constructor() {
    EXECUTORS.set(this, new Map());
  }

  register<P>(def: ActionDefinition<P>): void {
    if (this.defs.has(def.type)) throw new Error(`Action type already registered: ${def.type}`);
    const { execute, ...pub } = def;
    this.defs.set(def.type, pub as PublicActionDefinition);
    EXECUTORS.get(this)?.set(def.type, execute as ActionDefinition["execute"]);
  }

  get(type: string): PublicActionDefinition | undefined {
    return this.defs.get(type);
  }

  types(): string[] {
    return [...this.defs.keys()];
  }
}
