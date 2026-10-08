import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** 36px tall for table rows; keeps a 44px hit area. */
  dense?: boolean;
  /** Shows this label and disables the button while an action runs ("Opening…"). */
  loading?: string | false;
  icon?: ReactNode;
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
