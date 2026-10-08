// Roadmap I1: connector code runs in a separate host process that alone holds connector tokens,
// and it may only reach the hosts each connector declared.
import path from "node:path";
import { AuthExpired, type Connector } from "@rocky/connector-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ActionRegistry } from "../../src/actions/registry.ts";
import {
  type Channel,
  ConnectorEgressBlocked,
  ConnectorHostClient,
  ConnectorRegistry,
  ConnectorService,
  connectorOnlySecrets,
  coreOnlySecrets,
  egressHosts,
  forkConnectorHost,
  guardFetch,
  hostAllowed,
  InProcessConnectorHost,
  memorySecrets,
  openRuntime,
  serveConnectorHost,
} from "../../src/index.ts";
import { fixtureConnector, fixtureFetch } from "../fixtures/host-fixture.ts";
import { memoryDb, tempDir } from "../helpers.ts";
import { HW_HIGH } from "../router-helpers.ts";

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("egress allowlist", () => {
  it("matches exact hosts and *.domain subdomains only", () => {
    expect(hostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(hostAllowed("API.GitHub.com.", ["api.github.com"])).toBe(true);
    expect(hostAllowed("evil-api.github.com", ["api.github.com"])).toBe(false);
    expect(hostAllowed("x.googleapis.com", ["*.googleapis.com"])).toBe(true);
    expect(hostAllowed("googleapis.com", ["*.googleapis.com"])).toBe(false);
    expect(hostAllowed("evilgoogleapis.com", ["*.googleapis.com"])).toBe(false);
  });

  it("takes hosts from config URLs, adds the OAuth token host, and gives undeclared connectors nothing", () => {
    const base = { ...fixtureConnector } as Connector;
    expect(
      egressHosts({ ...base, egress: () => ["https://Cal.Example.org:8443/dav/"] }, {}),
    ).toEqual(["cal.example.org"]);
    expect(
      egressHosts(
        {
          ...base,
          egress: () => ["www.googleapis.com"],
          oauth: {
            group: "g",
            authUrl: "https://a",
            tokenUrl: "https://oauth2.googleapis.com/token",
            scopes: [],
          },
        },
        {},
      ).sort(),
    ).toEqual(["oauth2.googleapis.com", "www.googleapis.com"]);
    const { egress: _e, ...undeclared } = base;
    expect(egressHosts(undeclared as Connector, {})).toEqual([]);
    expect(
      egressHosts({ ...base, egress: () => ["not a host", "javascript:alert(1)"] }, {}),
    ).toEqual([]);
  });

  it("refuses a request before it is made", async () => {
    let calls = 0;
    const f = guardFetch(
      (async () => {
        calls++;
        return new Response("ok");
      }) as typeof fetch,
      () => ["api.github.com"],
      "Test",
    );
    await expect(f("https://evil.example/x")).rejects.toBeInstanceOf(ConnectorEgressBlocked);
    await expect(f(new Request("https://evil.example/x"))).rejects.toThrow(
      /not in its egress list/,
    );
    await f("https://api.github.com/user");
    expect(calls).toBe(1);
  });

  it("a connector that reaches for an undeclared host fails its sync and leaks nothing", async () => {
    const seen: string[] = [];
    const registry = new ConnectorRegistry();
    registry.register(fixtureConnector);
    const host = new InProcessConnectorHost({
      registry,
      secrets: memorySecrets({ "fixture.token": "s3cret" }),
      fetch: (async (u: string) => {
        seen.push(String(u));
        return new Response("ok");
      }) as typeof fetch,
    });
    const s = host.sync(
      { kind: "fixture", config: { mode: "evil" }, cursor: null, since: 0 },
      () => {},
    );
    await expect(collect(s.batches)).rejects.toBeInstanceOf(ConnectorEgressBlocked);
    expect(seen).toEqual([]);
  });
});

describe("secret split", () => {
  it("the daemon's store cannot read or write connector tokens, but can delete them", () => {
    const raw = memorySecrets({ anthropic: "k", "github.token": "t" });
    const core = coreOnlySecrets(raw);
    expect(core.get("anthropic")).toBe("k");
    expect(() => core.get("github.token")).toThrow(/connector host/);
    expect(() => core.has("github.token")).toThrow();
    expect(() => core.set("github.token", "x")).toThrow();
    expect(core.list().sort()).toEqual(["anthropic", "github.token"]);
    expect(core.delete("github.token")).toBe(true);
  });

  it("the connector host's store cannot touch model keys, the daemon token or the DB key", () => {
    const host = connectorOnlySecrets(
      memorySecrets({ anthropic: "k", "db-key": "d", "github.token": "t" }),
    );
    expect(host.get("github.token")).toBe("t");
    for (const n of ["anthropic", "db-key", "daemon-token"] as const) {
      expect(() => host.get(n)).toThrow();
      expect(() => host.delete(n)).toThrow();
    }
    expect(host.list()).toEqual(["github.token"]);
  });

  it("a production runtime (no test secrets) wraps the keychain so connector names are unreadable", async () => {
    const raw = memorySecrets({ "github.token": "t" });
    // `connectors: none` is what every CLI command that does not sync gets.
    const rt = await openRuntime({
      dataDir: tempDir(),
      secrets: raw,
      connectors: { kind: "none" },
      hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
    });
    try {
      expect(() => rt.secrets.get("github.token")).toThrow(/connector host/);
      expect(rt.connectors.host.setup("github").missing).toMatch(/connector host/);
    } finally {
      rt.close();
    }
  });
});

/** Two ends of an in-memory channel with structured cloning, like the real IPC. */
function channelPair(): [Channel & { close(): void }, Channel] {
  const toServer: ((m: unknown) => void)[] = [];
  const toClient: ((m: unknown) => void)[] = [];
  const deliver = (cbs: ((m: unknown) => void)[], m: unknown) => {
    const copy = structuredClone(m);
    queueMicrotask(() => {
      for (const cb of cbs) cb(copy);
    });
  };
  return [
    { send: (m) => deliver(toServer, m), onMessage: (cb) => toClient.push(cb), close: () => {} },
    { send: (m) => deliver(toClient, m), onMessage: (cb) => toServer.push(cb) },
  ];
}

function ipcHost(secrets = memorySecrets()) {
  const registry = new ConnectorRegistry();
  registry.register(fixtureConnector);
  const inner = new InProcessConnectorHost({ registry, secrets, fetch: fixtureFetch });
  const [clientEnd, serverEnd] = channelPair();
  serveConnectorHost(serverEnd, inner, () => registry.list().map((c) => c.id));
  return { client: new ConnectorHostClient({ connect: () => clientEnd }), registry, secrets };
}

describe("connector host over IPC", () => {
  it("reports setup state without ever sending a secret value back", async () => {
    const { client, secrets } = ipcHost();
    await client.refresh();
    expect(client.setup("fixture")).toEqual({
      missing: "Add the token.",
      stored: { token: false },
    });
    await client.setSecret("fixture", "token", "s3cret");
    expect(secrets.get("fixture.token")).toBe("s3cret");
    expect(client.setup("fixture")).toEqual({ missing: null, stored: { token: true } });
    expect(JSON.stringify(client.setup("fixture"))).not.toContain("s3cret");
    expect(await client.health("fixture", {})).toEqual({ status: "ok", message: "ok" });
    await client.deleteSecrets("fixture");
    expect(secrets.list()).toEqual([]);
    expect(client.setup("fixture").stored.token).toBe(false);
  });

  it("streams batches with binary bodies as bytes", async () => {
    const { client } = ipcHost(memorySecrets({ "fixture.token": "s3cret" }));
    const s = client.sync({ kind: "fixture", config: {}, cursor: 4, since: 0 });
    const batches = await collect(s.batches);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.cursor).toBe(5);
    const bin = batches[0]?.documents[1];
    expect(bin?.body.kind).toBe("binary");
    if (bin?.body.kind !== "binary") throw new Error("unreachable");
    expect(new TextDecoder().decode(await bin.body.fetch())).toBe("file body");
    expect(s.requests()).toBe(1);
  });

  it("rebuilds the errors callers branch on (auth expired, egress blocked)", async () => {
    const { client } = ipcHost(memorySecrets({ "fixture.token": "s3cret" }));
    const expired = client.sync({
      kind: "fixture",
      config: { mode: "expired" },
      cursor: null,
      since: 0,
    });
    await expect(collect(expired.batches)).rejects.toBeInstanceOf(AuthExpired);
    const evil = client.sync({ kind: "fixture", config: { mode: "evil" }, cursor: null, since: 0 });
    await expect(collect(evil.batches)).rejects.toBeInstanceOf(ConnectorEgressBlocked);
  });

  it("executes an action in the host and re-validates the payload there", async () => {
    const { client } = ipcHost(memorySecrets({ "fixture.token": "s3cret" }));
    const signal = new AbortController().signal;
    expect(
      await client.execute(
        "fixture",
        "fixture.write",
        { n: 3 },
        { idempotencyKey: "k", config: {} },
        signal,
      ),
    ).toEqual({ n: 3, sawToken: true });
    await expect(
      client.execute(
        "fixture",
        "fixture.write",
        { n: "3" },
        { idempotencyKey: "k", config: {} },
        signal,
      ),
    ).rejects.toThrow();
  });

  it("drives a ConnectorService sync end to end: documents persist, tokens never reach the service", async () => {
    const { client, registry } = ipcHost(memorySecrets({ "fixture.token": "s3cret" }));
    await client.refresh();
    const db = memoryDb();
    try {
      const svc = new ConnectorService({
        db,
        registry,
        actions: new ActionRegistry(),
        blobsDir: tempDir(),
        host: client,
      });
      svc.add("fixture", {});
      expect(svc.get("fixture").status).toBe("connected");
      await svc.sync("fixture");
      expect(svc.runs("fixture", 1)[0]).toMatchObject({ status: "ok", added: 2, requests: 1 });
      const rows = db.prepare("select external_id from documents order by external_id").all();
      expect(rows).toEqual([{ external_id: "b1" }, { external_id: "t1" }]);
    } finally {
      db.close();
    }
  });
});

describe("forked connector host process", () => {
  const entry = path.join(import.meta.dirname, "../fixtures/host-entry.ts");
  let client: ConnectorHostClient | undefined;
  afterEach(async () => {
    await client?.close();
  });

  it("holds the tokens and enforces egress on the global fetch", async () => {
    client = forkConnectorHost(entry, []);
    await client.refresh();
    expect(client.setup("fixture").missing).toBe("Add the token.");
    await client.setSecret("fixture", "token", "s3cret");
    expect(await client.health("fixture", {})).toMatchObject({ status: "ok" });
    const ok = await collect(
      client.sync({ kind: "fixture", config: {}, cursor: null, since: 0 }).batches,
    );
    expect(ok[0]?.documents.map((d) => d.externalId)).toEqual(["t1", "b1"]);
    const direct = client.sync({
      kind: "fixture",
      config: { mode: "evil-global" },
      cursor: null,
      since: 0,
    });
    await expect(collect(direct.batches)).rejects.toBeInstanceOf(ConnectorEgressBlocked);
    // The host's own keychain view refuses model keys, so the host can't leak them either.
    await expect(client.setSecret("fixture", "../anthropic", "x")).rejects.toThrow();
  }, 30_000);
});
