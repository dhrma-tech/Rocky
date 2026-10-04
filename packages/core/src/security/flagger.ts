/**
 * Instruction-pattern flagger (SECURITY.md "Prompt injection" #5). Defense in depth only:
 * the structural rules (wrapped data, tool-free untrusted steps, hash-bound approval) are the
 * real guarantee, so this stays a short list of high-signal heuristics.
 */

interface Rule {
  reason: string;
  re: RegExp;
}

const RULES: Rule[] = [
  {
    reason: "asks to ignore earlier instructions",
    re: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)*(previous|prior|above|earlier|preceding|existing)\s+(instructions?|prompts?|rules|messages|directions)/i,
  },
  {
    reason: "asks to forward or exfiltrate mail or data",
    re: /\b(forward|send|email|upload|exfiltrate|leak)\s+(all|every|the\s+entire|everything)\b[^.\n]{0,60}\b(mail|emails?|messages?|inbox|files?|documents?|data|contacts?|passwords?|keys?)\b/i,
  },
  {
    reason: "claims to be a system prompt or new instructions",
    re: /(<\/?\s*system\s*>|\bsystem\s+prompt\b|\bnew\s+instructions?\s*:|\byou\s+are\s+now\b|\bdeveloper\s+mode\b|\bjailbreak\b)/i,
  },
  {
    reason: "addresses the assistant with a command",
    re: /\b(assistant|ai|chatbot|claude|rocky|llm)\b[,:]?\s+(please\s+)?(create|send|forward|delete|invite|email|schedule|transfer|approve|execute|run|open|book)\b/i,
  },
  {
    reason: "asks to hide something from the user",
    re: /\b(do\s+not|don'?t|never)\s+(tell|inform|show|mention\s+(it\s+)?to|alert|notify)\s+(the\s+)?user\b/i,
  },
  {
    reason: "image link with a query string (exfiltration channel)",
    re: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\?[^)\s]*\)|<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^"'\s>]*\?/i,
  },
  {
    reason: "URL carrying a long encoded value",
    re: /https?:\/\/[^\s)"'<>]+[?&][\w.-]+=[A-Za-z0-9+/_%=-]{64,}/,
  },
  { reason: "long base64 blob", re: /[A-Za-z0-9+/]{200,}={0,2}/ },
];

export interface FlagResult {
  suspicious: boolean;
  reasons: string[];
}

export function flagInstructions(text: string): FlagResult {
  const reasons = RULES.filter((r) => r.re.test(text)).map((r) => r.reason);
  return { suspicious: reasons.length > 0, reasons };
}
