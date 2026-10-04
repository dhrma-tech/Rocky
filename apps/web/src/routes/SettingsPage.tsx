import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, KeyRound } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../api.ts";
import { BudgetMeter } from "../components/trust.tsx";
import { Badge, Button, Toggle } from "../components/ui.tsx";
import { getTheme, setTheme, type Theme } from "../theme.ts";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg bg-raised p-6 shadow-raised-sm">
      <h2 id={id} className="mb-4 text-base font-semibold text-primary">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

const field =
  "min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm text-primary outline-none";

const PROVIDERS = [
  { name: "anthropic", label: "Anthropic API key" },
  { name: "google", label: "Google AI API key" },
];

function SecretField({ name, label, stored }: { name: string; label: string; stored: boolean }) {
  const [value, setValue] = useState("");
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.saveSecret(name, value),
    onSuccess: () => {
      setValue("");
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (value.trim()) save.mutate();
      }}
    >
      <label htmlFor={`secret-${name}`} className="flex items-center gap-2 text-sm font-medium">
        <KeyRound size={16} aria-hidden className="text-accent-strong" />
        {label}
        {stored && (
          <Badge tone="success">
            <CircleCheck size={12} aria-hidden /> Stored
          </Badge>
        )}
      </label>
      <div className="flex gap-2">
        <input
          id={`secret-${name}`}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={stored ? "Replace the stored key" : "Paste a key"}
          className={field}
        />
        <Button type="submit" disabled={!value.trim() || save.isPending}>
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

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const hardware = useQuery({ queryKey: ["hardware"], queryFn: api.hardware });
  const [cap, setCap] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");
  const [theme, setThemeState] = useState<Theme>(getTheme());

  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["usage"] });
      setCap(null);
    },
  });
  const ingest = useMutation({ mutationFn: api.ingest });

  const s = settings.data;
  return (
    <div className="h-full overflow-y-auto px-4">
      <div className="mx-auto max-w-[720px] space-y-6 py-8">
        <h1 className="text-2xl font-normal leading-8">Settings</h1>
        {settings.error && (
          <p role="alert" className="text-sm text-danger">
            {settings.error.message}
          </p>
        )}

        {s && (
          <>
            <Section id="privacy" title="Privacy">
              <Toggle
                label="Local-only mode"
                description="Every model call stays on this machine. API models are blocked."
                checked={s.localOnly}
                disabled={save.isPending}
                onChange={(v) => save.mutate({ localOnly: v })}
              />
              <p className="text-sm text-secondary">
                Data folder: <span className="font-mono text-xs">{s.dataDir}</span>
              </p>
            </Section>

            <Section id="models" title="Models">
              {PROVIDERS.map((p) => (
                <SecretField key={p.name} {...p} stored={Boolean(s.secrets[p.name])} />
              ))}
              <p className="text-sm text-secondary">
                Ollama at <span className="font-mono text-xs">{s.ollama.baseUrl}</span>. Per-task
                models are set in <span className="font-mono text-xs">config/policies.yaml</span>.
              </p>
              {hardware.data && (
                <p className="text-sm text-secondary">
                  This machine: {hardware.data.ramGb} GB RAM, {hardware.data.cores} threads,{" "}
                  {hardware.data.cuda ? "CUDA GPU" : "no CUDA GPU"}.
                </p>
              )}
            </Section>

            <Section id="budget" title="Budget">
              {usage.data && (
                <BudgetMeter spent={usage.data.spentUsd} cap={s.budget.monthlyCapUsd} />
              )}
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = Number(cap);
                  if (Number.isFinite(v) && v >= 0) save.mutate({ budget: { monthlyCapUsd: v } });
                }}
              >
                <div className="flex-1 space-y-1.5">
                  <label htmlFor="cap" className="text-sm font-medium">
                    Monthly cap (USD)
                  </label>
                  <input
                    id="cap"
                    type="number"
                    min={0}
                    step="0.5"
                    inputMode="decimal"
                    className={`${field} tabular`}
                    value={cap ?? String(s.budget.monthlyCapUsd)}
                    onChange={(e) => setCap(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={cap === null || save.isPending}>
                  Save cap
                </Button>
              </form>
              <p className="text-xs text-tertiary">
                At the cap, API calls are blocked with an explanation. Local models keep working.
              </p>
              {usage.data && usage.data.rows.length > 0 && (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Model usage this month</caption>
                  <thead className="text-xs text-tertiary">
                    <tr>
                      <th className="py-1 font-medium">Task</th>
                      <th className="py-1 font-medium">Model</th>
                      <th className="py-1 text-right font-medium">Calls</th>
                      <th className="py-1 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {usage.data.rows.map((r) => (
                      <tr key={`${r.task}-${r.model}`} className="border-t border-border-base">
                        <td className="py-1.5">{r.task}</td>
                        <td className="py-1.5 font-mono text-xs">
                          {r.model} {r.local ? "(local)" : ""}
                        </td>
                        <td className="py-1.5 text-right">{r.calls}</td>
                        <td className="py-1.5 text-right">${r.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section id="import" title="Import files">
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (importPath.trim()) ingest.mutate(importPath.trim());
                }}
              >
                <div className="flex-1 space-y-1.5">
                  <label htmlFor="import" className="text-sm font-medium">
                    File or folder path
                  </label>
                  <input
                    id="import"
                    className={`${field} font-mono`}
                    placeholder="E:\Notes\ECON101"
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!importPath.trim() || ingest.isPending}
                >
                  {ingest.isPending ? "Importing…" : "Import"}
                </Button>
              </form>
              <p className="text-xs text-tertiary">
                PDF, Word, Markdown, HTML, text and transcripts.
              </p>
              {ingest.data && (
                <p role="status" className="text-sm text-secondary">
                  {ingest.data.results.filter((r) => r.status !== "skipped").length} imported,{" "}
                  {ingest.data.results.filter((r) => r.status === "skipped").length} skipped.
                  Embedding runs in the background.
                </p>
              )}
              {ingest.error && (
                <p role="alert" className="text-sm text-danger">
                  {ingest.error.message}
                </p>
              )}
            </Section>

            <Section id="appearance" title="Appearance">
              <fieldset className="flex gap-2">
                <legend className="mb-2 text-sm font-medium">Theme</legend>
                {(["system", "light", "dark"] as const).map((t) => (
                  <Button
                    key={t}
                    variant={theme === t ? "secondary" : "ghost"}
                    aria-pressed={theme === t}
                    onClick={() => {
                      setTheme(t);
                      setThemeState(t);
                    }}
                  >
                    {t[0]?.toUpperCase()}
                    {t.slice(1)}
                  </Button>
                ))}
              </fieldset>
            </Section>
          </>
        )}
        {save.error && (
          <p role="alert" className="text-sm text-danger">
            {save.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
