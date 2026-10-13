import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, Input, Modal } from "../ui/index.tsx";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const SHORTCUTS: { keys: string; what: string; where: string }[] = [
  { keys: `${MOD}K`, what: "Open the command palette", where: "Anywhere" },
  { keys: `${MOD}B`, what: "Collapse or open the sidebar", where: "Anywhere" },
  { keys: "?", what: "Show keyboard shortcuts", where: "Anywhere" },
  { keys: "F1", what: "Open Help", where: "Anywhere" },
  { keys: "J / K", what: "Next or previous item", where: "Approvals, Ledger, History" },
  { keys: "Enter", what: "Open the selected item (never approves)", where: "Lists" },
  { keys: "↑", what: "Bring back your last question", where: "Ask, empty composer" },
  { keys: `${MOD}.`, what: "Stop the answer", where: "Ask" },
  { keys: "Esc", what: "Close a dialog or drawer", where: "Anywhere" },
];

/** "?" opens the searchable shortcut sheet; F1 opens Help. Ignored while typing. */
export function GlobalHelpKeys() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        void navigate({ to: "/help" });
        return;
      }
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("rocky:shortcuts", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rocky:shortcuts", onOpen);
    };
  }, [navigate]);
  return <ShortcutSheet open={open} onClose={() => setOpen(false)} />;
}

export const openShortcuts = () => window.dispatchEvent(new Event("rocky:shortcuts"));

function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = SHORTCUTS.filter((s) =>
    words.every((w) => `${s.keys} ${s.what} ${s.where}`.toLowerCase().includes(w)),
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Input label="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
      <dl className="rk-shortcuts">
        {shown.map((s) => (
          <div key={s.keys} className="rk-shortcuts__row">
            <dt>
              <kbd className="rk-kbd">{s.keys}</kbd>
            </dt>
            <dd>
              {s.what} <span className="rk-small rk-muted">· {s.where}</span>
            </dd>
          </div>
        ))}
      </dl>
      {!shown.length && <p className="rk-muted">No shortcut matches “{q}”.</p>}
    </Modal>
  );
}
