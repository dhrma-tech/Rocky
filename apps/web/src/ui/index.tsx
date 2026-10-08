import {
  CircleAlert,
  CircleCheck,
  Info,
  type LucideIcon,
  OctagonX,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createContext,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "./Button.tsx";
import "./ui.css";

export { Button, IconButton } from "./Button.tsx";

const cls = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");

// --- Card ---

export function Card({
  tint,
  as: Tag = "section",
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { tint?: boolean; as?: "section" | "article" | "div" | "li" }) {
  return <Tag className={cls("rk-card", tint && "rk-card--tint", className)} {...rest} />;
}

// --- Banner ---

export type BannerTone = "info" | "success" | "warning" | "error";
const BANNER_ICONS: Record<BannerTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: OctagonX,
};

/** A state of the page or system. Dismissible only when informational. */
export function Banner({
  tone,
  title,
  children,
  actions,
  onDismiss,
}: {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = BANNER_ICONS[tone];
  return (
    <div className={`rk-banner rk-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={20} strokeWidth={1.5} aria-hidden />
      <div className="rk-banner__body">
        <p className="rk-banner__title" style={{ margin: 0 }}>
          {title}
        </p>
        {children && <div>{children}</div>}
        {actions && <div className="rk-banner__actions">{actions}</div>}
      </div>
      {tone === "info" && onDismiss && (
        <IconButton label="Dismiss" dense onClick={onDismiss}>
          <X size={16} strokeWidth={1.5} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

// --- Empty and error states (UI spec 21, 22) ---

/** One serif headline (six words at most), one sentence, one action. Never art without action. */
export function EmptyState({
  headline,
  children,
  action,
}: {
  headline: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rk-state">
      <h2 className="rk-display">{headline}</h2>
      <p style={{ margin: 0 }} className="rk-muted">
        {children}
      </p>
      {action}
    </div>
  );
}

/**
 * The one error pattern: icon, a plain title, what happened, what Rocky already did, one fix,
 * and Details with the log excerpt and code. Never leads with a code; never blames the user.
 */
export function ErrorState({
  title,
  happened,
  rockyDid,
  fix,
  details,
}: {
  title: string;
  happened: string;
  rockyDid?: string;
  fix?: ReactNode;
  details?: { code?: string; log?: string };
}) {
  return (
    <div className="rk-state" role="alert">
      <CircleAlert
        size={24}
        strokeWidth={1.5}
        aria-hidden
        style={{ color: "var(--color-error-text)" }}
      />
      <h2 className="rk-h2">{title}</h2>
      <p style={{ margin: 0 }}>{happened}</p>
      {rockyDid && (
        <p style={{ margin: 0 }} className="rk-muted">
          {rockyDid}
        </p>
      )}
      {fix}
      {details && (details.code || details.log) && (
        <details className="rk-state__details">
          <summary>Details</summary>
          <pre className="rk-mono">
            {[details.code && `Code: ${details.code}`, details.log].filter(Boolean).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

// --- Skeleton ---

/** Rows at the real row height so nothing jumps when content arrives. */
export function Skeleton({
  rows = 3,
  height = 52,
  gap = 8,
  label = "Loading",
}: {
  rows?: number;
  height?: number;
  gap?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} style={{ display: "grid", gap }}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <span key={i} className="rk-skeleton" style={{ height }} aria-hidden="true" />
      ))}
    </div>
  );
}

// --- Fields ---

interface FieldBits {
  label: string;
  help?: string;
  error?: string | null;
}

function FieldFrame({
  id,
  label,
  help,
  error,
  children,
}: FieldBits & { id: string; children: ReactNode }) {
  return (
    <div className="rk-field">
      <label className="rk-field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help && !error && (
        <span className="rk-field__help" id={`${id}-help`}>
          {help}
        </span>
      )}
      {error && (
        <span className="rk-field__error" id={`${id}-error`}>
          <CircleAlert size={16} strokeWidth={1.5} aria-hidden />
          {error}
        </span>
      )}
    </div>
  );
}

const describedBy = (id: string, b: FieldBits) =>
  b.error ? `${id}-error` : b.help ? `${id}-help` : undefined;

/** A short single-line value. The label is always visible; never placeholder-only. */
export function Input({
  label,
  help,
  error,
  id: given,
  ...rest
}: FieldBits & Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { id?: string }) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <FieldFrame id={id} label={label} help={help} error={error}>
      <input
        id={id}
        className="rk-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { label, help, error })}
        {...rest}
      />
    </FieldFrame>
  );
}

/** Goals, notes, rules in plain text: 3 rows, grows to 10. */
export function Textarea({
  label,
  help,
  error,
  id: given,
  ...rest
}: FieldBits & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & { id?: string }) {
  const auto = useId();
  const id = given ?? auto;
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, line * 10 + 16)}px`;
  };
  return (
    <FieldFrame id={id} label={label} help={help} error={error}>
      <textarea
        ref={ref}
        id={id}
        rows={3}
        className="rk-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { label, help, error })}
        onInput={grow}
        {...rest}
      />
    </FieldFrame>
  );
}

// --- Switch ---

/** A setting that applies immediately. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="rk-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="rk-switch__track" aria-hidden="true">
        <span className="rk-switch__thumb" />
      </span>
      {label}
    </button>
  );
}

// --- Tabs ---

/** Views of the same object. Arrow keys move; every panel stays mounted (keeps its state). */
export function Tabs({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: { id: string; title: ReactNode; panel: ReactNode }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next];
    if (t) onChange(t.id);
    refs.current[next]?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="rk-tabs__list">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === value}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={t.id === value ? 0 : -1}
            className="rk-tab"
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.title}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== value}
          style={{ paddingTop: "var(--space-4)" }}
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}

// --- Drawer ---

/**
 * Create or edit without losing context; a full-screen sheet on phones. Native <dialog>:
 * focus is trapped, Escape closes, focus returns to the opener.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="rk-drawer" aria-labelledby={titleId} onClose={onClose}>
      <div className="rk-drawer__head">
        <h2 id={titleId} className="rk-h3" style={{ flex: 1 }}>
          {title}
        </h2>
        <IconButton label="Close" tipSide="bottom" onClick={onClose}>
          <X size={20} strokeWidth={1.5} aria-hidden />
        </IconButton>
      </div>
      <div className="rk-drawer__body">{children}</div>
    </dialog>
  );
}

// --- Toast ---

interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const ToastCtx = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});

/** Small completed actions, with Undo when reversible: 4 s, or 8 s with an action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const show = useCallback((t: Omit<ToastItem, "id">) => {
    const id = next.current++;
    setItems((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.action ? 8000 : 4000);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="rk-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="rk-toast">
            <span className="rk-toast__text">{t.text}</span>
            {t.action && (
              <Button
                variant="tertiary"
                dense
                onClick={() => {
                  t.action?.run();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// --- Page shortcuts ---

/**
 * Single-key shortcuts for a page (J/K and friends). Ignored while typing in a field or with a
 * modifier held, so they never fight the browser or a form.
 */
export function useKeys(handler: (key: string, e: globalThis.KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      ref.current(e.key, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
