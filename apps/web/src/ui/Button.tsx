import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** 36px tall for table rows; keeps a 44px hit area. */
  dense?: boolean;
  /** Shows this label and disables the button while an action runs ("Opening…"). */
  loading?: string | false;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** UI spec "Button": primary, secondary, tertiary, danger. One primary per view. */
export function Button({
  variant = "secondary",
  dense,
  loading,
  icon,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cls("rk-button", `rk-button--${variant}`, dense && "rk-button--dense", className)}
      disabled={disabled || Boolean(loading)}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {icon}
      {loading || children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  /** The accessible name and the tooltip text. Required: an icon alone names nothing. */
  label: string;
  children: ReactNode;
  /** Where the tooltip sits: above (default), below, or to the right (the sidebar rail). */
  tipSide?: "top" | "bottom" | "right";
}

/** Icon-only button: always named, always with a tooltip on hover and keyboard focus. */
export function IconButton({
  label,
  children,
  variant = "tertiary",
  tipSide = "top",
  ...rest
}: IconButtonProps) {
  return (
    <span className={`rk-tip rk-tip--${tipSide}`}>
      <Button variant={variant} aria-label={label} className="rk-button--icon" {...rest}>
        {children}
      </Button>
      <span className="rk-tip__text" aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

/**
 * Press and hold to confirm (UI spec 23: high-risk approvals on phones). Holding for `holdMs`
 * runs `onHold`; the fill shows how far along the press is, and letting go early cancels. A
 * quick tap, a mouse click, a keyboard press or a screen reader's activate runs `onPress`
 * instead (the two-step confirm), so the hold is never the only way.
 */
export function HoldButton({
  children,
  holdMs = 1200,
  onHold,
  onPress,
  disabled,
}: {
  children: ReactNode;
  holdMs?: number;
  onHold: () => void;
  onPress: () => void;
  disabled?: boolean;
}) {
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);
  const done = useRef(false);
  const cancel = () => {
    cancelAnimationFrame(frame.current);
    setProgress(0);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const start = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || e.pointerType === "mouse") return;
    done.current = false;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / holdMs);
      setProgress(p);
      if (p < 1) frame.current = requestAnimationFrame(step);
      else {
        done.current = true;
        setProgress(0);
        onHold();
      }
    };
    frame.current = requestAnimationFrame(step);
  };
  return (
    <button
      type="button"
      className="rk-button rk-button--primary rk-hold"
      style={{ "--hold": progress } as CSSProperties}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        // The click that ends a completed hold must not also open the confirm step.
        if (done.current) {
          done.current = false;
          return;
        }
        onPress();
      }}
    >
      {children}
    </button>
  );
}
