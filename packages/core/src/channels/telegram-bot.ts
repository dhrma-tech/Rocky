import type { ActionRecord, AskResult } from "@rocky/contracts";
import {
  approveData,
  parseApproveData,
  type TelegramInbound,
  type TelegramOutbound,
} from "./telegram.ts";

/**
 * What Rocky does with a message from an allowed Telegram user (roadmap A3, D-002, D-066). A
 * message is the user's own words but arrives over a third-party service, so it is handled
 * narrowly: a few fixed commands, otherwise a cited question. It never proposes or runs an
 * action. In-chat Approve exists only for low-risk writes with ordinary review, behind a setting
 * that is off by default; sends, spends, deletes and strict-review actions get a Review link only.
 */

export interface TelegramBotSettings {
  approveLowRiskInChat: boolean;
  /** The phone's address for Rocky (D-064), for Review links; none means no link. */
  phoneHost: string | undefined;
}

export interface TelegramBotDeps {
  send(m: TelegramOutbound): Promise<void>;
  answerCallback(callbackId: string, text: string): Promise<void>;
  settings(): TelegramBotSettings;
  drafts(): ActionRecord[];
  approve(id: string, payloadHash: string): ActionRecord;
  ask(question: string): Promise<AskResult>;
  status(): { running: number; approvals: number; unread: number };
  today(): { events: number; dueSoon: number; overdue: number };
  log?: (msg: string) => void;
}

/** Only low-risk writes with ordinary review may be approved from the chat (D-002). */
export function chatApprovable(a: ActionRecord, s: TelegramBotSettings): boolean {
  return (
    s.approveLowRiskInChat &&
    a.status === "draft" &&
    a.risk === "low" &&
    a.actionClass === "write" &&
    a.review !== "strict"
  );
}

const HELP =
  "Ask me anything about your sources, or use /approvals, /status or /today. I can't send, change or delete anything from here.";

/** An answer as chat text: the verified sentences, then where they came from. */
export function answerText(r: AskResult): string {
  // Asked from here, a question stays local; the cloud is only offered in Rocky, where the
  // passages it would send can be checked first (D-068).
  const cloud = r.outbound
    ? "\n\nRocky's local model wasn't sure. Ask in Rocky to see what a cloud model would be sent."
    : "";
  if (r.notFound || r.answer.length === 0) {
    const near = r.closestMatches.slice(0, 3).map((m) => m.title);
    return `${near.length ? `Not found in your sources. Closest: ${near.join("; ")}.` : "Not found in your sources."}${cloud}`;
  }
  const body = r.answer.map((s) => s.text).join(" ");
  const titles = [...new Set(r.answer.flatMap((s) => s.citations.map((c) => c.title)))];
  return `${titles.length ? `${body}\n\nSources: ${titles.join("; ")}` : body}${cloud}`;
}

export class TelegramBot {
  private readonly deps: TelegramBotDeps;
  private busy = false;

  constructor(deps: TelegramBotDeps) {
    this.deps = deps;
  }

  private reviewButton(): { text: string; url: string } | null {
    const host = this.deps.settings().phoneHost;
    return host ? { text: "Review", url: `https://${host}/approvals` } : null;
  }

  async handle(m: TelegramInbound): Promise<void> {
    try {
      if (m.kind === "message") await this.message(m.chatId, m.text.trim());
      else if (m.kind === "callback") await this.callback(m.chatId, m.callbackId, m.data);
    } catch (err) {
      this.deps.log?.(`telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async message(chatId: number, text: string): Promise<void> {
    const say = (t: string, buttons?: TelegramOutbound["buttons"]) =>
      this.deps.send({ chatId, text: t, ...(buttons ? { buttons } : {}) });
    const command = text.startsWith("/") ? (text.split(/\s+/)[0] ?? "").toLowerCase() : "";
    if (command === "/start" || command === "/help") return say(`Rocky is connected. ${HELP}`);
    if (command === "/status") {
      const s = this.deps.status();
      return say(
        `${s.approvals} waiting for your approval, ${s.running} running, ${s.unread} unread notifications.`,
      );
    }
    if (command === "/today") {
      const t = this.deps.today();
      return say(
        `Today: ${t.events} on your calendar, ${t.dueSoon} commitments due soon, ${t.overdue} overdue.`,
      );
    }
    if (command === "/approvals") return this.approvals(chatId);
    if (command && command !== "/ask") return say(HELP);
    const question = command === "/ask" ? text.slice(4).trim() : text;
    if (!question) return say("Ask a question after /ask, or just type it.");
    if (this.busy) return say("I'm still on your last question. One at a time.");
    this.busy = true;
    try {
      await say("Looking through your sources…");
      await say(answerText(await this.deps.ask(question)));
    } catch (err) {
      await say(`I couldn't answer: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async approvals(chatId: number): Promise<void> {
    const drafts = this.deps.drafts();
    const review = this.reviewButton();
    if (!drafts.length) {
      await this.deps.send({ chatId, text: "Nothing is waiting for your approval." });
      return;
    }
    for (const a of drafts.slice(0, 5)) {
      const summary = a.description.summary ? `${a.title}: ${a.description.summary}` : a.title;
      const buttons = [
        ...(review ? [review] : []),
        ...(chatApprovable(a, this.deps.settings())
          ? [{ text: "Approve", data: approveData(a.id, a.payloadHash) }]
          : []),
      ];
      await this.deps.send({
        chatId,
        text: `${summary}\n${a.risk} risk · ${a.actionClass} · hash ${a.payloadHash.slice(0, 12)}`,
        buttons,
      });
    }
    if (drafts.length > 5)
      await this.deps.send({
        chatId,
        text: `…and ${drafts.length - 5} more. Open Rocky to see them all.`,
      });
  }

  private async callback(chatId: number, callbackId: string, data: string): Promise<void> {
    const parsed = parseApproveData(data);
    const refuse = (why: string) => this.deps.answerCallback(callbackId, why);
    if (!parsed) return refuse("I don't know that button.");
    const a = this.deps.drafts().find((d) => d.id === parsed.actionId);
    if (!a) return refuse("That isn't waiting any more.");
    // Re-checked now, not when the button was sent: the setting or the action may have changed.
    if (!chatApprovable(a, this.deps.settings())) return refuse("Approve this one in Rocky.");
    if (!a.payloadHash.startsWith(parsed.hashPrefix))
      return refuse("It changed since this message. Look again in Rocky.");
    try {
      this.deps.approve(a.id, a.payloadHash);
    } catch (err) {
      return refuse(err instanceof Error ? err.message.slice(0, 200) : "Not approved.");
    }
    await this.deps.answerCallback(callbackId, "Approved.");
    await this.deps.send({
      chatId,
      text: `Approved: ${a.title}. It runs in 10 seconds; you can undo it in Rocky until then.`,
    });
  }
}
