import type { AgentState } from "@rocky/contracts";
import type { IdentitySwatch } from "@rocky/tokens";
import { Bookmark, CircleCheck, Globe, OctagonX, Wrench } from "lucide-react";
import type { CSSProperties } from "react";
import "./agent-ui.css";
import { type PebbleMode, STATUS } from "./status.ts";

export type PebbleSize = 20 | 24 | 32 | 40 | 64;

const MARKS: Partial<Record<PebbleMode, typeof CircleCheck>> = {
  done: CircleCheck,
  failed: OctagonX,
  learned: Bookmark,
  "breathing-globe": Globe,
  "breathing-tool": Wrench,
};

/** A smooth stone with a gentle asymmetry (UI spec "Avatars"): wider low, a little lean. */
const STONE = "M50 4C73 4 94 18 96 44C98 70 82 95 52 96C22 97 4 80 4 54C4 26 24 4 50 4Z";

export interface PebbleProps {
  /** One status value drives the pebble; omitted means at rest. */
  state?: AgentState | null;
  size?: PebbleSize;
  /** Identity colour: decorates the pebble, never carries state. */
  swatch?: IdentitySwatch;
  /** For a pebble that stands alone; omit when a chip beside it already says the state. */
  label?: string;
}

export function Pebble({ state = null, size = 32, swatch = "periwinkle", label }: PebbleProps) {
  const mode: PebbleMode = state ? STATUS[state].pebble : "rest";
  const Mark = MARKS[mode];
  const style = {
    width: size,
    height: size,
    "--pebble-fill": `var(--rocky-swatch-${swatch})`,
  } as CSSProperties;
  const parts = (
    <>
      <svg className="rk-pebble__stone" viewBox="0 0 100 100" aria-hidden="true">
        <path d={STONE} />
      </svg>
      <span className="rk-pebble__ring" />
      {Mark && size >= 24 && (
        <span className="rk-pebble__mark">
          <Mark strokeWidth={2} aria-hidden />
        </span>
      )}
    </>
  );
  // A pebble beside a chip is decoration; one that stands alone is an image with a name.
  return label ? (
    <span className="rk-pebble" data-mode={mode} style={style} role="img" aria-label={label}>
      {parts}
    </span>
  ) : (
    <span className="rk-pebble" data-mode={mode} style={style} aria-hidden="true">
      {parts}
    </span>
  );
}
