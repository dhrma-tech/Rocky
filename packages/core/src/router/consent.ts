import { createHash, randomBytes } from "node:crypto";

/**
 * Outbound consent (roadmap M4, D-068). Before a question goes to the cloud the user sees the
 * exact passages it would send (the preview) and accepts them. A preview is offered with a token;
 * the user's request redeems it once, and only then, for a few minutes, does the gate let that
 * question's calls out. Nothing else can mint an accepted token, so background work, which never
 * holds one, can't reach the cloud through this door. In memory only: a restart forgets offers.
 */

const OFFER_MS = 10 * 60_000;
/** Long enough for the answer and its check on a slow provider. */
const ACCEPTED_MS = 5 * 60_000;
const MAX_OFFERS = 200;

export interface OutboundOffer {
  question: string;
  /** Where the passages came from, so a token can't be spent on another scope. */
  scopeKey: string;
  chunkIds: string[];
  /** SHA-256 over the passage texts as shown: if a source changes, the token is void. */
  textHash: string;
}

interface Entry extends OutboundOffer {
  expiresAt: number;
  acceptedUntil: number | null;
}

export const passagesHash = (texts: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(texts)).digest("hex");

export class OutboundConsents {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  offer(o: OutboundOffer): { token: string; expiresAt: number } {
    this.sweep();
    const token = randomBytes(16).toString("hex");
    const expiresAt = this.now() + OFFER_MS;
    this.entries.set(token, { ...o, chunkIds: [...o.chunkIds], expiresAt, acceptedUntil: null });
    return { token, expiresAt };
  }

  /** The user said yes. Once per token, before it expires, for the same question and scope. */
  redeem(token: string, question: string, scopeKey: string): OutboundOffer | null {
    const e = this.entries.get(token);
    if (!e || e.acceptedUntil !== null || this.now() >= e.expiresAt) return null;
    if (e.question !== question || e.scopeKey !== scopeKey) return null;
    e.acceptedUntil = this.now() + ACCEPTED_MS;
    return {
      question: e.question,
      scopeKey: e.scopeKey,
      chunkIds: [...e.chunkIds],
      textHash: e.textHash,
    };
  }

  /** Asked by the gate before a cloud call that claims consent. */
  allows(token: string | undefined): boolean {
    if (!token) return false;
    const e = this.entries.get(token);
    return e?.acceptedUntil != null && this.now() < e.acceptedUntil;
  }

  /** The answer is done: the token can't be used again. */
  finish(token: string): void {
    this.entries.delete(token);
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, e] of this.entries)
      if (now >= (e.acceptedUntil ?? e.expiresAt)) this.entries.delete(k);
    // A flood of offers can't grow memory without bound: the oldest go first.
    while (this.entries.size >= MAX_OFFERS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
