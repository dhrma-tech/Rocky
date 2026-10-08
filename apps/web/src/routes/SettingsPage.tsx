import type { ActionClass, ActionRule, RuleCreate } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api, system } from "../api.ts";
import { DeleteEverything } from "../components/DeleteEverything.tsx";
import { BudgetMeter } from "../components/trust.tsx";
import { getTheme, setTheme, type Theme } from "../theme.ts";
import {
  Banner,
  Button,
  Card,
  ErrorState,
  IconButton,
  Input,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Table,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

/**
 * Settings (UI spec 18): risky settings visible and reversible. Safety (permissions and rules)
 * sits second, under General. Settings apply at once with a toast and Undo.
 */

const CATEGORIES = [
  { id: "general", title: "General", words: "data folder import files" },
  { id: "rules", title: "Permissions and rules", words: "allow ask block grant approval safety" },
  { id: "model", title: "Model", words: "ollama local api key budget speed" },
  { id: "memory", title: "Memory", words: "remember profile" },
  { id: "privacy", title: "Privacy and data", words: "local only encryption delete" },
  { id: "appearance", title: "Appearance", words: "theme dark light" },
  { id: "advanced", title: "Advanced", words: "ollama url port" },
  { id: "about", title: "About", words: "version licence" },
] as const;
type Category = (typeof CATEGORIES)[number]["id"];

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [cat, setCat] = useState<Category>("general");
  const [picked, setPicked] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = CATEGORIES.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.words.includes(q),
  );

  if (settings.isLoading)
    return (
      <div className="rk-page">
        <h1 className="rk-title">Settings</h1>
        <Skeleton rows={6} height={52} label="Loading settings" />
      </div>
    );
  if (!settings.data)
    return (
      <div className="rk-page">
        <h1 className="rk-title">Settings</h1>
        <ErrorState
          title="Couldn't read your settings."
          happened={settings.error?.message ?? "No answer from the engine."}
          fix={<Button onClick={() => void settings.refetch()}>Retry</Button>}
        />
      </div>
    );
  const title = CATEGORIES.find((c) => c.id === cat)?.title ?? "";
  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Settings</h1>
      </header>
      <div className="rk-split">
        <nav aria-label="Settings categories" className={picked ? "rk-hide-narrow" : undefined}>
          <Input label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="rk-queue" style={{ marginTop: "var(--space-3)" }}>
            {shown.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="rk-queue__row"
                  aria-current={c.id === cat ? "true" : undefined}
                  onClick={() => {
                    setCat(c.id);
                    setPicked(true);
                  }}
                >
                  <span className="rk-queue__sentence">{c.title}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="rk-muted">No setting matches "{query}".</li>}
          </ul>
        </nav>
        <section aria-label={title} className={picked ? undefined : "rk-hide-narrow"}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginBottom: "var(--space-4)",
            }}
          >
            <span className="rk-show-narrow">
              <IconButton label="Back to settings" onClick={() => setPicked(false)}>
                <ArrowLeft size={20} strokeWidth={1.5} aria-hidden />
              </IconButton>
            </span>
            <h2 className="rk-h2">{title}</h2>
          </div>
          {cat === "general" && <General dataDir={settings.data.dataDir} />}
          {cat === "rules" && <Rules />}
          {cat === "model" && (
            <Model stored={settings.data.secrets} cap={settings.data.budget.monthlyCapUsd} />
          )}
          {cat === "memory" && <MemorySection />}
          {cat === "privacy" && (
            <Privacy localOnly={settings.data.localOnly} dataDir={settings.data.dataDir} />
          )}
          {cat === "appearance" && <Appearance />}
          {cat === "advanced" && <Advanced ollama={settings.data.ollama.baseUrl} />}
          {cat === "about" && <About />}
        </section>
      </div>
    </div>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <Card style={{ marginBottom: "var(--space-3)" }}>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}
      >
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <h3 className="rk-h3">{label}</h3>
          {help && (
            <p className="rk-small rk-muted" style={{ margin: 0 }}>
              {help}
            </p>
          )}
        </div>
        <div>{children}</div>
      </div>
    </Card>
  );
}

function General({ dataDir }: { dataDir: string }) {
  const [path, setPath] = useState("");
  const ingest = useMutation({ mutationFn: api.ingest });
  return (
    <>
      <Row label="Data folder" help="Your store, memory files, backups and logs.">
        <code className="rk-mono" style={{ overflowWrap: "anywhere" }}>
          {dataDir}
        </code>
      </Row>
      <Card>
        <form
          style={{ display: "grid", gap: "var(--space-3)" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) ingest.mutate(path.trim());
          }}
        >
          <Input
            label="Import a file or folder"
            help="PDF, Word, Markdown, HTML, text and transcripts. Embedding runs in the background."
            value={path}
            onChange={(e) => setPath(e.target.value)}
            error={ingest.error?.message ?? null}
          />
          <div>
            <Button
              type="submit"
              disabled={!path.trim()}
              loading={ingest.isPending ? "Importing…" : false}
            >
              Import
            </Button>
          </div>
          {ingest.data && (
            <p role="status" className="rk-small" style={{ margin: 0 }}>
              {ingest.data.results.filter((r) => r.status !== "skipped").length} imported,{" "}
              {ingest.data.results.filter((r) => r.status === "skipped").length} skipped.
            </p>
          )}
        </form>
      </Card>
    </>
  );
}

const CLASSES: { value: ActionClass | "any"; label: string }[] = [
  { value: "any", label: "Any action" },
  { value: "write", label: "Actions that write" },
  { value: "send", label: "Actions that send" },
  { value: "delete", label: "Actions that delete" },
];

function Rules() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules });
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  const [effect, setEffect] = useState<"ask" | "block">("ask");
  const [connector, setConnector] = useState("any");
  const [cls, setCls] = useState<ActionClass | "any">("any");
  const [sentence, setSentence] = useState("");
  const draft: RuleCreate = {
    effect,
    connectorId: connector === "any" ? null : connector,
    actionType: null,
    actionClass: cls === "any" ? null : cls,
    constraints: [],
  };
  const key = JSON.stringify(draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key captures the draft rule
  useEffect(() => {
    void api.previewRule(draft).then((p) => setSentence(p.sentence));
  }, [key]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["rules"] });
  const create = useMutation({
    mutationFn: () => api.createRule(draft),
    onSuccess: () => {
      refresh();
      toast({ text: "Rule saved." });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeRule(id),
    onSuccess: refresh,
  });
  const list = rules.data?.rules ?? [];
  return (
    <>
      <p style={{ marginTop: 0 }}>
        Rocky asks before risky actions. Rules make it ask about more, or block things outright.
        Allow rules are made from a specific approval ("Always allow actions like this"), with a
        condition and an end date; sends, spends and deletes always ask.
      </p>
      {rules.isLoading && <Skeleton rows={3} height={52} label="Loading rules" />}
      {rules.data && list.length === 0 && (
        <Card>
          <p style={{ margin: 0 }}>No custom rules. Rocky asks before risky actions.</p>
        </Card>
      )}
      {list.length > 0 && (
        <Table<ActionRule>
          caption="Your rules"
          rowKey={(r) => r.id}
          rows={list}
          columns={[
            { key: "effect", title: "Effect", render: (r) => r.effect, sort: (r) => r.effect },
            { key: "sentence", title: "What it does", render: (r) => r.sentence },
            {
              key: "state",
              title: "State",
              render: (r) => (r.active ? "Active" : "Ended"),
              sort: (r) => Number(r.active),
            },
            {
              key: "end",
              title: "",
              render: (r) =>
                r.active ? (
                  <Button dense variant="tertiary" onClick={() => revoke.mutate(r.id)}>
                    End rule
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      <Card style={{ marginTop: "var(--space-4)" }}>
        <h3 className="rk-h3">Add a rule</h3>
        <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
          <Segmented
            label="Effect"
            value={effect}
            onChange={setEffect}
            options={[
              { value: "ask", label: "Always ask" },
              { value: "block", label: "Block" },
            ]}
          />
          <Select
            label="In"
            value={connector}
            onChange={setConnector}
            options={[
              { value: "any", label: "Any app" },
              ...(connectors.data?.connectors ?? []).map((c) => ({
                value: c.id,
                label: c.displayName,
              })),
            ]}
          />
          <Select
            label="For"
            value={cls}
            onChange={(v) => setCls(v as ActionClass | "any")}
            options={CLASSES}
          />
          {sentence && (
            <p className="rk-card" style={{ margin: 0 }} aria-live="polite">
              {sentence}
            </p>
          )}
          <div>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              loading={create.isPending ? "Saving…" : false}
            >
              Save rule
            </Button>
          </div>
          {create.error && (
            <Banner tone="error" title="Couldn't save the rule.">
              {create.error.message}
            </Banner>
          )}
        </div>
      </Card>
    </>
  );
}

const SECRETS = [
  { name: "anthropic", label: "Anthropic API key" },
  { name: "google", label: "Google AI API key" },
];

function Model({ stored, cap }: { stored: Record<string, boolean>; cap: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const models = useQuery({ queryKey: ["models"], queryFn: system.models });
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const use = useMutation({
    mutationFn: (m: { small: string; medium: string }) => system.chooseModels(m.small, m.medium),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["models"] });
      toast({ text: "Saved. Restart the daemon to use the new models." });
    },
  });
  const bench = useMutation({
    mutationFn: system.bench,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["models"] }),
  });
  const m = models.data;
  return (
    <>
      {models.isLoading && <Skeleton rows={3} height={52} label="Checking local models" />}
      {m && !m.ollama && (
        <Banner tone="warning" title="Can't reach Ollama.">
          {m.note} Start Ollama, then reopen this page.
        </Banner>
      )}
      {m?.ollama && (
        <Card style={{ marginBottom: "var(--space-3)" }}>
          <h3 className="rk-h3">Local models on this machine</h3>
          <p className="rk-small rk-muted">
            {m.hardware.ramGb} GB RAM, {m.hardware.cuda ? "CUDA GPU" : "no CUDA GPU"}. In use: small{" "}
            {m.current.small ?? "-"}, answers {m.current.medium ?? "-"}.
          </p>
          <ul className="rk-list">
            {m.models.map((x) => (
              <li key={x.name} className="rk-small">
                <strong>{x.name}</strong> ·{" "}
                {x.canAnswer
                  ? `${x.fit === "too-big" ? "too big" : x.fit}: ${x.why}`
                  : "embedding model"}
              </li>
            ))}
          </ul>
          <p className="rk-small">{m.note}</p>
          <p className="rk-small" style={{ margin: 0 }}>
            {m.speed
              ? `Measured ${new Date(m.speed.measuredAt).toLocaleDateString()}: ${m.speed.tokensPerSecond} tokens/s; a cited answer takes about ${m.speed.estimatedAnswerSeconds} s here.`
              : "Speed not measured yet."}
          </p>
          <div className="rk-approval__actions" style={{ marginTop: "var(--space-3)" }}>
            {m.small &&
              m.medium &&
              (m.small !== m.current.small || m.medium !== m.current.medium) && (
                <Button
                  variant="primary"
                  onClick={() =>
                    use.mutate({ small: m.small as string, medium: m.medium as string })
                  }
                >
                  Use the recommended models
                </Button>
              )}
            <Button onClick={() => bench.mutate()} loading={bench.isPending ? "Measuring…" : false}>
              Measure speed
            </Button>
          </div>
          {bench.error && (
            <Banner tone="error" title="Couldn't measure.">
              {bench.error.message}
            </Banner>
          )}
        </Card>
      )}
      <Card style={{ marginBottom: "var(--space-3)" }}>
        <h3 className="rk-h3">Optional: an API key</h3>
        <p className="rk-small rk-muted">
          Local models are the default. A key can speed up hard questions; each call goes through
          the budget cap, and local-only mode blocks it.
        </p>
        {SECRETS.map((s) => (
          <SecretField
            key={s.name}
            name={s.name}
            label={s.label}
            stored={Boolean(stored[s.name])}
          />
        ))}
      </Card>
      <Card>
        <h3 className="rk-h3">Monthly budget</h3>
        {usage.data && <BudgetMeter spent={usage.data.spentUsd} cap={cap} />}
        <BudgetForm cap={cap} />
      </Card>
    </>
  );
}

function SecretField({ name, label, stored }: { name: string; label: string; stored: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.saveSecret(name, value),
    onSuccess: () => {
      setValue("");
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  return (
    <form
      style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save.mutate();
      }}
    >
      <Input
        label={`${label}${stored ? " (stored)" : ""}`}
        type="password"
        autoComplete="off"
        help="Kept in the OS keychain and never shown again."
        value={value}
        error={save.error?.message ?? null}
        onChange={(e) => setValue(e.target.value)}
      />
      <div>
        <Button type="submit" disabled={!value.trim()}>
          {stored ? "Replace key" : "Save key"}
        </Button>
      </div>
    </form>
  );
}

function BudgetForm({ cap }: { cap: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(String(cap));
  const save = useMutation({
    mutationFn: (v: number) => api.saveSettings({ budget: { monthlyCapUsd: v } }),
    onSuccess: (_s, v) => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast({
        text: `Monthly cap set to $${v}.`,
        action: {
          label: "Undo",
          run: () =>
            void api
              .saveSettings({ budget: { monthlyCapUsd: cap } })
              .then(() => qc.invalidateQueries({ queryKey: ["settings"] })),
        },
      });
    },
  });
  return (
    <form
      style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}
      onSubmit={(e) => {
        e.preventDefault();
        const v = Number(value);
        if (Number.isFinite(v) && v >= 0) save.mutate(v);
      }}
    >
      <Input
        label="Cap in USD"
        type="number"
        min={0}
        step="0.5"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        help="At the cap, API calls stop with an explanation. Local models keep working."
      />
      <div>
        <Button type="submit">Save cap</Button>
      </div>
    </form>
  );
}

function MemorySection() {
  return (
    <Row
      label="Memory"
      help="What Rocky remembers lives in Markdown files you can read, edit and export."
    >
      <Link to="/memory" className="rk-button rk-button--secondary">
        Open Memory
      </Link>
    </Row>
  );
}

function Privacy({ localOnly, dataDir }: { localOnly: boolean; dataDir: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const storage = useQuery({ queryKey: ["storage"], queryFn: system.storage });
  const set = useMutation({
    mutationFn: (v: boolean) => api.saveSettings({ localOnly: v }),
    onSuccess: (_s, v) => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast({
        text: v ? "Local-only mode is on." : "Local-only mode is off.",
        action: { label: "Undo", run: () => set.mutate(!v) },
      });
    },
  });
  return (
    <>
      <Row
        label="Local-only mode"
        help="Every model call stays on this machine. API models are blocked, even with a key."
      >
        <Switch
          label={localOnly ? "On" : "Off"}
          checked={localOnly}
          onChange={(v) => set.mutate(v)}
        />
      </Row>
      <Row
        label="Store encryption"
        help={
          storage.data?.encrypted
            ? "Your store is encrypted with SQLCipher; its key is in the OS keychain."
            : `Your store at ${dataDir} is not encrypted. Stop the daemon and run rocky db encrypt (a backup is made first), or use disk encryption.`
        }
      >
        <span className={`rk-chip rk-chip--${storage.data?.encrypted ? "success" : "warning"}`}>
          {storage.data?.encrypted ? "Encrypted" : "Not encrypted"}
        </span>
      </Row>
      <Card>
        <h3 className="rk-h3">Delete everything</h3>
        <DeleteEverything />
      </Card>
    </>
  );
}

function Appearance() {
  const [theme, setT] = useState<Theme>(getTheme());
  return (
    <Row label="Theme" help="Follows the system unless you choose.">
      <Segmented
        label="Theme"
        value={theme}
        onChange={(t) => {
          setTheme(t);
          setT(t);
        }}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
    </Row>
  );
}

function Advanced({ ollama }: { ollama: string }) {
  return (
    <>
      <Row label="Ollama" help="Where local models run. Change it in rocky.yaml (ollama.baseUrl).">
        <code className="rk-mono">{ollama}</code>
      </Row>
      <Row
        label="Engine"
        help="The daemon listens on 127.0.0.1 only. Change the port in rocky.yaml (daemon.port)."
      >
        <code className="rk-mono">{location.host}</code>
      </Row>
    </>
  );
}

function About() {
  return (
    <Row label="Rocky" help="Open source (Apache-2.0). Local first: no account, no telemetry.">
      <a href="https://github.com/dhrma-tech/Rocky" className="rk-button rk-button--secondary">
        Source and issues
      </a>
    </Row>
  );
}
