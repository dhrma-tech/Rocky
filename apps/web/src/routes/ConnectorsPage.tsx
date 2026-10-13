import type {
  ActionClass,
  ActionRule,
  Connector,
  ConnectorCatalogEntry,
  ConnectorStatus,
} from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Calendar,
  GitBranch,
  HardDrive,
  type LucideIcon,
  Mail,
  NotebookText,
  Plug,
  RefreshCw,
} from "lucide-react";
import { useRef, useState } from "react";
import { Chip } from "../agent-ui/StatusChip.tsx";
import { api } from "../api.ts";
import { SafeText } from "../components/SafeText.tsx";
import {
  Button,
  Card,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Segmented,
  Skeleton,
  Switch,
  Textarea,
  useToast,
} from "../ui/index.tsx";
import { ImportPanel } from "./ImportPanel.tsx";
import "./screens.css";

const TIER: Record<ConnectorCatalogEntry["tier"], { label: string; help: string }> = {
  supported: { label: "Supported", help: "Passes a nightly live test against a real account." },
  experimental: {
    label: "Experimental",
    help: "Tested against recorded data only. Expect rough edges with real accounts.",
  },
  "link-only": { label: "Link only", help: "Links to your items; no data access of its own." },
};

const ICONS: Record<string, LucideIcon> = {
  github: GitBranch,
  notion: NotebookText,
  gmail: Mail,
  gcal: Calendar,
  gdrive: HardDrive,
};

/** One status in words and tone (never colour alone). */
const STATUS: Record<
  ConnectorStatus | "available",
  { word: string; tone: "success" | "info" | "warning" | "error" | "neutral" }
> = {
  connected: { word: "Connected", tone: "success" },
  syncing: { word: "Syncing", tone: "info" },
  needs_reconnect: { word: "Sign in again", tone: "warning" },
  error: { word: "Error", tone: "error" },
  not_configured: { word: "Not set up", tone: "neutral" },
  disabled: { word: "Paused", tone: "neutral" },
  available: { word: "Available", tone: "neutral" },
};

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

const attention = (c: Connector | undefined) =>
  c?.status === "needs_reconnect" || c?.status === "error";

/**
 * Integrations (UI spec 15): connected and healthy first, then what needs attention, then what is
 * available. The drawer holds setup, permissions (ask or block per kind of change; allow lives in
 * Settings with its conditions), health, the sync log and Disconnect.
 */
export function ConnectorsPage() {
  const [open, setOpen] = useState<string | null>(null);
  const catalog = useQuery({ queryKey: ["connectors", "catalog"], queryFn: api.catalog });
  const list = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors,
    refetchInterval: (q) =>
      q.state.data?.connectors.some((c) => c.status === "syncing") ? 3000 : 15_000,
  });
  const byKind = new Map((list.data?.connectors ?? []).map((c) => [c.kind, c]));
  const entries = catalog.data?.catalog ?? [];
  const entry = entries.find((c) => c.kind === open);
  const connected = entries.filter((e) => byKind.has(e.kind));
  const healthy = connected.filter((e) => !attention(byKind.get(e.kind)));
  const needs = connected.filter((e) => attention(byKind.get(e.kind)));
  const available = entries.filter((e) => !byKind.has(e.kind));

  const grid = (es: ConnectorCatalogEntry[]) => (
    <ul className="rk-routines">
      {es.map((e) => (
        <ConnectorCard
          key={e.kind}
          entry={e}
          connector={byKind.get(e.kind)}
          onOpen={() => setOpen(e.kind)}
        />
      ))}
    </ul>
  );

  let body: React.ReactNode;
  if (catalog.isLoading || list.isLoading)
    body = <Skeleton rows={3} height={160} label="Loading integrations" />;
  else if (catalog.error ?? list.error)
    body = (
      <ErrorState
        title="Couldn't read your integrations."
        happened={(catalog.error ?? list.error)?.message ?? ""}
        rockyDid="Nothing was changed. Syncs keep their schedule."
        fix={
          <Button
            variant="primary"
            onClick={() => {
              void catalog.refetch();
              void list.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  else
    body = (
      <>
        {needs.length > 0 && (
          <section className="rk-section" aria-labelledby="int-needs">
            <h2 id="int-needs" className="rk-h2">
              Needs attention
            </h2>
            {grid(needs)}
          </section>
        )}
        {healthy.length > 0 ? (
          <section className="rk-section" aria-labelledby="int-on">
            <h2 id="int-on" className="rk-h2">
              Connected
            </h2>
            {grid(healthy)}
          </section>
        ) : (
          !needs.length && (
            <EmptyState headline="No tools connected.">
              Rocky can still use the files you add. Connect a tool below to search it too.
            </EmptyState>
          )
        )}
        {available.length > 0 && (
          <section className="rk-section" aria-labelledby="int-available">
            <h2 id="int-available" className="rk-h2">
              Available
            </h2>
            {grid(available)}
          </section>
        )}
        <ImportPanel />
      </>
    );

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Integrations</h1>
      </header>
      <p className="rk-muted" style={{ marginTop: 0, marginBottom: "var(--space-6)" }}>
        Rocky keeps a local copy of what you connect, synced every few minutes. Sign-in tokens stay
        in your operating system's keychain. Nothing changes in your apps without your approval.
      </p>
      {body}
      <Drawer
        open={entry !== undefined}
        onClose={() => setOpen(null)}
        title={entry?.displayName ?? "Integration"}
      >
        {entry && (
          <ConnectorDetail
            key={entry.kind}
            entry={entry}
            connector={byKind.get(entry.kind)}
            onClose={() => setOpen(null)}
          />
        )}
      </Drawer>
    </div>
  );
}

/** Integration card (UI spec 15): icon, name, status, last used; one action. */
function ConnectorCard({
  entry,
  connector,
  onOpen,
}: {
  entry: ConnectorCatalogEntry;
  connector: Connector | undefined;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.syncConnector(entry.kind),
    onSettled: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
  });
  const Icon = ICONS[entry.kind] ?? Plug;
  const status = connector?.status ?? "available";
  const s = STATUS[status];
  const warn = attention(connector);
  return (
    <Card as="li" className={`rk-routine${warn ? " rk-routine--warn" : ""}`}>
      <div className="rk-int__head">
        <span className="rk-int__icon" aria-hidden="true">
          <Icon size={20} strokeWidth={1.5} />
        </span>
        <h3 className="rk-h3 rk-task__title">{entry.displayName}</h3>
        <Chip tone={s.tone}>{s.word}</Chip>
      </div>
      <p className="rk-small" style={{ margin: 0 }}>
        <span title={TIER[entry.tier].help}>{TIER[entry.tier].label}</span>
        <span className="rk-muted">
          {" · "}
          {connector
            ? `last sync ${relativeTime(connector.lastSyncAt)} · ${connector.documentCount} items`
            : "not connected"}
        </span>
      </p>
      {warn && connector?.message && (
        <p className="rk-small" style={{ margin: 0 }}>
          <SafeText text={connector.message} />
        </p>
      )}
      <div className="rk-routine__actions">
        {!connector ? (
          <Button dense onClick={onOpen} aria-label={`Connect ${entry.displayName}`}>
            Connect
          </Button>
        ) : warn || status === "not_configured" ? (
          <Button
            dense
            onClick={onOpen}
            aria-label={`${status === "needs_reconnect" ? "Reconnect" : "Fix"} ${entry.displayName}`}
          >
            {status === "needs_reconnect"
              ? "Reconnect"
              : status === "error"
                ? "Fix"
                : "Finish setup"}
          </Button>
        ) : (
          <>
            <Button dense onClick={onOpen} aria-label={`Details: ${entry.displayName}`}>
              Details
            </Button>
            <Button
              dense
              variant="tertiary"
              icon={<RefreshCw size={16} strokeWidth={1.5} aria-hidden />}
              disabled={status === "syncing"}
              loading={sync.isPending && "Syncing…"}
              onClick={() => sync.mutate()}
              aria-label={`Sync now: ${entry.displayName}`}
            >
              Sync now
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

function ConfigForm({
  entry,
  connector,
}: {
  entry: ConnectorCatalogEntry;
  connector: Connector | undefined;
}) {
  const qc = useQueryClient();
  const cfg = connector?.config ?? {};
  const [repos, setRepos] = useState(((cfg.repos as string[] | undefined) ?? []).join("\n"));
  const [days, setDays] = useState(String(cfg.backfillDays ?? ""));
  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { ...cfg };
      if (entry.kind === "github")
        config.repos = repos
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);
      if (days) config.backfillDays = Number(days);
      return connector
        ? api.updateConnector(connector.id, { config })
        : api.addConnector(entry.kind, config);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
  });
  return (
    <form
      className="rk-int__form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {entry.kind === "github" && (
        <Textarea
          label="Repositories"
          help="One per line, as owner/name."
          value={repos}
          rows={3}
          onChange={(e) => setRepos(e.target.value)}
        />
      )}
      {entry.kind !== "notion" && (
        <Input
          label="History to import (days)"
          type="number"
          min={1}
          max={3650}
          placeholder="90"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      )}
      {save.error && (
        <p role="alert" className="rk-small" style={{ whiteSpace: "pre-wrap" }}>
          {save.error.message}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant={connector ? "secondary" : "primary"}
          loading={save.isPending && "Saving…"}
        >
          {connector ? "Save settings" : `Connect ${entry.displayName}`}
        </Button>
      </div>
    </form>
  );
}

function SecretField({ id, spec }: { id: string; spec: ConnectorCatalogEntry["secrets"][number] }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.setConnectorSecret(id, spec.name, value),
    onSuccess: () => setValue(""),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["connectors"] }),
  });
  const label = `${spec.label[0]?.toUpperCase() ?? ""}${spec.label.slice(1)}${spec.stored ? " (stored)" : ""}`;
  return (
    <form
      className="rk-int__form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) save.mutate();
      }}
    >
      <Input
        label={label}
        help={`${spec.description ? `${spec.description} ` : ""}Kept in the OS keychain and never shown again after saving.`}
        type="password"
        autoComplete="off"
        value={value}
        placeholder={spec.stored ? "Paste a new one to replace it" : ""}
        onChange={(e) => setValue(e.target.value)}
      />
      {save.error && (
        <p role="alert" className="rk-small">
          {save.error.message}
        </p>
      )}
      <div>
        <Button type="submit" disabled={!value} loading={save.isPending && "Saving…"}>
          Save
        </Button>
      </div>
    </form>
  );
}

function GoogleSignIn({
  entry,
  connector,
}: {
  entry: ConnectorCatalogEntry;
  connector: Connector;
}) {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const client = useMutation({
    mutationFn: async (f: File) => api.setOAuthClient(entry.oauthGroup as string, await f.text()),
    onSuccess: () => setNote("Client stored. You can delete the downloaded file."),
    onSettled: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
  });
  const auth = useMutation({
    mutationFn: () => api.startAuth(connector.id),
    onSuccess: ({ authUrl }) => {
      // Explicit, user-initiated navigation to Google's consent page (never automatic).
      window.open(authUrl, "_blank", "noopener,noreferrer");
      setNote("Finish signing in in the new tab. This page updates by itself.");
    },
  });
  const needsClient = connector.message?.startsWith("Import the Google client");
  return (
    <div className="rk-int__form">
      <p className="rk-small rk-muted" style={{ margin: 0 }}>
        Google sign-in is shared by Gmail, Calendar and Drive. It uses your own Google Cloud OAuth
        client (Desktop app), as described in the setup checklist.
      </p>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) client.mutate(f);
          e.target.value = "";
        }}
      />
      <div className="rk-routine__actions">
        <Button
          variant={needsClient ? "primary" : "secondary"}
          onClick={() => file.current?.click()}
        >
          Import client file
        </Button>
        <Button
          variant={!needsClient && connector.status !== "connected" ? "primary" : "secondary"}
          disabled={needsClient}
          loading={auth.isPending && "Opening…"}
          onClick={() => auth.mutate()}
        >
          {connector.status === "connected" ? "Sign in again" : "Sign in with Google"}
        </Button>
      </div>
      {note && (
        <p className="rk-small" style={{ margin: 0 }}>
          {note}
        </p>
      )}
      {(client.error ?? auth.error) && (
        <p role="alert" className="rk-small">
          {(client.error ?? auth.error)?.message}
        </p>
      )}
    </div>
  );
}

const ROWS: { cls: ActionClass; title: string; allowNote: string }[] = [
  {
    cls: "write",
    title: "Write",
    allowNote: "To let Rocky skip asking, make an allow rule with a condition and an end date.",
  },
  { cls: "send", title: "Send", allowNote: "Rocky always asks before anything is sent." },
  { cls: "delete", title: "Delete", allowNote: "Rocky always asks before anything is deleted." },
];

/**
 * The permissions matrix (UI spec 15) built on rules (A4): each kind of change is Ask (the
 * default) or Block for this tool. Allow is never a blanket switch (X4): it needs a condition and
 * an end date, so it is made in Settings, and never applies to send or delete.
 */
function Permissions({ kind, name }: { kind: string; name: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules });
  const mine = (rules.data?.rules ?? []).filter(
    (r) => r.revokedAt === null && r.connectorId === kind,
  );
  const blockFor = (cls: ActionClass): ActionRule | undefined =>
    mine.find(
      (r) =>
        r.effect === "block" &&
        r.actionClass === cls &&
        r.actionType === null &&
        r.constraints.length === 0,
    );
  const set = useMutation({
    mutationFn: async ({ cls, to }: { cls: ActionClass; to: "ask" | "block" }) => {
      const existing = blockFor(cls);
      if (to === "block" && !existing)
        await api.createRule({
          effect: "block",
          connectorId: kind,
          actionType: null,
          actionClass: cls,
          constraints: [],
          note: `Blocked from ${name}'s Integrations page`,
        });
      if (to === "ask" && existing) await api.revokeRule(existing.id);
    },
    onSuccess: (_x, { cls, to }) => {
      void qc.invalidateQueries({ queryKey: ["rules"] });
      toast({
        text:
          to === "block"
            ? `Rocky can't ${cls} in ${name} now. Proposals are blocked.`
            : `Rocky asks before it can ${cls} in ${name}.`,
      });
    },
  });
  const allows = mine.filter((r) => r.effect === "allow");
  if (rules.isLoading) return <Skeleton rows={3} height={44} label="Loading permissions" />;
  return (
    <div className="rk-int__form">
      <div className="rk-int__perm">
        <span className="rk-int__perm-name">Read</span>
        <span className="rk-small rk-muted">
          Allowed while connected: syncs copy what you chose into Rocky.
        </span>
      </div>
      {ROWS.map((row) => (
        <div key={row.cls} className="rk-int__perm">
          <span className="rk-int__perm-name">{row.title}</span>
          <Segmented
            label={`${row.title} in ${name}`}
            value={blockFor(row.cls) ? "block" : "ask"}
            onChange={(to) => set.mutate({ cls: row.cls, to })}
            options={[
              { value: "ask", label: "Ask" },
              { value: "block", label: "Block" },
            ]}
          />
          <span className="rk-small rk-muted">{row.allowNote}</span>
        </div>
      ))}
      {allows.length > 0 && (
        <div>
          <p className="rk-small" style={{ margin: 0 }}>
            Allowed without asking:
          </p>
          <ul className="rk-small" style={{ margin: 0 }}>
            {allows.map((r) => (
              <li key={r.id}>{r.sentence}</li>
            ))}
          </ul>
        </div>
      )}
      {set.error && (
        <p role="alert" className="rk-small">
          {set.error.message}
        </p>
      )}
      <Link to="/settings" search={{ section: "rules" }} className="rk-small">
        All rules, and allow rules with conditions, in Settings
      </Link>
    </div>
  );
}

function ConnectorDetail({
  entry,
  connector,
  onClose,
}: {
  entry: ConnectorCatalogEntry;
  connector: Connector | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [purge, setPurge] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["connectors"] });
  const runs = useQuery({
    queryKey: ["connectors", entry.kind, "runs"],
    queryFn: () => api.connectorRuns(entry.kind),
    enabled: Boolean(connector),
    refetchInterval: connector?.status === "syncing" ? 3000 : false,
  });
  const test = useMutation({ mutationFn: () => api.testConnector(entry.kind), onSettled: refresh });
  const sync = useMutation({ mutationFn: () => api.syncConnector(entry.kind), onSettled: refresh });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateConnector(entry.kind, { enabled }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.removeConnector(entry.kind, purge),
    onSuccess: () => {
      setConfirm(false);
      onClose();
    },
    onSettled: refresh,
  });
  const s = STATUS[connector?.status ?? "available"];

  return (
    <div className="rk-int__detail">
      <p className="rk-small" style={{ margin: 0 }}>
        <Chip tone={s.tone}>{s.word}</Chip> {TIER[entry.tier].label}:{" "}
        <span className="rk-muted">{TIER[entry.tier].help}</span>
      </p>
      {connector?.message && (
        <p
          role={attention(connector) ? "alert" : "status"}
          className="rk-int__message rk-small"
          style={{ margin: 0 }}
        >
          <SafeText text={connector.message} />
        </p>
      )}
      <section aria-labelledby="int-access" className="rk-int__block">
        <h3 id="int-access" className="rk-h3">
          Access
        </h3>
        <p className="rk-small" style={{ margin: 0 }}>
          {entry.permissions}
        </p>
      </section>
      <section aria-labelledby="int-setup" className="rk-int__block">
        <h3 id="int-setup" className="rk-h3">
          Settings
        </h3>
        <ConfigForm key={connector?.id ?? "new"} entry={entry} connector={connector} />
        {connector && (
          <Switch
            checked={connector.enabled}
            onChange={(v) => toggle.mutate(v)}
            label={`Sync automatically, every ${connector.intervalMin} minutes`}
          />
        )}
      </section>
      {connector && entry.secrets.length > 0 && (
        <section aria-labelledby="int-creds" className="rk-int__block">
          <h3 id="int-creds" className="rk-h3">
            Credentials
          </h3>
          {entry.secrets.map((x) => (
            <SecretField key={x.name} id={connector.id} spec={x} />
          ))}
        </section>
      )}
      {connector && entry.oauthGroup && (
        <section aria-labelledby="int-google" className="rk-int__block">
          <h3 id="int-google" className="rk-h3">
            Google sign-in
          </h3>
          <GoogleSignIn entry={entry} connector={connector} />
        </section>
      )}
      {connector && (
        <section aria-labelledby="int-perm" className="rk-int__block">
          <h3 id="int-perm" className="rk-h3">
            What Rocky may do in {entry.displayName}
          </h3>
          <Permissions kind={entry.kind} name={entry.displayName} />
        </section>
      )}
      {connector && (
        <section aria-labelledby="int-health" className="rk-int__block">
          <h3 id="int-health" className="rk-h3">
            Health
          </h3>
          <div className="rk-routine__actions">
            <Button loading={test.isPending && "Testing…"} onClick={() => test.mutate()}>
              Test connection
            </Button>
            <Button
              icon={<RefreshCw size={16} strokeWidth={1.5} aria-hidden />}
              disabled={connector.status === "syncing"}
              loading={sync.isPending && "Syncing…"}
              onClick={() => sync.mutate()}
            >
              Sync now
            </Button>
          </div>
          {test.data && (
            <p className="rk-small" role="status" style={{ margin: 0 }}>
              <Chip tone={test.data.status === "ok" ? "success" : "warning"}>
                {test.data.status === "ok" ? "Works" : "Problem"}
              </Chip>{" "}
              {test.data.message}
            </p>
          )}
          {test.error && (
            <p role="alert" className="rk-small">
              {test.error.message}
            </p>
          )}
          <p className="rk-small rk-muted" style={{ margin: 0 }}>
            Last sync {relativeTime(connector.lastSyncAt)}
            {connector.nextSyncAt && connector.enabled
              ? ` · next ${new Date(connector.nextSyncAt).toLocaleTimeString()}`
              : ""}{" "}
            · {connector.documentCount} items
          </p>
        </section>
      )}
      {connector && (
        <section aria-labelledby="int-log" className="rk-int__block">
          <h3 id="int-log" className="rk-h3">
            Sync log
          </h3>
          {runs.data?.runs.length ? (
            <ol className="rk-int__log">
              {runs.data.runs.map((r) => (
                <li key={r.id}>
                  <span className="rk-nums">{new Date(r.startedAt).toLocaleString()}</span>{" "}
                  <Chip
                    tone={r.status === "ok" ? "success" : r.status === "error" ? "error" : "info"}
                  >
                    {r.status === "ok" ? "OK" : r.status === "error" ? "Failed" : "Running"}
                  </Chip>{" "}
                  <span className="rk-nums rk-muted">
                    +{r.added} ~{r.updated} −{r.deleted} · {r.requests} requests
                    {r.full ? " · full" : ""}
                  </span>
                  {r.error && (
                    <span className="rk-int__error">
                      <SafeText text={r.error} />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="rk-small rk-muted" style={{ margin: 0 }}>
              No syncs yet.
            </p>
          )}
          <details className="rk-small">
            <summary>Cursor</summary>
            <pre className="rk-files__text">{JSON.stringify(connector.cursor, null, 2)}</pre>
          </details>
        </section>
      )}
      {connector && (
        <section aria-labelledby="int-off" className="rk-int__block">
          <h3 id="int-off" className="rk-h3">
            Disconnect
          </h3>
          <div>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              Disconnect {entry.displayName}
            </Button>
          </div>
        </section>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Disconnect ${entry.displayName}?`}
        actions={
          <>
            <Button variant="tertiary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending && "Disconnecting…"}
              onClick={() => remove.mutate()}
            >
              Disconnect
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          Rocky stops syncing and removes its stored credentials
          {entry.oauthGroup ? " (unless another Google connector still uses them)" : ""}.
        </p>
        <Checkbox
          checked={purge}
          onChange={setPurge}
          label={`Also delete the ${connector?.documentCount ?? 0} item(s) it synced, with their search index and anything extracted from them.`}
        />
        {remove.error && (
          <p role="alert" className="rk-small">
            {remove.error.message}
          </p>
        )}
      </Modal>
    </div>
  );
}
