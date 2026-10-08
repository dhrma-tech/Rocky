import type { ActionRecord, RuleConstraint, RuleCreate, RulePreview } from "@rocky/contracts";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { Banner, Button, Switch } from "../ui/index.tsx";

/**
 * "Always allow actions like this" (UI spec 17, roadmap A4, D-010). Never a blanket allow: the
 * user picks at least one condition taken from this action's own payload and an end date, and
 * sees the plain-language sentence and how many past approvals it would have skipped first.
 */

const EMAIL = /@([a-z0-9.-]+\.[a-z]{2,})$/i;

/** Conditions this action's payload could anchor a rule on. */
export function candidateConstraints(payload: unknown): RuleConstraint[] {
  if (!payload || typeof payload !== "object") return [];
  const out: RuleConstraint[] = [];
  for (const [field, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0 && v.length <= 200) {
      const m = v.match(EMAIL);
      out.push(
        m?.[1]
          ? { field, op: "domainIn", value: [m[1].toLowerCase()] }
          : { field, op: "equals", value: v },
      );
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push({ field, op: "equals", value: v });
    } else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) {
      const domains = [...new Set(v.map((x) => (x as string).match(EMAIL)?.[1]?.toLowerCase()))];
      if (domains.every(Boolean)) out.push({ field, op: "domainIn", value: domains as string[] });
      else if (v.length <= 20) out.push({ field, op: "oneOf", value: v as string[] });
    }
  }
  // Free text (titles, bodies) makes a poor rule: keep short identifiers and addresses first.
  return out.filter(
    (c) => c.op !== "equals" || typeof c.value !== "string" || c.value.length <= 80,
  );
}

const DAYS = [1, 7, 30, 90] as const;
const describe = (c: RuleConstraint) =>
  c.op === "domainIn"
    ? `${c.field}: only addresses at ${c.value.join(", ")}`
    : c.op === "oneOf"
      ? `${c.field}: one of ${c.value.join(", ")}`
      : c.op === "lte"
        ? `${c.field}: at most ${c.value}`
        : `${c.field}: ${String(c.value)}`;

export function RuleEditor({ action, onSaved }: { action: ActionRecord; onSaved: () => void }) {
  const candidates = useMemo(() => candidateConstraints(action.payload), [action.payload]);
  const [picked, setPicked] = useState<boolean[]>(() => candidates.map((_, i) => i === 0));
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const [once, setOnce] = useState(false);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const rule: RuleCreate = {
    effect: "allow",
    connectorId: action.connectorId,
    actionType: action.type,
    actionClass: null,
    constraints: candidates.filter((_, i) => picked[i]),
    expiresAt: Date.now() + days * 86_400_000,
    usesLeft: once ? 1 : null,
    fromActionId: action.id,
  };
  const key = JSON.stringify({ c: rule.constraints, days, once });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key captures the rule's content
  useEffect(() => {
    let live = true;
    api.previewRule(rule).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [key]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.createRule(rule);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="rk-h3">Only when</legend>
        {candidates.length === 0 && (
          <p className="rk-muted">
            This action has no field a rule can safely match, so Rocky keeps asking.
          </p>
        )}
        {candidates.map((c, i) => (
          <label
            key={`${c.field}-${c.op}`}
            className="rk-approval__check"
            style={{ display: "flex" }}
          >
            <input
              type="checkbox"
              checked={picked[i] ?? false}
              onChange={(e) => setPicked((p) => p.map((x, j) => (j === i ? e.target.checked : x)))}
            />
            {describe(c)}
          </label>
        ))}
      </fieldset>

      <div className="rk-field">
        <label className="rk-field__label" htmlFor="rule-days">
          Until
        </label>
        <select
          id="rule-days"
          className="rk-input"
          value={days}
          onChange={(e) => setDays(Number(e.target.value) as (typeof DAYS)[number])}
        >
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? "Tomorrow" : `${d} days from now`}
            </option>
          ))}
        </select>
        <span className="rk-field__help">
          Rules end after 90 days at most. Make it again on purpose.
        </span>
      </div>

      <Switch label="Only the next time" checked={once} onChange={setOnce} />

      {preview && (
        <div className="rk-card" style={{ padding: "var(--space-4)" }} aria-live="polite">
          <p style={{ margin: 0 }}>{preview.sentence}</p>
          <p className="rk-small rk-muted" style={{ margin: "var(--space-2) 0 0" }}>
            It would have skipped {preview.wouldHaveSkipped} of your approvals in the last 90 days.
          </p>
        </div>
      )}
      {preview?.problems.map((p) => (
        <Banner key={p} tone="warning" title="Can't save this rule yet.">
          {p}
        </Banner>
      ))}
      {error && (
        <Banner tone="error" title="Couldn't save the rule.">
          {error}
        </Banner>
      )}

      <div>
        <Button
          variant="primary"
          onClick={save}
          loading={saving ? "Saving…" : false}
          disabled={!preview || preview.problems.length > 0}
        >
          Save rule
        </Button>
      </div>
    </div>
  );
}
