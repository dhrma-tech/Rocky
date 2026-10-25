import { randomUUID } from "node:crypto";
import type { AskEvent, AskRequest, AskResult } from "@rocky/contracts";
import { appendTurn, ask, type Runtime, recordEvent } from "@rocky/core";
import { errorBody } from "./app.ts";

/**
 * One question as a run in the ledger (UI spec 5, D-053): thinking, working, then a receipt or an
 * error. Events carry the question (the user's words) and counts, never answer text, so deleting
 * a source leaves nothing behind. Used by POST /ask and by Telegram (D-066).
 */
export async function runAsk(
  rt: Runtime,
  req: AskRequest,
  send: (e: AskEvent) => void = () => {},
  opts: { conversationId?: string; via?: string } = {},
): Promise<AskResult> {
  const runId = `ask:${randomUUID()}`;
  const q = req.question;
  const title = `${opts.via ? `${opts.via}: ` : "Ask: "}${q.length > 60 ? `${q.slice(0, 59)}…` : q}`;
  const status = (state: "thinking" | "working" | "completed" | "failed", line?: string) =>
    recordEvent(rt.db, {
      kind: "status",
      runId,
      state,
      runKind: "ask",
      title,
      ...(line ? { line } : {}),
    });
  let drafting = false;
  status("thinking", "Searching your sources");
  try {
    const result = await ask({ db: rt.db, router: rt.router, embedder: rt.embedder }, req, (e) => {
      if (e.type === "draft_sentence" && !drafting) {
        drafting = true;
        status("working", "Checking each statement against its source");
      }
      send(e);
    });
    if (opts.conversationId) appendTurn(rt.db, opts.conversationId, q, result);
    const sources = new Set([
      ...result.answer.flatMap((x) => x.citations.map((ci) => ci.documentId)),
      ...result.closestMatches.map((m) => m.documentId),
    ]).size;
    recordEvent(rt.db, {
      kind: "receipt",
      runId,
      tool: "Ask",
      verb: result.notFound ? "found nothing in" : "cited",
      count: sources,
      unit: sources === 1 ? "source" : "sources",
      notDone: "0 changed",
    });
    status("completed");
    return result;
  } catch (err) {
    const body = errorBody(err);
    recordEvent(rt.db, { kind: "error", runId, code: body.code, message: body.error });
    status("failed");
    throw err;
  }
}
