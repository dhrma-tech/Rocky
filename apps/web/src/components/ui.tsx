import type { ButtonHTMLAttributes, ReactNode } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";

/** DESIGN.md §6: one primary (Pastel Red, Ink label) per view; secondary is raised; ghost is flat. */
export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold",
        "transition-[background-color,box-shadow,transform] duration-[180ms] ease-ui",
        "disabled:cursor-not-allowed",
        variant === "primary" &&
          "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed active:shadow-inset-sm disabled:bg-layer-subtle disabled:text-tertiary",
        variant === "secondary" &&
          "bg-raised text-primary shadow-raised-sm hover:-translate-y-px active:translate-y-0 active:shadow-inset-sm disabled:opacity-50",
        variant === "ghost" &&
          "text-primary hover:bg-layer-subtle active:bg-layer-strong disabled:opacity-50",
        variant === "danger" &&
          "border border-danger text-danger hover:bg-layer-subtle active:bg-layer-strong disabled:opacity-50",
        className,
      )}
    />
  );
}

/** 32 px visual, 44 px hit area, always labeled (§5.3). */
export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "relative inline-flex size-11 items-center justify-center rounded-md text-primary",
        "transition-colors duration-[180ms] ease-ui hover:bg-layer-subtle active:bg-layer-strong disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

/** Status is never color alone: callers pass an icon and a word (§2.3, §8.2). */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
        tone === "neutral" && "bg-layer-subtle text-secondary",
        tone === "accent" && "bg-accent-soft text-primary",
        tone === "success" && "bg-layer-subtle text-success",
        tone === "warning" && "bg-layer-subtle text-warning",
        tone === "danger" && "bg-layer-subtle text-danger",
        tone === "info" && "bg-layer-subtle text-info",
      )}
    >
      {children}
    </span>
  );
}

/** Switch with a required visible label (§6 Toggle). */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium text-primary">{label}</span>
        {description && <span className="block text-sm text-secondary">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors duration-[180ms] ease-ui disabled:opacity-50",
          checked ? "bg-accent" : "bg-sunken",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 size-5 rounded-full bg-raised shadow-raised-sm transition-transform duration-[240ms] ease-out",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}

export const cls = cx;
