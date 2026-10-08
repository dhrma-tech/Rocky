/**
 * One-time codes and sign-in links are stripped from mail and chat at ingestion (roadmap I1):
 * Rocky has no use for them, and an injected instruction must not be able to quote them out.
 * Masks keep the original length, so every offset into the text (units, blocks, chunks) stays
 * valid. Heuristic by design; it errs toward removing a link that only looks like a sign-in.
 */

const CODE_WORDS = String.raw`(?:(?:verification|security|one[-\s]?time|login|log[-\s]?in|sign[-\s]?in|confirmation|authentication|auth|2fa|two[-\s]factor|access|reset)\s+(?:code|pin|passcode|number)|otp|passcode)`;

/** "Your verification code is 123 456", "OTP: 834921", "G-123456 is your Google code". */
const CODE_AFTER = new RegExp(
  String.raw`\b${CODE_WORDS}\b[^\n\d]{0,40}?((?:[A-Z]-)?\d(?:[\d\s-]{2,10})\d)\b`,
  "gi",
);
const CODE_BEFORE =
  /(?<![\w-])((?:[A-Z]-)?\d{4,8})\b(?=[^\n]{0,30}\b(?:is|as)\s+your\b[^\n]{0,40}\b(?:code|otp|pin|passcode)\b)/gi;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const LINK_IN_URL =
  /reset|passw(or)?d|magic|verif|confirm|activat|one-?time|otp|[?&](token|code|key|sig|signature|auth)=|sign-?in|log-?in|\/auth\//i;
const LINK_CONTEXT =
  /(reset (your )?password|password reset|sign in|log in|magic link|verify your|confirm your (email|account)|one-time link|login link)[^\n]{0,100}$/i;

const CODE_MASK = "•";
const LINK_LABEL = "[sign-in link removed]";

export interface StripResult {
  text: string;
  codes: number;
  links: number;
}

const mask = (s: string) => s.replace(/[^\s-]/g, CODE_MASK);
const linkMask = (url: string) =>
  url.length >= LINK_LABEL.length
    ? LINK_LABEL + " ".repeat(url.length - LINK_LABEL.length)
    : CODE_MASK.repeat(url.length);

export function stripOneTimeSecrets(text: string): StripResult {
  let codes = 0;
  let links = 0;
  let out = text.replace(URL_RE, (url, offset: number) => {
    const before = text.slice(Math.max(0, offset - 160), offset);
    if (!LINK_IN_URL.test(url) && !LINK_CONTEXT.test(before)) return url;
    links++;
    return linkMask(url);
  });
  const replaceGroup = (m: string, code: string) => {
    codes++;
    const i = m.lastIndexOf(code);
    return m.slice(0, i) + mask(code) + m.slice(i + code.length);
  };
  out = out.replace(CODE_AFTER, replaceGroup).replace(CODE_BEFORE, replaceGroup);
  return { text: out, codes, links };
}
