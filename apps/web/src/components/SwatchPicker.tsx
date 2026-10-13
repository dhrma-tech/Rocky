import type { CSSProperties } from "react";
import type { Swatch } from "../api.ts";
import "../routes/onboarding.css";

export const SWATCHES: { value: Swatch; label: string }[] = [
  { value: "periwinkle", label: "Periwinkle" },
  { value: "rose", label: "Rose" },
  { value: "sage", label: "Sage" },
  { value: "butter", label: "Butter" },
  { value: "lilac", label: "Lilac" },
  { value: "peach", label: "Peach" },
];

/** Rocky's identity colour (UI spec "agent identity swatches"): decoration only, never state. */
export function SwatchPicker({
  value,
  onChange,
}: {
  value: Swatch;
  onChange: (s: Swatch) => void;
}) {
  return (
    <fieldset className="rk-swatches">
      <legend>Colour</legend>
      {SWATCHES.map((s) => (
        <label key={s.value} className="rk-swatch" title={s.label}>
          <input
            type="radio"
            name="swatch"
            value={s.value}
            checked={value === s.value}
            aria-label={s.label}
            onChange={() => onChange(s.value)}
          />
          <span
            className="rk-swatch__dot"
            style={{ "--swatch": `var(--rocky-swatch-${s.value})` } as CSSProperties}
          />
        </label>
      ))}
    </fieldset>
  );
}
