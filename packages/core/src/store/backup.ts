import fs from "node:fs";
import path from "node:path";
import { recordEvent } from "../events/log.ts";
import type { Db } from "./db.ts";

/**
 * Daily backups (roadmap I3): one `VACUUM INTO` copy per calendar day in <backups>/daily, the
 * newest 7 kept. A copy of an encrypted store is encrypted with the same key (spike:
 * sqlcipher.test.ts). Missed days are not back-filled: after sleep, the next check makes today's.
 */

export const KEEP_DAILY = 7;
const NAME = /^rocky-(\d{4}-\d{2}-\d{2})\.db$/;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function dailyBackup(
  db: Db,
  backupsDir: string,
  now = Date.now(),
): { created: string | null; removed: string[] } {
  const dir = path.join(backupsDir, "daily");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `rocky-${day(now)}.db`);
  let created: string | null = null;
  if (!fs.existsSync(target)) {
    // Write to a temp name first so a crash never leaves a half file under today's name.
    const tmp = `${target}.partial`;
    fs.rmSync(tmp, { force: true });
    db.prepare("VACUUM INTO ?").run(tmp);
    fs.renameSync(tmp, target);
    created = target;
  }
  const all = fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort();
  const removed = all.slice(0, Math.max(0, all.length - KEEP_DAILY));
  for (const f of removed) fs.rmSync(path.join(dir, f));
  if (created)
    recordEvent(db, {
      kind: "receipt",
      runId: null,
      at: now,
      tool: "Rocky",
      verb: "backed up the store",
      count: 1,
      unit: "copy",
      notDone: `kept the newest ${KEEP_DAILY}`,
      subject: { type: "backup", id: path.basename(created) },
    });
  return { created, removed };
}
