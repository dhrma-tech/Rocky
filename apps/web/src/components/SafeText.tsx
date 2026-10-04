import { ExternalLink } from "lucide-react";
import { Fragment } from "react";

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;

/** Only http(s) links can be opened, and never automatically. */
function open(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:")
      window.open(u.toString(), "_blank", "noopener,noreferrer");
  } catch {
    // Not a valid URL: nothing to open.
  }
}

/**
 * Renders model or source text safely (SECURITY.md "No exfiltration channel"): React escapes all
 * text, nothing is parsed as HTML or markdown, images never load, and a URL is shown as plain
 * text with an explicit open button instead of a live link.
 */
export function SafeText({ text }: { text: string }) {
  // Each part is keyed by its offset in the text, which is stable for a given string.
  const parts: { at: number; text?: string; url?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ at: last, text: text.slice(last, i) });
    parts.push({ at: i, url: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ at: last, text: text.slice(last) });
  return (
    <>
      {parts.map((p) =>
        p.url === undefined ? (
          <Fragment key={p.at}>{p.text}</Fragment>
        ) : (
          <span key={p.at} className="break-all">
            <span className="font-mono text-[0.9em] text-secondary">{p.url}</span>
            <button
              type="button"
              onClick={() => open(p.url as string)}
              aria-label={`Open ${p.url} in a new tab`}
              title="Open in a new tab"
              className="ml-1 inline-flex size-6 translate-y-[3px] items-center justify-center rounded-xs text-link hover:bg-layer-subtle"
            >
              <ExternalLink size={14} aria-hidden />
            </button>
          </span>
        ),
      )}
    </>
  );
}
