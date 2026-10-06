import type {
  Channel,
  ExtractedCommitment,
  ExtractedDecision,
  ExtractedEntity,
  Extraction,
  MeetingSummary,
  PathInfo,
} from "@rocky/contracts";
import { ExtractionSchema, MeetingSummarySchema } from "@rocky/contracts";
import * as chrono from "chrono-node";
import type { Router } from "../router/router.ts";
import { UNTRUSTED_RULE, wrapUntrusted } from "../security/untrusted.ts";
import { quoteInText } from "../text/quote.ts";

export interface Seg {
  /** "s1", "s2", … in time order across the whole meeting. */
  ref: string;
  startMs: number;
  endMs: number;
  channel: Channel;
  speakerLabel: string;
  text: string;
}

/**
 * About 4.5k tokens of transcript per window: with the system prompt and output this stays under
 * half of the local model's 16k context (Ollama drops the start of longer prompts).
 */
export const WINDOW_CHARS = 18_000;
/** Segments repeated at the start of the next window so a promise split across the edge is seen whole. */
const OVERLAP_SEGS = 2;

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export const segLine = (s: Seg) =>
  `[${s.ref}] ${mmss(s.startMs)} ${s.channel === "mixed" ? "" : `${s.speakerLabel}: `}${s.text}`;

/** Splits the transcript into windows of at most `maxChars`, with a small overlap. */
export function buildWindows(segs: Seg[], maxChars = WINDOW_CHARS): Seg[][] {
  const out: Seg[][] = [];
  let cur: Seg[] = [];
  let size = 0;
  for (const s of segs) {
    const len = segLine(s).length + 1;
    if (cur.length > OVERLAP_SEGS && size + len > maxChars) {
      out.push(cur);
      cur = cur.slice(-OVERLAP_SEGS);
      size = cur.reduce((a, x) => a + segLine(x).length + 1, 0);
    }
    cur.push(s);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const EXTRACT_SYSTEM = [
  "You extract commitments, decisions and named entities from a meeting or lecture transcript.",
  "Each transcript line is: [segment id] timestamp speaker: text. Speaker 'You' is the user who",
  "recorded; 'Others' is the remote side of the call; a line without a speaker has an unknown speaker.",
  "",
  "Rules:",
  "- A commitment is a concrete promise or assigned task: someone will do something, maybe by a deadline.",
  "  Not opinions, wishes, or things already done.",
  '- owner: "me" only when the speaker labelled You promises or is assigned the task. Otherwise the',
  '  person\'s name as said in the transcript, or "unknown" when no name is given.',
  "- counterparty: who it is promised to, by name, or null.",
  '- deadline: the words used ("by Friday", "next week", "March 3"), or null.',
  "- evidenceQuote: copy 3 to 40 consecutive words exactly as written in ONE segment. Never paraphrase.",
  '- segmentRef: the id of that segment, e.g. "s12".',
  "- confidence: 0 to 1, how sure you are that this is a real commitment.",
  "- decisions: things that were agreed or decided, with the same evidence rules.",
  "- entities: people, organisations, courses and projects named in the text; email only if spelled out.",
  "- notes: two to four sentences on what this part of the transcript covers.",
  "- Use empty arrays when there is nothing. Never invent anything that is not in the transcript.",
  "",
  UNTRUSTED_RULE,
].join("\n");

export const SUMMARY_SYSTEM = [
  "You summarise a meeting or lecture for the person who recorded it.",
  "Return: title (at most 8 words), summary (at most 200 words, plain prose), topics (short noun",
  "phrases), openQuestions (questions raised but not answered). Use only what the material says.",
  "",
  UNTRUSTED_RULE,
].join("\n");

export interface MeetingContext {
  title: string;
  kind: "meeting" | "lecture";
  /** ms UTC; the reference date for relative deadlines. */
  startedAt: number;
}

const header = (m: MeetingContext) =>
  `${m.kind === "lecture" ? "Lecture" : "Meeting"} "${m.title}" on ${new Date(m.startedAt).toISOString().slice(0, 10)}.`;

export function extractPrompt(m: MeetingContext, win: Seg[], i: number, n: number): string {
  return `${header(m)} Transcript part ${i + 1} of ${n}:\n\n${wrapUntrusted(
    win.map(segLine).join("\n"),
    {
      id: `part-${i + 1}`,
      source: "transcript",
    },
  )}`;
}

export interface ItemAnchor {
  startMs: number;
  endMs: number;
}

export interface ValidCommitment extends ExtractedCommitment {
  anchor: ItemAnchor;
  channel: Channel;
}
export interface ValidDecision extends ExtractedDecision {
  anchor: ItemAnchor;
}

export interface Validated {
  commitments: ValidCommitment[];
  decisions: ValidDecision[];
  entities: ExtractedEntity[];
  errors: string[];
}

/**
 * Checks every item against the window (assistant.md step 2): the segment must exist and the
 * evidence quote must be verbatim in it. Whisper splits sentences, so the quote may also run into
 * the next segment; the anchor still points at the referenced one.
 */
export function validateExtraction(out: Extraction, win: Seg[]): Validated {
  const byRef = new Map(win.map((s, i) => [s.ref, i]));
  const errors: string[] = [];
  const check = (kind: string, i: number, item: { segmentRef: string; evidenceQuote: string }) => {
    const idx = byRef.get(item.segmentRef.trim().replace(/^\[|\]$/g, ""));
    if (idx === undefined) {
      errors.push(
        `${kind}[${i}]: segmentRef "${item.segmentRef}" is not a segment id in this part.`,
      );
      return null;
    }
    const seg = win[idx] as Seg;
    const next = win[idx + 1];
    const text = next ? `${seg.text} ${next.text}` : seg.text;
    if (!quoteInText(item.evidenceQuote, text)) {
      errors.push(
        `${kind}[${i}]: evidenceQuote "${item.evidenceQuote}" is not an exact copy of words in ${seg.ref}.`,
      );
      return null;
    }
    return seg;
  };
  const commitments: ValidCommitment[] = [];
  out.commitments.forEach((c, i) => {
    const seg = check("commitments", i, c);
    if (seg)
      commitments.push({
        ...c,
        anchor: { startMs: seg.startMs, endMs: seg.endMs },
        channel: seg.channel,
      });
  });
  const decisions: ValidDecision[] = [];
  out.decisions.forEach((d, i) => {
    const seg = check("decisions", i, d);
    if (seg) decisions.push({ ...d, anchor: { startMs: seg.startMs, endMs: seg.endMs } });
  });
  return { commitments, decisions, entities: out.entities, errors };
}

/** "by Friday" relative to the meeting date → ms UTC, or null when chrono can't read it. */
export function parseDeadline(text: string | null, ref: number): number | null {
  if (!text?.trim()) return null;
  const d = chrono.parseDate(text, new Date(ref), { forwardDate: true });
  return d ? d.getTime() : null;
}

export interface WindowResult extends Validated {
  notes: string;
  path: PathInfo;
  /** Items dropped because their evidence still failed after the repair retry. */
  dropped: number;
}

/**
 * One window: extract, validate, and if anything failed validation ask once more with the list of
 * problems (assistant.md step 5). Items that still fail are dropped and counted; schema failures
 * are retried and escalated by the router itself.
 */
export async function extractWindow(
  router: Router,
  m: MeetingContext,
  win: Seg[],
  i: number,
  n: number,
  scope: { localOnly?: boolean },
): Promise<WindowResult> {
  const prompt = extractPrompt(m, win, i, n);
  const first = await router.run<Extraction>({
    task: "extract",
    origin: "system",
    system: EXTRACT_SYSTEM,
    prompt,
    schema: ExtractionSchema,
    scope,
    hints: { temperature: 0 },
  });
  const v1 = validateExtraction(first.output, win);
  if (!v1.errors.length) return { ...v1, notes: first.output.notes, path: first.path, dropped: 0 };

  const repair = await router.run<Extraction>({
    task: "extract",
    origin: "system",
    system: EXTRACT_SYSTEM,
    prompt: `${prompt}\n\nYour previous reply was:\n${JSON.stringify(first.output)}\n\nThese items failed validation:\n- ${v1.errors.join("\n- ")}\n\nReply again with the full corrected JSON. Fix each failed item by copying the exact words from the segment it cites, or remove it.`,
    schema: ExtractionSchema,
    scope,
    hints: { temperature: 0 },
  });
  const v2 = validateExtraction(repair.output, win);
  return {
    ...v2,
    notes: repair.output.notes || first.output.notes,
    path: repair.path,
    dropped: v2.errors.length,
  };
}

export async function summarizeMeeting(
  router: Router,
  m: MeetingContext,
  material: { transcript: string } | { notes: string[] },
  scope: { localOnly?: boolean },
): Promise<{ summary: MeetingSummary; path: PathInfo }> {
  const body =
    "transcript" in material
      ? wrapUntrusted(material.transcript, { id: "transcript", source: "transcript" })
      : wrapUntrusted(material.notes.map((n, i) => `Part ${i + 1}: ${n}`).join("\n\n"), {
          id: "notes",
          source: "transcript-notes",
        });
  const r = await router.run<MeetingSummary>({
    task: "meeting_summary",
    origin: "system",
    system: SUMMARY_SYSTEM,
    prompt: `${header(m)}\n\n${body}`,
    schema: MeetingSummarySchema,
    scope,
    hints: { temperature: 0 },
  });
  return { summary: r.output, path: r.path };
}
