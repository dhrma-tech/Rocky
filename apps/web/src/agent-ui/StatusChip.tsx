import type { AgentState } from "@rocky/contracts";
import "./agent-ui.css";
import { STATUS, statusLabel, type Tone } from "./status.ts";

export interface StatusChipProps {
  state: AgentState;
  detail?: Parameters<typeof statusLabel>[1];
}

/** The status chip (UI spec "Status indicator"): icon, word and tint from one status value. */
export function StatusChip({ state, detail }: StatusChipProps) {
  const v = STATUS[state];
  const Icon = v.icon;
  return (
    <span className={`rk-chip rk-chip--${v.needsUser ? "needs-you" : v.tone}`}>
      <Icon size={14} strokeWidth={2} aria-hidden />
      {statusLabel(state, detail)}
    </span>
  );
}

/** A chip for things that are not agent states (a risk, a tier, a count), same look and rules. */
export function Chip({
  tone = "neutral",
  icon: Icon,
  children,
}: {
  tone?: Tone | "needs-you";
  icon?: typeof STATUS.thinking.icon;
  children: React.ReactNode;
}) {
  return (
    <span className={`rk-chip rk-chip--${tone}`}>
      {Icon && <Icon size={14} strokeWidth={2} aria-hidden />}
      {children}
    </span>
  );
}
