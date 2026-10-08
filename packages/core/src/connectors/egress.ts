import type { Connector } from "@rocky/connector-sdk";

/**
 * Egress allowlist for connector code (roadmap I1). Every request a connector makes goes through
 * a fetch that refuses hosts the connector did not declare. In the connector host process the
 * global fetch is replaced too, so a connector calling `fetch` directly is caught as well. This is
 * an in-process guard, not an OS firewall: code that opens raw sockets is out of its reach
 * (docs/DECISIONS.md D-023).
 */

export class ConnectorEgressBlocked extends Error {
  readonly code = "CONNECTOR_EGRESS_BLOCKED";
  /** The SDK's Http does not retry it. */
  readonly permanent = true;
}

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** True when `host` matches one pattern: an exact name, or "*.domain" for any subdomain. */
export function hostAllowed(host: string, patterns: Iterable<string>): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const p of patterns) {
    const q = p.toLowerCase();
    if (q.startsWith("*.") ? h.endsWith(q.slice(1)) : h === q) return true;
  }
  return false;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};

/** The hosts a connector may reach with this config: its declaration plus its OAuth token URL. */
export function egressHosts(def: Connector, config: unknown): string[] {
  let declared: string[] = [];
  try {
    declared = def.egress?.(config) ?? [];
  } catch {
    declared = [];
  }
  const out = new Set<string>();
  for (const d of declared) {
    // A declaration may be a URL (from config) or a host pattern.
    const h = d.includes("://") ? hostOf(d) : d.toLowerCase();
    if (h && HOST_RE.test(h)) out.add(h);
  }
  const token = def.oauth ? hostOf(def.oauth.tokenUrl) : null;
  if (token) out.add(token);
  return [...out];
}

const requestUrl = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** Wraps fetch so requests to hosts outside `allowed()` reject before any byte leaves. */
export function guardFetch(
  base: typeof fetch,
  allowed: () => Iterable<string>,
  label: string,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const host = hostOf(url);
    if (!host || !hostAllowed(host, allowed()))
      throw new ConnectorEgressBlocked(
        `${label} may not connect to ${host ?? url} (not in its egress list)`,
      );
    return base(input, init);
  }) as typeof fetch;
}
