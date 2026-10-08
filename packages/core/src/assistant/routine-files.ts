import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RoutineInputSchema } from "@rocky/contracts";
import { ulid } from "ulid";
import YAML from "yaml";
import { z } from "zod";
import type { Db } from "../store/db.ts";
import { getRoutine, validCron } from "./routines.ts";

/**
 * Routines as files (roadmap A6): one folder per routine, so a routine can be read, edited in any
 * editor, kept in git and shared by copying the folder.
 *
 *   <data>/routines/<name>/ROUTINE.md
 *   ---
 *   name: Monday plan
 *   schedule: "0 8 * * 1"        # cron, in the machine's time zone
 *   inputs: [week_meetings, commitments_due_7d]
 *   enabled: false
 *   ---
 *   Plan my week from these meetings and commitments. Cite every point.
 *
 * The file is the source of truth: it is read again on every scheduler tick. A routine still only
 * writes a cited summary; it never acts without approval. The format is Rocky's own; it makes no
 * claim to match other agent tools' skill folders (docs/DECISIONS.md D-046).
 */

export const ROUTINE_FILE = "ROUTINE.md";
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

const FrontSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    schedule: z.string().refine(validCron, 'a cron schedule such as "0 8 * * 1"'),
    inputs: z.array(RoutineInputSchema).min(1).max(7),
    enabled: z.boolean().default(false),
  })
  .strict();

export const routinesDir = (dataDir: string) => path.join(dataDir, "routines");

export interface RoutineFileResult {
  slug: string;
  file: string;
  ok: boolean;
  error?: string;
}

export function parseRoutineFile(text: string): {
  front: z.infer<typeof FrontSchema>;
  prompt: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("ROUTINE.md starts with a --- block (name, schedule, inputs).");
  const front = FrontSchema.safeParse(YAML.parse(m[1] ?? "") ?? {});
  if (!front.success) throw new Error(z.prettifyError(front.error));
  const prompt = (m[2] ?? "").trim();
  if (!prompt) throw new Error("ROUTINE.md needs a prompt below the --- block.");
  return { front: front.data, prompt };
}

/**
 * Brings the routines table in line with the folders: new folders are added, changed files update
 * their routine, removed folders remove it. A broken file is reported and left out, never guessed.
 */
export function syncRoutineFiles(db: Db, dataDir: string, now = Date.now()): RoutineFileResult[] {
  const dir = routinesDir(dataDir);
  const results: RoutineFileResult[] = [];
  const present = new Set<string>();
  if (fs.existsSync(dir))
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !SLUG.test(e.name)) continue;
      const file = path.join(dir, e.name, ROUTINE_FILE);
      if (!fs.existsSync(file)) continue;
      present.add(e.name);
      try {
        const text = fs.readFileSync(file, "utf8");
        const hash = createHash("sha256").update(text).digest("hex");
        const { front, prompt } = parseRoutineFile(text);
        const existing = db
          .prepare("select id, params from routines where pack = 'file' and template = ?")
          .get(e.name) as { id: string; params: string } | undefined;
        // An unchanged file changes nothing, so a pause from the screen (or auto-pause) holds.
        const seen = existing
          ? (JSON.parse(existing.params || "{}") as { fileHash?: string }).fileHash
          : undefined;
        const params = JSON.stringify({ fileHash: hash });
        if (existing && seen !== hash)
          db.prepare(
            "update routines set name = ?, schedule_cron = ?, inputs = ?, prompt = ?, enabled = ?, params = ? where id = ?",
          ).run(
            front.name,
            front.schedule,
            JSON.stringify(front.inputs),
            prompt,
            front.enabled ? 1 : 0,
            params,
            existing.id,
          );
        if (!existing)
          db.prepare(
            `insert into routines (id, name, schedule_cron, enabled, pack, template, inputs, prompt, params, created_at, last_run_at)
             values (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`,
          ).run(
            ulid(now),
            front.name,
            front.schedule,
            front.enabled ? 1 : 0,
            e.name,
            JSON.stringify(front.inputs),
            prompt,
            params,
            now,
            now,
          );
        results.push({ slug: e.name, file, ok: true });
      } catch (err) {
        results.push({
          slug: e.name,
          file,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  const gone = (
    db.prepare("select id, template from routines where pack = 'file'").all() as {
      id: string;
      template: string;
    }[]
  ).filter((r) => !present.has(r.template));
  for (const r of gone) db.prepare("delete from routines where id = ?").run(r.id);
  return results;
}

/** Writes a routine (any kind) as a folder, to share or to edit as a file. */
export function exportRoutine(
  db: Db,
  id: string,
  target: string,
  opts: { dataDir?: string } = {},
): string {
  const r = getRoutine(db, id, opts);
  const slug =
    r.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "routine";
  const folder = path.join(target, slug);
  fs.mkdirSync(folder, { recursive: true });
  const front = YAML.stringify({
    name: r.name,
    schedule: r.schedule,
    inputs: r.inputs,
    enabled: false,
  });
  const file = path.join(folder, ROUTINE_FILE);
  fs.writeFileSync(file, `---\n${front}---\n${r.prompt.trim()}\n`);
  return file;
}
