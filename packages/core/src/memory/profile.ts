import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { appendAudit } from "../audit/append.ts";
import { dataPaths } from "../config/paths.ts";
import { recordEvent } from "../events/log.ts";
import type { Db } from "../store/db.ts";

/**
 * The memory profile (roadmap A5, UI spec 13): what Rocky remembers about you, as plain Markdown
 * files you can open, edit and delete. Every fact line carries where it came from:
 *
 *   - Prefers annual billing <!-- rocky: {"by":"source","doc":"…","title":"…","quote":"…","at":…} -->
 *
 * Facts are either stated by the user or quoted from a source; Rocky never stores its own
 * inference as a fact. Changes are versioned in a git repository inside the folder when git is
 * installed (only that folder's repo is touched, never the user's git config).
 */

export const MEMORY_GROUPS = ["About you", "Preferences", "People", "Projects"] as const;
export type MemoryGroup = (typeof MEMORY_GROUPS)[number];

const PATH_RE = /^(about-you|preferences)\.md$|^(people|projects)\/[a-z0-9][a-z0-9-]{0,59}\.md$/;

export const FactProvenanceSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("user"), at: z.number().int() }),
  z.object({
    by: z.literal("source"),
    doc: z.string(),
    title: z.string(),
    quote: z.string().min(1).max(500),
    at: z.number().int(),
    /** The approval that saved it. */
    run: z.string().optional(),
  }),
]);
export type FactProvenance = z.infer<typeof FactProvenanceSchema>;

export interface Fact {
  text: string;
  provenance: FactProvenance | null;
}

export interface MemoryFile {
  path: string;
  group: MemoryGroup;
  title: string;
  facts: Fact[];
  /** sha256 of the file: an edit must name the version it started from. */
  hash: string;
  updatedAt: number;
}

export class MemoryError extends Error {
  readonly code: "BAD_PATH" | "NOT_FOUND" | "CONFLICT" | "UNSUPPORTED_QUOTE";
  readonly current?: string;
  constructor(code: MemoryError["code"], message: string, current?: string) {
    super(message);
    this.code = code;
    if (current !== undefined) this.current = current;
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const root = (dataDir: string) => dataPaths(dataDir).memory;

export function checkPath(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  if (!PATH_RE.test(norm))
    throw new MemoryError(
      "BAD_PATH",
      "Memory files are about-you.md, preferences.md, people/<name>.md or projects/<name>.md.",
    );
  return norm;
}

const groupOf = (rel: string): MemoryGroup =>
  rel === "about-you.md"
    ? "About you"
    : rel === "preferences.md"
      ? "Preferences"
      : rel.startsWith("people/")
        ? "People"
        : "Projects";

const COMMENT = /\s*<!--\s*rocky:\s*(\{.*\})\s*-->\s*$/;

export function parseFacts(content: string): Fact[] {
  const out: Fact[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const c = COMMENT.exec(m[1]);
    let provenance: FactProvenance | null = null;
    if (c?.[1])
      try {
        provenance = FactProvenanceSchema.parse(JSON.parse(c[1]));
      } catch {
        provenance = null;
      }
    out.push({ text: m[1].replace(COMMENT, "").trim(), provenance });
  }
  return out;
}

/** A fact line. `-->` can't appear inside the comment, so the quote can't end it early. */
export function factLine(text: string, p: FactProvenance): string {
  const clean = text.replace(/[\r\n]+/g, " ").trim();
  return `- ${clean} <!-- rocky: ${JSON.stringify(p).replace(/-->/g, "-- >")} -->`;
}

function titleOf(rel: string, content: string): string {
  const h = /^#\s+(.+)$/m.exec(content)?.[1];
  return h?.trim() ?? groupOf(rel);
}

export function readMemoryFile(dataDir: string, rel: string): MemoryFile {
  const p = checkPath(rel);
  const file = path.join(root(dataDir), p);
  if (!fs.existsSync(file)) throw new MemoryError("NOT_FOUND", `${p} doesn't exist yet.`);
  const content = fs.readFileSync(file, "utf8");
  return {
    path: p,
    group: groupOf(p),
    title: titleOf(p, content),
    facts: parseFacts(content),
    hash: sha(content),
    updatedAt: Math.round(fs.statSync(file).mtimeMs),
  };
}

export function readMemoryContent(dataDir: string, rel: string): { content: string; hash: string } {
  const p = checkPath(rel);
  const file = path.join(root(dataDir), p);
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { content, hash: sha(content) };
}

export function listMemory(dataDir: string): MemoryFile[] {
  const dir = root(dataDir);
  if (!fs.existsSync(dir)) return [];
  const rels: string[] = [];
  for (const f of ["about-you.md", "preferences.md"])
    if (fs.existsSync(path.join(dir, f))) rels.push(f);
  for (const sub of ["people", "projects"]) {
    const d = path.join(dir, sub);
    if (fs.existsSync(d))
      for (const f of fs.readdirSync(d).sort()) {
        const rel = `${sub}/${f}`;
        if (PATH_RE.test(rel)) rels.push(rel);
      }
  }
  return rels.map((r) => readMemoryFile(dataDir, r));
}

// --- versioning ---

let gitOk: boolean | null = null;
function hasGit(): boolean {
  if (gitOk === null)
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
      gitOk = true;
    } catch {
      gitOk = false;
    }
  return gitOk;
}

const git = (dir: string, args: string[]) =>
  execFileSync(
    "git",
    // Identity and settings for this repo only; the user's global config is never changed.
    [
      "-c",
      "user.name=Rocky",
      "-c",
      "user.email=rocky@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8" },
  );

function commit(dataDir: string, rel: string, message: string): void {
  const dir = root(dataDir);
  if (!hasGit()) return;
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, ["init", "-q"]);
  git(dir, ["add", "--", rel]);
  // Nothing staged (no change, or a delete of an untracked file): no commit.
  try {
    git(dir, ["diff", "--cached", "--quiet"]);
    return;
  } catch {
    // there are staged changes
  }
  git(dir, ["commit", "-q", "-m", message]);
}

export interface Version {
  id: string;
  at: number;
  message: string;
}

/** The file's history, newest first; empty without git. */
export function memoryHistory(dataDir: string, rel: string): Version[] {
  const p = checkPath(rel);
  const dir = root(dataDir);
  if (!hasGit() || !fs.existsSync(path.join(dir, ".git"))) return [];
  try {
    return git(dir, ["log", "--format=%H%x09%ct%x09%s", "--", p])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [id = "", t = "0", ...msg] = l.split("\t");
        return { id, at: Number(t) * 1000, message: msg.join("\t") };
      });
  } catch {
    return [];
  }
}

// --- changes ---

function write(
  db: Db,
  dataDir: string,
  rel: string,
  content: string,
  message: string,
  actor: "user" | "system",
  meta: Record<string, unknown> = {},
) {
  const file = path.join(root(dataDir), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  commit(dataDir, rel, message);
  appendAudit(db, {
    eventType: "memory_changed",
    actor,
    subjectType: "memory",
    subjectId: rel,
    payload: { hash: sha(content) },
    meta: { message, ...meta },
  });
}

/**
 * The user's own edit of a whole file. `baseHash` is the version the editor opened: if the file
 * changed on disk since (another editor, a sync), nothing is written and CONFLICT carries the
 * current text so the screen can show both.
 */
export function saveMemoryFile(
  db: Db,
  dataDir: string,
  rel: string,
  content: string,
  baseHash: string,
): MemoryFile {
  const p = checkPath(rel);
  const now = readMemoryContent(dataDir, p);
  if (now.hash !== baseHash)
    throw new MemoryError("CONFLICT", "This file changed since you opened it.", now.content);
  write(db, dataDir, p, content.endsWith("\n") ? content : `${content}\n`, "Edited by you", "user");
  return readMemoryFile(dataDir, p);
}

function appendFact(
  db: Db,
  dataDir: string,
  rel: string,
  line: string,
  message: string,
  actor: "user" | "system",
  meta: Record<string, unknown>,
) {
  const p = checkPath(rel);
  const { content } = readMemoryContent(dataDir, p);
  const heading = content.trim()
    ? ""
    : `# ${p === "about-you.md" ? "About you" : p === "preferences.md" ? "Preferences" : path.basename(p, ".md").replace(/-/g, " ")}\n\n`;
  const next = `${heading}${content.replace(/\s*$/, "")}${content.trim() ? "\n" : ""}${line}\n`;
  write(db, dataDir, p, next, message, actor, meta);
}

/** "Pin to memory": a fact the user states. */
export function rememberUserFact(
  db: Db,
  dataDir: string,
  rel: string,
  fact: string,
  now = Date.now(),
): MemoryFile {
  appendFact(db, dataDir, rel, factLine(fact, { by: "user", at: now }), "Noted by you", "user", {});
  recordEvent(db, {
    kind: "memory",
    runId: null,
    at: now,
    change: "learned",
    text: fact,
    source: "you",
  });
  return readMemoryFile(dataDir, rel);
}

/**
 * A fact quoted from a source, saved after the user approved it. The quote must still appear in
 * the document word for word; otherwise nothing is saved (no inferences as facts).
 */
export function rememberSourceFact(
  db: Db,
  dataDir: string,
  input: { file: string; fact: string; documentId: string; quote: string; run?: string },
  now = Date.now(),
): MemoryFile {
  const doc = db
    .prepare("select title, raw_text from documents where id = ?")
    .get(input.documentId) as { title: string; raw_text: string } | undefined;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!doc || !norm(doc.raw_text).includes(norm(input.quote)))
    throw new MemoryError(
      "UNSUPPORTED_QUOTE",
      "The quote isn't in the source any more, so the fact wasn't saved.",
    );
  const p: FactProvenance = {
    by: "source",
    doc: input.documentId,
    title: doc.title,
    quote: input.quote,
    at: now,
    ...(input.run ? { run: input.run } : {}),
  };
  appendFact(
    db,
    dataDir,
    input.file,
    factLine(input.fact, p),
    `Learned from "${doc.title}"`,
    "system",
    {
      documentId: input.documentId,
      ...(input.run ? { actionId: input.run } : {}),
    },
  );
  recordEvent(db, {
    kind: "memory",
    runId: input.run ?? null,
    at: now,
    change: "learned",
    text: input.fact,
    source: doc.title,
  });
  return readMemoryFile(dataDir, input.file);
}

/** Forget one fact (the history keeps it, so the screen can offer Undo). */
export function forgetFact(
  db: Db,
  dataDir: string,
  rel: string,
  index: number,
  now = Date.now(),
): MemoryFile {
  const p = checkPath(rel);
  const { content } = readMemoryContent(dataDir, p);
  let seen = -1;
  let removed = "";
  const lines = content.split(/\r?\n/).filter((l) => {
    if (!/^\s*[-*]\s+/.test(l)) return true;
    seen++;
    if (seen !== index) return true;
    removed = l;
    return false;
  });
  if (!removed) throw new MemoryError("NOT_FOUND", "That fact isn't in the file any more.");
  write(db, dataDir, p, lines.join("\n"), "Forgotten by you", "user");
  recordEvent(db, {
    kind: "memory",
    runId: null,
    at: now,
    change: "forgotten",
    text: parseFacts(removed)[0]?.text ?? removed,
  });
  return readMemoryFile(dataDir, p);
}

/** `rocky memory export`: the Markdown files, without the history. */
export function exportMemory(dataDir: string, target: string): string[] {
  const out: string[] = [];
  for (const f of listMemory(dataDir)) {
    const dest = path.join(target, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root(dataDir), f.path), dest);
    out.push(dest);
  }
  return out;
}
