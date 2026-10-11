import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { Pebble } from "../agent-ui/Pebble.tsx";
import {
  api,
  type BoundaryPreset,
  type KeyTestResult,
  type OnboardingView,
  onboarding,
  type PullProgress,
  type Swatch,
  system,
} from "../api.ts";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Drawer,
  Input,
  Progress,
  RadioGroup,
  Skeleton,
} from "../ui/index.tsx";
import "./onboarding.css";

/**
 * Onboarding (UI spec 3, D-048). Four steps, one decision each, saved on Continue so closing
 * the tab resumes at the same step: name and colour, model, boundaries, first task.
 */

const SWATCHES: { value: Swatch; label: string }[] = [
  { value: "periwinkle", label: "Periwinkle" },
  { value: "rose", label: "Rose" },
  { value: "sage", label: "Sage" },
  { value: "butter", label: "Butter" },
  { value: "lilac", label: "Lilac" },
  { value: "peach", label: "Peach" },
];

export function OnboardingPage() {
  const state = useQuery({ queryKey: ["onboarding"], queryFn: onboarding.get });
  if (state.isLoading)
    return (
      <main className="rk-onb">
        <Skeleton rows={4} height={52} label="Loading setup" />
      </main>
    );
  if (!state.data)
    return (
      <main className="rk-onb">
        <Banner tone="error" title="Rocky's engine isn't responding.">
          Start it with <code className="rk-mono">rocky daemon</code>, then reload this page.
        </Banner>
      </main>
    );
  return <Steps initial={state.data} />;
}

function Steps({ initial }: { initial: OnboardingView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<number>(initial.step);
  const [name, setName] = useState(initial.name);
  const [swatch, setSwatch] = useState<Swatch>(initial.swatch);
  const save = useMutation({
    mutationFn: onboarding.save,
    onSuccess: (s) => qc.setQueryData(["onboarding"], s),
  });
  const go = async (next: number, patch: Parameters<typeof onboarding.save>[0] = {}) => {
    await save.mutateAsync({ ...patch, step: next });
    setStep(next);
    window.scrollTo({ top: 0 });
  };
  const finish = async (to: { q?: string }) => {
    await save.mutateAsync({ complete: true });
    if (to.q) void navigate({ to: "/ask", search: { q: to.q } });
    else void navigate({ to: "/" });
  };

  // Each step's heading takes focus so a screen reader hears where it is.
  useEffect(() => {
    document.getElementById(`onb-step-${step}`)?.focus();
  }, [step]);

  return (
    <main className="rk-onb" id="main">
      <div className="rk-onb__top">
        {step > 1 ? (
          <Button
            variant="tertiary"
            icon={<ArrowLeft size={16} aria-hidden />}
            onClick={() => void go(step - 1)}
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        <div style={{ minWidth: 160 }}>
          <Progress label="Setting up" n={step} of={4} />
        </div>
      </div>
      {save.error && (
        <Banner tone="error" title="Couldn't save this step.">
          {save.error.message} Your answers are kept; try again.
        </Banner>
      )}
      {step === 1 && (
        <StepName
          name={name}
          swatch={swatch}
          setName={setName}
          setSwatch={setSwatch}
          saving={save.isPending}
          onContinue={() => void go(2, { name: name.trim() || "Rocky", swatch })}
          onSkip={() => void go(2)}
        />
      )}
      {step === 2 && <StepModel onContinue={() => void go(3)} />}
      {step === 3 && (
        <StepBoundaries
          name={name.trim() || "Rocky"}
          preset={initial.preset}
          saving={save.isPending}
          onContinue={(preset) => void go(4, { preset })}
        />
      )}
      {step === 4 && <StepFirstTask saving={save.isPending} onFinish={(q) => void finish({ q })} />}
    </main>
  );
}

// --- Step 1: name and colour ---

function StepName({
  name,
  swatch,
  setName,
  setSwatch,
  saving,
  onContinue,
  onSkip,
}: {
  name: string;
  swatch: Swatch;
  setName: (s: string) => void;
  setSwatch: (s: Swatch) => void;
  saving: boolean;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const shown = name.trim() || "Rocky";
  return (
    <form
      className="rk-onb__step"
      onSubmit={(e) => {
        e.preventDefault();
        onContinue();
      }}
    >
      <h1 className="rk-title" id="onb-step-1" tabIndex={-1}>
        Name your Rocky
      </h1>
      <div className="rk-onb__preview">
        <Pebble size={64} swatch={swatch} label={`${shown}, in ${swatch}`} />
        <strong>{shown}</strong>
      </div>
      <Input
        label="Name"
        value={name}
        maxLength={40}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
      />
      <fieldset className="rk-swatches">
        <legend>Colour</legend>
        {SWATCHES.map((s) => (
          <label key={s.value} className="rk-swatch" title={s.label}>
            <input
              type="radio"
              name="swatch"
              value={s.value}
              checked={swatch === s.value}
              aria-label={s.label}
              onChange={() => setSwatch(s.value)}
            />
            <span
              className="rk-swatch__dot"
              style={{ "--swatch": `var(--rocky-swatch-${s.value})` } as CSSProperties}
            />
          </label>
        ))}
      </fieldset>
      <p className="rk-onb__consequence rk-small">
        The name and colour show in the sidebar. The colour is only decoration: Rocky's state is
        always shown in words.
      </p>
      <div className="rk-onb__actions">
        <Button variant="tertiary" onClick={onSkip}>
          Skip for now
        </Button>
        <Button variant="primary" type="submit" loading={saving ? "Saving…" : false}>
          Continue
        </Button>
      </div>
    </form>
  );
}

// --- Step 2: model ---

const KEY_HELP: Record<Exclude<KeyTestResult, { ok: true }>["reason"], string> = {
  "no-key": "Paste a key above, then test again.",
  "key-invalid":
    "Check that the key was copied in full, or make a new one in the provider console.",
  "host-unreachable": "Check the internet connection, then test again.",
  "model-missing":
    "Your account may not have access to this model yet. Settings > Models lists what Rocky uses.",
  "local-only": "Turn local-only off in Settings > Privacy to use an online model.",
  budget: "Raise the monthly cap in Settings > Models.",
  other: "Try again in a minute.",
};

function StepModel({ onContinue }: { onContinue: () => void }) {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: system.models });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const m = models.data;
  const hasLocal = Boolean(m?.ollama && m.medium);
  const [choice, setChoice] = useState<"local" | "api" | null>(null);
  const picked = choice ?? (hasLocal ? "local" : "api");
  const [key, setKey] = useState("");
  const keyStored = Boolean(settings.data?.secrets.anthropic);

  const useLocal = useMutation({
    mutationFn: () => system.chooseModels(m?.small as string, m?.medium as string),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["models"] });
      onContinue();
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      if (key.trim()) await api.saveSecret("anthropic", key.trim());
      return onboarding.testKey();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const result = test.data;
  const needsSwitch =
    hasLocal && m && (m.small !== m.current.small || m.medium !== m.current.medium);

  const next = () => {
    if (picked === "local" && needsSwitch) useLocal.mutate();
    else onContinue();
  };
  const ready = picked === "local" ? hasLocal : result?.ok === true;

  return (
    <div className="rk-onb__step">
      <h1 className="rk-title" id="onb-step-2" tabIndex={-1}>
        Choose a model
      </h1>
      {models.isLoading && <Skeleton rows={2} height={52} label="Looking for local models" />}
      {m && (
        <RadioGroup
          legend="Rocky answers with"
          value={picked}
          onChange={setChoice}
          options={
            hasLocal
              ? [
                  {
                    value: "local",
                    label: `A model on this computer: ${m.medium}`,
                    help: m.speed
                      ? `Nothing leaves this computer. A cited answer takes about ${m.speed.estimatedAnswerSeconds} s here.`
                      : "Nothing leaves this computer. Answers can take a minute or two without a GPU.",
                  },
                  {
                    value: "api",
                    label: "An online model with your API key",
                    help: "Faster on hard questions. Each call goes through the monthly budget cap.",
                  },
                ]
              : [
                  {
                    value: "api",
                    label: "An online model with your API key",
                    help: "Each call goes through the monthly budget cap.",
                  },
                ]
          }
        />
      )}
      {m && !hasLocal && <NoLocalModel ollama={m.ollama} starter={m.starter} />}
      {picked === "api" && (
        <Card>
          <form
            style={{ display: "grid", gap: "var(--space-3)" }}
            onSubmit={(e) => {
              e.preventDefault();
              test.mutate();
            }}
          >
            <Input
              label={`Anthropic API key${keyStored ? " (saved)" : ""}`}
              type="password"
              autoComplete="off"
              value={key}
              help="Kept in the OS keychain and never shown again."
              onChange={(e) => setKey(e.target.value)}
            />
            <div>
              <Button
                type="submit"
                disabled={!key.trim() && !keyStored}
                loading={test.isPending ? "Testing…" : false}
              >
                Test connection
              </Button>
            </div>
            <div aria-live="polite">
              {test.isPending && <p className="rk-small rk-muted">Sending one tiny request…</p>}
              {result?.ok && (
                <Banner tone="success" title="Connected.">
                  {result.model} answered in {(result.ms / 1000).toFixed(1)} s.
                </Banner>
              )}
              {result && !result.ok && (
                <Banner tone="error" title={result.message}>
                  {KEY_HELP[result.reason]}
                </Banner>
              )}
              {test.error && (
                <Banner tone="error" title="Couldn't test the key.">
                  {test.error.message}
                </Banner>
              )}
            </div>
          </form>
        </Card>
      )}
      <p className="rk-onb__consequence rk-small">
        {picked === "local"
          ? "Your questions and files stay on this computer."
          : "The passages Rocky cites are sent to the provider with your question. Local-only mode blocks this."}
      </p>
      {useLocal.error && (
        <Banner tone="error" title="Couldn't switch models.">
          {useLocal.error.message}
        </Banner>
      )}
      <div className="rk-onb__actions">
        {!ready && m && (
          <Button variant="tertiary" onClick={onContinue}>
            Continue without a model
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!ready}
          loading={useLocal.isPending ? "Saving…" : false}
          onClick={next}
        >
          Continue
        </Button>
      </div>
      {!ready && m && (
        <p className="rk-small rk-muted" style={{ margin: 0 }}>
          Without a model you can still look through the sample workspace; answers start once a
          model is set in Settings &gt; Models.
        </p>
      )}
    </div>
  );
}

/** No answer model yet: download the one sized for this machine, or say how to get Ollama. */
function NoLocalModel({
  ollama,
  starter,
}: {
  ollama: boolean;
  starter: { pull: string; use: string } | null;
}) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const pull = useMutation({
    mutationFn: () => system.pullStarter(setProgress),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["models"] }),
  });
  if (!ollama)
    return (
      <Banner tone="info" title="Ollama isn't running on this computer.">
        Rocky runs local models through Ollama. Install it from{" "}
        <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
          ollama.com/download
        </a>
        , start it, then come back to this step. Or use an API key below.
      </Banner>
    );
  const pct =
    progress?.total && progress.completed !== undefined
      ? Math.round((progress.completed / progress.total) * 100)
      : null;
  return (
    <Card>
      <h2 className="rk-h3">No local model yet</h2>
      {starter ? (
        <>
          <p className="rk-small">
            For this computer's memory Rocky suggests <strong>{starter.pull}</strong>. Ollama
            downloads it once (a few GB); after that nothing leaves this computer.
          </p>
          <div aria-live="polite">
            {pull.isPending && (
              <Progress
                label={`${progress?.model ?? starter.pull}: ${progress?.status ?? "starting"}${pct === null ? "" : ` (${pct}%)`}`}
                n={pct ?? 0}
                of={pct === null ? undefined : 100}
              />
            )}
            {pull.isSuccess && (
              <Banner tone="success" title="Downloaded.">
                Rocky now answers with {pull.data.model}.
              </Banner>
            )}
            {pull.error && (
              <Banner tone="error" title="The download stopped.">
                {pull.error.message} Try again: Ollama resumes where it left off.
              </Banner>
            )}
          </div>
          {!pull.isSuccess && (
            <div>
              <Button
                onClick={() => pull.mutate()}
                loading={pull.isPending ? "Downloading…" : false}
              >
                Download {starter.pull}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="rk-small">No starter model is set for this computer in policies.yaml.</p>
      )}
    </Card>
  );
}

// --- Step 3: boundaries ---

function StepBoundaries({
  name,
  preset: initialPreset,
  saving,
  onContinue,
}: {
  name: string;
  preset: BoundaryPreset;
  saving: boolean;
  onContinue: (preset: BoundaryPreset) => void;
}) {
  const [preset, setPreset] = useState<BoundaryPreset>(initialPreset);
  const [useFolder, setUseFolder] = useState(false);
  const [folder, setFolder] = useState("");
  const [explain, setExplain] = useState(false);
  const watch = useMutation({ mutationFn: (p: string) => onboarding.watchFolder(p) });

  const where = useFolder && folder.trim() ? `files in ${folder.trim()}` : "only what you import";
  const sentence =
    preset === "read-only"
      ? `${name} can read ${where} and won't change anything in your apps.`
      : `${name} can read ${where} and asks before changing anything.`;

  const next = async () => {
    if (useFolder && folder.trim()) {
      try {
        await watch.mutateAsync(folder.trim());
      } catch {
        return; // the error shows under the field; nothing else is saved yet
      }
    }
    onContinue(preset);
  };

  return (
    <div className="rk-onb__step">
      <h1 className="rk-title" id="onb-step-3" tabIndex={-1}>
        Choose what {name} may touch
      </h1>
      <fieldset className="rk-fieldset">
        <legend>Access (all off until you turn it on)</legend>
        <Checkbox
          label="Read a folder on this computer"
          checked={useFolder}
          onChange={setUseFolder}
        />
        {useFolder && (
          <Input
            label="Folder path"
            placeholder="C:\\Users\\you\\notes"
            value={folder}
            autoComplete="off"
            help="Rocky reads Markdown, text, PDF and documents in it and keeps watching for changes."
            error={watch.error?.message ?? null}
            onChange={(e) => setFolder(e.target.value)}
          />
        )}
        <Checkbox
          label="Use a browser (not available yet)"
          checked={false}
          onChange={() => {}}
          disabled
        />
        <Checkbox
          label="Run commands (not available in Rocky)"
          checked={false}
          onChange={() => {}}
          disabled
        />
      </fieldset>
      <RadioGroup
        legend="Before changing anything"
        value={preset}
        onChange={setPreset}
        options={[
          {
            value: "ask-everything",
            label: "Ask about everything",
            help: "Every draft, event or task waits for your approval. You can allow narrow cases later from an approval card.",
          },
          {
            value: "read-only",
            label: "Read only",
            help: "Rocky reads and answers but proposes nothing. It's a rule you can remove in Settings > Rules.",
          },
        ]}
      />
      <p className="rk-onb__live" aria-live="polite">
        {sentence}
      </p>
      <p className="rk-onb__consequence rk-small">
        Email is never sent in any mode: Rocky only writes drafts. Sending, spending and deleting
        always ask.
      </p>
      <div className="rk-onb__actions">
        <Button variant="tertiary" onClick={() => setExplain(true)}>
          What does this allow?
        </Button>
        <Button
          variant="primary"
          loading={watch.isPending || saving ? "Saving…" : false}
          disabled={useFolder && !folder.trim()}
          onClick={() => void next()}
        >
          Continue
        </Button>
      </div>
      <Drawer open={explain} onClose={() => setExplain(false)} title="What this allows">
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <p>
            <strong>Reading.</strong> Rocky reads the folder you pick and the apps you connect
            later. What it reads is treated as untrusted text: it can be quoted, never obeyed.
          </p>
          <p>
            <strong>Changing.</strong> Anything that changes an app (a draft, a calendar event, a
            task) is a proposal you approve. Each approval is tied to the exact content, and every
            step is written to a tamper-evident ledger.
          </p>
          <p>
            <strong>Never.</strong> Rocky never sends email, never spends money and never deletes
            without asking, whatever you choose here.
          </p>
          <p>
            <strong>Browser and commands.</strong> Rocky can't browse or run commands today, so
            these stay off.
          </p>
        </div>
      </Drawer>
    </div>
  );
}

// --- Step 4: first task ---

interface Starter {
  id: string;
  title: string;
  why: string;
  question: string;
  sample: boolean;
}

function StepFirstTask({
  saving,
  onFinish,
}: {
  saving: boolean;
  onFinish: (question?: string) => void;
}) {
  const sample = useQuery({ queryKey: ["sample"], queryFn: onboarding.sample });
  const mine = useQuery({ queryKey: ["suggestions"], queryFn: onboarding.suggestions });
  const load = useMutation({ mutationFn: onboarding.loadSample });
  const [chosen, setChosen] = useState<string | null>(null);

  // Questions from your own data first; the sample tour fills the rest. Every starter only reads.
  const starters: Starter[] = [
    ...(mine.data?.questions ?? []).map((q, i) => ({
      id: `mine-${i}`,
      title: q,
      why: "From your own files.",
      question: q,
      sample: false,
    })),
    ...(sample.data?.tour ?? []).map((t, i) => ({
      id: `sample-${i}`,
      title: t.question,
      why: `Sample workspace. A good answer: ${t.expect}`,
      question: t.question,
      sample: true,
    })),
  ].slice(0, 3);
  const pick = starters.find((s) => s.id === chosen) ?? starters[0];

  const start = async () => {
    if (!pick) return onFinish();
    if (pick.sample && !sample.data?.loaded) await load.mutateAsync();
    onFinish(pick.question);
  };

  const loading = sample.isLoading || mine.isLoading;
  return (
    <div className="rk-onb__step">
      <h1 className="rk-title" id="onb-step-4" tabIndex={-1}>
        Start a first task
      </h1>
      <p className="rk-onb__consequence">
        Each one only reads and cites its sources, so it works within any boundary you chose.
      </p>
      {loading && <Skeleton rows={3} height={72} label="Loading starter tasks" />}
      {!loading && starters.length > 0 && (
        <fieldset className="rk-fieldset">
          <legend className="sr-only">Starter tasks</legend>
          <ul className="rk-starters">
            {starters.map((s) => (
              <li key={s.id}>
                <label className="rk-starter">
                  <input
                    type="radio"
                    name="starter"
                    checked={pick?.id === s.id}
                    onChange={() => setChosen(s.id)}
                  />
                  <span>
                    <strong>{s.title}</strong>
                    <span className="rk-small rk-muted" style={{ display: "block" }}>
                      {s.why}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {(sample.error || load.error) && (
        <Banner tone="error" title="Couldn't load the sample workspace.">
          {(load.error ?? sample.error)?.message}
        </Banner>
      )}
      <div className="rk-onb__actions">
        <Button variant="tertiary" onClick={() => onFinish()}>
          Skip for now
        </Button>
        <Button
          variant="primary"
          disabled={!pick}
          loading={load.isPending ? "Loading the sample…" : saving ? "Opening…" : false}
          onClick={() => void start()}
        >
          Start first task
        </Button>
      </div>
    </div>
  );
}
