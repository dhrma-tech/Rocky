import type { Connector, ConnectorCatalogEntry, ConnectorStatus } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  FileText,
  GitBranch,
  HardDrive,
  type LucideIcon,
  Mail,
  NotebookText,
  Plug,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { SafeText } from "../components/SafeText.tsx";
import { Badge, Button, cls, IconButton, Toggle } from "../components/ui.tsx";

const TIER: Record<ConnectorCatalogEntry["tier"], { label: string; help: string }> = {
  supported: { label: "Supported", help: "Passes a nightly live test against a real account." },
  experimental: {
    label: "Experimental",
    help: "Tested against recorded data only. Expect rough edges with real accounts.",
  },
  "link-only": { label: "Link only", help: "Links to your items; no data access of its own." },
};

function TierBadge({ tier }: { tier: ConnectorCatalogEntry["tier"] }) {
  const t = TIER[tier];
  return (
    <span title={t.help}>
      <Badge tone={tier === "supported" ? "success" : "neutral"}>
        {t.label}
        <span className="sr-only">: {t.help}</span>
      </Badge>
    </span>
  );
}

import { ImportPanel } from "./ImportPanel.tsx";

const ICONS: Record<string, LucideIcon> = {
  github: GitBranch,
  notion: NotebookText,
  gmail: Mail,
  gcal: Calendar,
  gdrive: HardDrive,
};

/** Status dot + word (DESIGN §5.7: never color alone). */
const STATUS: Record<ConnectorStatus | "available", { word: string; dot: string }> = {
  connected: { word: "Connected", dot: "bg-success" },
  syncing: { word: "Syncing", dot: "bg-info pulse-dot" },
  needs_reconnect: { word: "Needs reconnect", dot: "bg-warning" },
  error: { word: "Error", dot: "bg-danger" },
  not_configured: { word: "Not set up", dot: "bg-layer-strong" },
  disabled: { word: "Disabled", dot: "bg-layer-strong" },
  available: { word: "Available", dot: "bg-layer-strong" },
};

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

function StatusWord({ status }: { status: ConnectorStatus | "available" }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
      <span aria-hidden className={cls("size-2 rounded-full", s.dot)} />
      {s.word}
    </span>
  );
}

/** Connector health card (DESIGN §5.7): 280×160, status, last sync, permissions, actions. */
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
  return (
    <article
      aria-labelledby={`conn-${entry.kind}`}
      className="flex min-h-40 w-full flex-col rounded-lg bg-raised p-4 shadow-raised-sm sm:w-[280px]"
    >
      <header className="flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-md bg-accent-soft">
          <Icon size={20} aria-hidden className="text-accent-strong" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`conn-${entry.kind}`} className="truncate text-sm font-semibold">
            <button type="button" onClick={onOpen} className="hover:underline">
              {entry.displayName}
            </button>
          </h2>
          <StatusWord status={status} />
        </div>
        <TierBadge tier={entry.tier} />
      </header>
      <p className="mt-2 line-clamp-2 text-xs text-secondary">{entry.permissions}</p>
      <p className="mt-1 text-xs text-tertiary">
        {connector
          ? `Last sync ${relativeTime(connector.lastSyncAt)} · ${connector.documentCount} items`
          : "Not connected"}
      </p>
      <div className="mt-auto flex gap-2 pt-3">
        {!connector || status === "not_configured" || status === "needs_reconnect" ? (
          <Button variant="secondary" className="min-h-9" onClick={onOpen}>
            {status === "needs_reconnect" ? "Reconnect" : "Set up"}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              className="min-h-9"
              disabled={status === "syncing" || sync.isPending}
              onClick={() => sync.mutate()}
            >
              <RefreshCw size={14} aria-hidden /> Sync now
            </Button>
            <Button variant="ghost" className="min-h-9" onClick={onOpen}>
              Details
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/** DESIGN screen 8: grid of connector cards; the drawer holds setup, health and the sync log. */
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
  const entry = catalog.data?.catalog.find((c) => c.kind === open);

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-8">
          <h1 className="text-2xl font-normal leading-8">Connectors</h1>
          <p className="mt-2 max-w-prose text-sm text-secondary">
            Rocky keeps a local copy of what you connect, synced every few minutes. Tokens stay in
            the OS keychain. Nothing is written to your apps without your approval.
          </p>
          {(catalog.error ?? list.error) && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {(catalog.error ?? list.error)?.message}
            </p>
          )}
          <div className="mt-8 flex flex-wrap gap-4">
            {catalog.data?.catalog.map((e) => (
              <ConnectorCard
                key={e.kind}
                entry={e}
                connector={byKind.get(e.kind)}
                onOpen={() => setOpen(e.kind)}
              />
            ))}
          </div>
          <ImportPanel />
        </div>
      </div>
      {entry && (
        <div className="fixed inset-0 z-30 lg:relative lg:z-20">
          <ConnectorDrawer
            entry={entry}
            connector={byKind.get(entry.kind)}
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary">{title}</h3>
      {children}
    </section>
  );
}

const inputCls = "min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm";

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
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {entry.kind === "github" && (
        <label className="block text-sm">
          <span className="font-medium">Repositories</span>
          <span className="block text-xs text-secondary">One per line, as owner/name.</span>
          <textarea
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-border-strong bg-page p-3 font-mono text-sm"
          />
        </label>
      )}
      {entry.kind !== "notion" && (
        <label className="block text-sm">
          <span className="font-medium">History to import (days)</span>
          <input
            type="number"
            min={1}
            max={3650}
            placeholder={entry.kind === "github" ? "90" : "90"}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className={cls(inputCls, "mt-1 max-w-32")}
          />
        </label>
      )}
      {save.error && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-danger">
          {save.error.message}
        </p>
      )}
      <Button type="submit" variant={connector ? "secondary" : "primary"} disabled={save.isPending}>
        {connector ? "Save settings" : `Add ${entry.displayName}`}
      </Button>
    </form>
  );
}

function SecretField({ id, spec }: { id: string; spec: ConnectorCatalogEntry["secrets"][number] }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.setConnectorSecret(id, spec.name, value),
    onSuccess: () => setValue(""),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["connectors"] });
    },
  });
  return (
    <form
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) save.mutate();
      }}
    >
      <label className="block text-sm font-medium" htmlFor={`secret-${spec.name}`}>
        {spec.label[0]?.toUpperCase()}
        {spec.label.slice(1)} {spec.stored && <Badge tone="success">Stored</Badge>}
      </label>
      {spec.description && <p className="text-xs text-secondary">{spec.description}</p>}
      <div className="flex gap-2">
        <input
          id={`secret-${spec.name}`}
          type="password"
          autoComplete="off"
          value={value}
          placeholder={spec.stored ? "Paste a new one to replace it" : ""}
          onChange={(e) => setValue(e.target.value)}
          className={inputCls}
        />
        <Button type="submit" disabled={!value || save.isPending}>
          Save
        </Button>
      </div>
      <p className="text-xs text-tertiary">
        Kept in the OS keychain. It is never shown again after saving.
      </p>
      {save.error && (
        <p role="alert" className="text-sm text-danger">
          {save.error.message}
        </p>
      )}
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
    <div className="space-y-3 text-sm">
      <p className="text-secondary">
        Google sign-in is shared by Gmail, Calendar and Drive. It uses your own Google Cloud OAuth
        client (Desktop app), as described in the setup checklist.
      </p>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) client.mutate(f);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant={needsClient ? "primary" : "secondary"}
          onClick={() => file.current?.click()}
        >
          Import client file
        </Button>
        <Button
          variant={!needsClient && connector.status !== "connected" ? "primary" : "secondary"}
          disabled={needsClient || auth.isPending}
          onClick={() => auth.mutate()}
        >
          {connector.status === "connected" ? "Sign in again" : "Sign in with Google"}
        </Button>
      </div>
      {note && <p className="text-xs text-secondary">{note}</p>}
      {(client.error ?? auth.error) && (
        <p role="alert" className="text-sm text-danger">
          {(client.error ?? auth.error)?.message}
        </p>
      )}
    </div>
  );
}

function ConnectorDrawer({
  entry,
  connector,
  onClose,
}: {
  entry: ConnectorCatalogEntry;
  connector: Connector | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useRef<HTMLDialogElement>(null);
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
      confirm.current?.close();
      onClose();
    },
    onSettled: refresh,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !confirm.current?.open && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Icon = ICONS[entry.kind] ?? Plug;
  return (
    <aside
      aria-label={`${entry.displayName} connector`}
      className="flex h-full w-full flex-col border-l border-border-base bg-raised lg:w-[420px]"
    >
      <header className="flex items-start gap-3 border-b border-border-base p-4">
        <Icon size={20} aria-hidden className="mt-1 text-accent-strong" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{entry.displayName}</h2>
          <StatusWord status={connector?.status ?? "available"} />
          <p className="mt-2 flex items-center gap-2 text-xs text-secondary">
            <Badge tone={entry.tier === "supported" ? "success" : "neutral"}>
              {TIER[entry.tier].label}
            </Badge>
            {TIER[entry.tier].help}
          </p>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X size={20} aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
        {connector?.message && (
          <p
            role={
              connector.status === "error" || connector.status === "needs_reconnect"
                ? "alert"
                : "status"
            }
            className="whitespace-pre-wrap rounded-md bg-accent-soft px-3 py-2 text-sm"
          >
            {connector.message}
          </p>
        )}
        <Section title="Access">
          <p className="text-sm text-secondary">{entry.permissions}</p>
        </Section>
        <Section title="Settings">
          <ConfigForm key={connector?.id ?? "new"} entry={entry} connector={connector} />
          {connector && (
            <Toggle
              checked={connector.enabled}
              onChange={(v) => toggle.mutate(v)}
              label="Sync automatically"
              description={`Every ${connector.intervalMin} minutes while Rocky runs.`}
            />
          )}
        </Section>
        {connector && entry.secrets.length > 0 && (
          <Section title="Credentials">
            {entry.secrets.map((s) => (
              <SecretField key={s.name} id={connector.id} spec={s} />
            ))}
          </Section>
        )}
        {connector && entry.oauthGroup && (
          <Section title="Google sign-in">
            <GoogleSignIn entry={entry} connector={connector} />
          </Section>
        )}
        {connector && (
          <Section title="Health">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>
                Test connection
              </Button>
              <Button
                variant="secondary"
                disabled={connector.status === "syncing" || sync.isPending}
                onClick={() => sync.mutate()}
              >
                <RefreshCw size={14} aria-hidden /> Sync now
              </Button>
            </div>
            {test.data && (
              <p
                className={cls(
                  "text-sm",
                  test.data.status === "ok" ? "text-success" : "text-warning",
                )}
              >
                {test.data.message}
              </p>
            )}
            {test.error && <p className="text-sm text-danger">{test.error.message}</p>}
            <p className="text-xs text-tertiary">
              Last sync {relativeTime(connector.lastSyncAt)}
              {connector.nextSyncAt && connector.enabled
                ? ` · next ${new Date(connector.nextSyncAt).toLocaleTimeString()}`
                : ""}
            </p>
          </Section>
        )}
        {connector && (
          <Section title="Sync log">
            {runs.data?.runs.length ? (
              <ol className="space-y-2">
                {runs.data.runs.map((r) => (
                  <li key={r.id} className="rounded-md bg-page px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular font-mono">
                        {new Date(r.startedAt).toLocaleString()}
                      </span>
                      <Badge
                        tone={
                          r.status === "ok" ? "success" : r.status === "error" ? "danger" : "info"
                        }
                      >
                        <FileText size={12} aria-hidden />
                        {r.status === "ok" ? "OK" : r.status === "error" ? "Failed" : "Running"}
                      </Badge>
                      <span className="tabular text-secondary">
                        +{r.added} ~{r.updated} −{r.deleted} · {r.requests} requests
                        {r.full ? " · full" : ""}
                      </span>
                    </div>
                    {r.error && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-danger">
                        <SafeText text={r.error} />
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-secondary">No syncs yet.</p>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-secondary">Cursor</summary>
              <pre className="mt-1 overflow-auto rounded-md bg-sunken p-2 font-mono">
                {JSON.stringify(connector.cursor, null, 2)}
              </pre>
            </details>
          </Section>
        )}
        {connector && (
          <Section title="Disconnect">
            <Button variant="danger" onClick={() => confirm.current?.showModal()}>
              Disconnect {entry.displayName}
            </Button>
          </Section>
        )}
      </div>
      <dialog
        ref={confirm}
        aria-labelledby="disconnect-title"
        className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl bg-overlay p-6 text-primary shadow-raised-lg backdrop:bg-scrim"
      >
        <h2 id="disconnect-title" className="text-lg font-semibold">
          Disconnect {entry.displayName}?
        </h2>
        <p className="mt-2 text-sm text-secondary">
          Rocky stops syncing and removes its stored credentials
          {entry.oauthGroup ? " (unless another Google connector still uses them)" : ""}.
        </p>
        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => setPurge(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--accent-strong)]"
          />
          <span>
            Also delete the {connector?.documentCount ?? 0} item(s) it synced, with their search
            index and anything extracted from them.
          </span>
        </label>
        {remove.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {remove.error.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => confirm.current?.close()}>
            Cancel
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Disconnect
          </Button>
        </div>
      </dialog>
    </aside>
  );
}
