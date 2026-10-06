import type { Citation } from "@rocky/contracts";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AnchorView, api } from "../api.ts";
import { AudioPlayer, type PlayerHandle, TranscriptView } from "./capture.tsx";
import { citationLocation } from "./trust.tsx";
import { IconButton } from "./ui.tsx";

/** pdf.js is large; it loads only when a PDF citation is opened. */
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

const norm = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Right drawer (§5.7): header with title and location, the source with the cited span highlighted. */
export function SourceViewer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["anchor", citation.documentId, citation.chunkId],
    queryFn: () => api.anchor(citation.documentId, citation.chunkId),
  });
  const where = citationLocation(citation);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="Source viewer"
      className="flex h-full w-full flex-col border-l border-border-base bg-raised lg:w-[420px] lg:min-w-[360px] lg:max-w-[640px] lg:resize-x lg:overflow-auto"
    >
      <header className="flex items-start gap-2 border-b border-border-base p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-primary">{citation.title}</h2>
          {where && <p className="text-xs text-secondary">{where}</p>}
        </div>
        <IconButton label="Close source viewer" onClick={onClose}>
          <X size={20} aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {q.isLoading && <p className="text-sm text-secondary">Loading source…</p>}
        {q.error && (
          <p role="alert" className="text-sm text-danger">
            {q.error.message}
          </p>
        )}
        {q.data?.viewer === "text" && <TextSource view={q.data} />}
        {q.data?.viewer === "external" && <ExternalSource view={q.data} />}
        {q.data?.viewer === "pdf" && <PdfSource view={q.data} quote={citation.quote} />}
        {q.data?.viewer === "transcript" && (
          <TranscriptSource
            view={q.data}
            focusMs={
              citation.anchor.kind === "transcript" ? citation.anchor.startMs : q.data.startMs
            }
          />
        )}
      </div>
      <footer className="border-t border-border-base p-4">
        <p className="text-xs text-tertiary">Quoted: “{citation.quote}”</p>
      </footer>
    </aside>
  );
}

/** Transcripts show a window around the timestamp with a player (DESIGN §5.7 source viewer). */
function TranscriptSource({
  view,
  focusMs,
}: {
  view: Extract<AnchorView, { viewer: "transcript" }>;
  focusMs: number;
}) {
  const player = useRef<PlayerHandle>(null);
  const [t, setT] = useState<number | undefined>(undefined);
  return (
    <div className="space-y-3">
      {view.audioUrl && (
        <div className="overflow-hidden rounded-md">
          <AudioPlayer ref={player} src={view.audioUrl} onTime={setT} />
        </div>
      )}
      <TranscriptView
        segments={view.segments}
        currentMs={t}
        focusMs={focusMs}
        onSeek={view.audioUrl ? (ms) => player.current?.seek(ms) : undefined}
      />
    </div>
  );
}

const APP: Record<string, string> = {
  github: "GitHub",
  notion_block: "Notion",
  row: "Notion",
  message: "Gmail",
  event: "Calendar",
};

/** Connector items: the synced text with the cited span, and an explicit button to the original. */
function ExternalSource({ view }: { view: Extract<AnchorView, { viewer: "external" }> }) {
  const app = APP[view.anchor.kind] ?? "the app";
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => window.open(view.url, "_blank", "noopener,noreferrer")}
        className="inline-flex min-h-11 items-center gap-2 rounded-md bg-raised px-4 text-sm font-semibold shadow-raised-sm"
      >
        <ExternalLink size={14} aria-hidden /> Open in {app}
      </button>
      <p className="break-all font-mono text-xs text-tertiary">{view.url}</p>
      <TextSource view={{ ...view, viewer: "text" }} />
    </div>
  );
}

function TextSource({ view }: { view: Extract<AnchorView, { viewer: "text" }> }) {
  const mark = useRef<HTMLElement>(null);
  useEffect(() => mark.current?.scrollIntoView({ block: "center" }), []);
  const { text, charStart, charEnd } = view;
  return (
    <pre className="whitespace-pre-wrap font-answer text-sm leading-6 text-primary">
      {text.slice(0, charStart)}
      <mark
        ref={mark}
        className="rounded-xs border-l-2 border-accent-strong bg-accent-soft px-0.5 text-primary"
      >
        {text.slice(charStart, charEnd)}
      </mark>
      {text.slice(charEnd)}
    </pre>
  );
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Renders the cited page and highlights text items that belong to the quote. */
function PdfSource({
  view,
  quote,
}: {
  view: Extract<AnchorView, { viewer: "pdf" }>;
  quote: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let destroy = () => {};
    (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      const task = pdfjs.getDocument({ url: view.blobUrl, withCredentials: true });
      destroy = () => void task.destroy();
      const doc = await task.promise;
      const page = await doc.getPage(view.page);
      const el = canvas.current;
      if (!el || cancelled) return;
      const width = el.parentElement?.clientWidth ?? 380;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const ratio = window.devicePixelRatio || 1;
      el.width = Math.floor(viewport.width * ratio);
      el.height = Math.floor(viewport.height * ratio);
      el.style.width = `${viewport.width}px`;
      el.style.height = `${viewport.height}px`;
      setSize({ w: viewport.width, h: viewport.height });
      await page.render({
        canvas: el,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      }).promise;

      const q = norm(quote);
      const content = await page.getTextContent();
      const found: Rect[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const s = norm(item.str);
        if (s.length < 4 || !(q.includes(s) || s.includes(q))) continue;
        const [x1, y1] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const [x2, y2] = viewport.convertToViewportPoint(
          item.transform[4] + item.width,
          item.transform[5] + item.height,
        );
        found.push({
          left: Math.min(x1, x2),
          top: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        });
      }
      if (!cancelled) setRects(found);
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      destroy();
    };
  }, [view.blobUrl, view.page, quote]);

  if (error)
    return (
      <p role="alert" className="text-sm text-danger">
        Could not render the PDF: {error}
      </p>
    );
  return (
    <div className="relative" style={size ? { width: size.w, height: size.h } : undefined}>
      <canvas
        ref={canvas}
        className="rounded-sm shadow-raised-sm"
        aria-label={`Page ${view.page}`}
      />
      {rects.map((r) => (
        <span
          key={`${r.left}-${r.top}`}
          aria-hidden
          className="pointer-events-none absolute border-l-2 border-accent-strong bg-accent-soft mix-blend-multiply"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
        />
      ))}
      {rects.length === 0 && size && (
        <p className="mt-2 text-xs text-tertiary">
          Page {view.page}. The exact span could not be located on the page.
        </p>
      )}
    </div>
  );
}
