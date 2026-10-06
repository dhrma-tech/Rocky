import { Entry, findCredentials } from "@napi-rs/keyring";

/** Every Rocky secret lives in the OS keychain under this service (SECURITY.md). Never in files, the DB or logs. */
export const SECRET_SERVICE = "rocky";

export const SECRET_NAMES = ["anthropic", "google", "openai_compatible", "daemon-token"] as const;
export type CoreSecretName = (typeof SECRET_NAMES)[number];
/** Connector secrets are namespaced: "github.token", "google-oauth.refresh". */
export type ConnectorSecretName = `${string}.${string}`;
export type SecretName = CoreSecretName | ConnectorSecretName;

export const CONNECTOR_SECRET_RE = /^[a-z0-9][a-z0-9-]{0,39}.[a-z0-9][a-z0-9_-]{0,39}$/;

export interface SecretStore {
  get(name: SecretName): string | null;
  set(name: SecretName, value: string): void;
  delete(name: SecretName): boolean;
  has(name: SecretName): boolean;
  /** Every stored name (never values), for "delete everything". */
  list(): string[];
}

export function keychainSecrets(service = SECRET_SERVICE): SecretStore {
  const entry = (name: string) => new Entry(service, name);
  return {
    get: (name) => entry(name).getPassword() ?? null,
    set: (name, value) => {
      if (!value.trim()) throw new Error("Refusing to store an empty secret");
      entry(name).setPassword(value.trim());
    },
    delete: (name) => entry(name).deletePassword(),
    has: (name) => entry(name).getPassword() != null,
    list: () => findCredentials(service).map((c) => c.account),
  };
}

/** In-memory store for tests and for running without a keychain. */
export function memorySecrets(initial: Partial<Record<string, string>> = {}): SecretStore {
  const m = new Map<string, string>(
    Object.entries(initial).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return {
    get: (n) => m.get(n) ?? null,
    set: (n, v) => void m.set(n, v),
    delete: (n) => m.delete(n),
    has: (n) => m.has(n),
    list: () => [...m.keys()],
  };
}
