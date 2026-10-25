import type { SensitiveTag } from "@rocky/contracts";

/**
 * Sensitive-class tags for the outbound preview (roadmap M4, D-068). Pattern checks only, no
 * model: they mark a passage so the user looks twice before it leaves, they never block or
 * rewrite it. A miss is possible (the preview shows the full text anyway); a false alarm only
 * costs a glance.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// 10 to 15 digits, optionally with +, spaces, dots, dashes or brackets between them.
const PHONE_CANDIDATE = /(?<![\w.])\+?\(?\d(?:[\s().-]?\d){9,14}(?![\w.])/g;
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/;
const ID_NUMBERS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US Social Security number
  /(?<!\d )\b[2-9]\d{3} \d{4} \d{4}\b(?! \d)/, // Aadhaar, not part of a longer card number
  /\b[A-Z]{5}\d{4}[A-Z]\b/, // Indian PAN
  /\b[A-Z]{2}\d{6}[A-D]\b/, // UK National Insurance number
];
const SECRETS = [
  /\b(?:password|passwd|pwd|passcode|pin|otp|api[ _-]?key|secret|token)\b\s*(?:is|:|=)\s*\S{4,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI- and Anthropic-style keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key IDs
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Luhn checksum, so order numbers and timestamps aren't called card numbers. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCard(text: string): boolean {
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** A run of digits reads as a phone number with a + or separators, or at exactly ten digits:
 * a bare 13-digit order number doesn't. */
function hasPhone(text: string): boolean {
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    const s = m[0];
    const digits = s.replace(/\D/g, "");
    if (s.startsWith("+") || /[\s().-]/.test(s) || digits.length === 10) return true;
  }
  return false;
}

/** The tags for one passage, in a fixed order. */
export function sensitiveTags(text: string): SensitiveTag[] {
  const tags: SensitiveTag[] = [];
  if (EMAIL.test(text)) tags.push("email");
  const card = hasCard(text);
  const iban = IBAN.test(text);
  // Card numbers and IBANs also look like long phone numbers; say what they are, not both.
  if (!card && hasPhone(iban ? text.replace(new RegExp(IBAN.source, "g"), " ") : text))
    tags.push("phone");
  if (card) tags.push("card_number");
  if (iban) tags.push("iban");
  if (ID_NUMBERS.some((r) => r.test(text))) tags.push("id_number");
  if (SECRETS.some((r) => r.test(text))) tags.push("secret");
  return tags;
}
