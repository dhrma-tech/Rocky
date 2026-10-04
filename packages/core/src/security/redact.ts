/** Token patterns removed from anything logged (SECURITY.md "Secrets"). */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /xox[abp]-[A-Za-z0-9-]{8,}/g,
  /xapp-[A-Za-z0-9-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /lin_api_[A-Za-z0-9]{20,}/g,
  /phx_[A-Za-z0-9]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
  /("?(?:x-api-key|x-goog-api-key|authorization)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS)
    out = out.replace(re, (m, prefix?: string) =>
      typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]",
    );
  return out;
}

/** Wraps a logger so every message passes through redact(). */
export function redactingLogger(log: (msg: string) => void): (msg: string) => void {
  return (msg) => log(redact(msg));
}
