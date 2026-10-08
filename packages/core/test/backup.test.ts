// Roadmap I3: one backup a day, the newest 7 kept, never a half-written file under today's name.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dailyBackup, eventsAfter, KEEP_DAILY, openDb } from "../src/index.ts";
import { migrate } from "../src/store/migrate.ts";
import { tempDir } from "./helpers.ts";

const DAY = 86_400_000;

describe("dailyBackup", () => {
  it("makes one copy per day, keeps the newest 7, and records a receipt", () => {
    const dir = tempDir();
    const db = openDb(path.join(dir, "rocky.db"));
    try {
      migrate(db);
      db.prepare(
        'insert into events (at, kind, run_id, payload) values (1, \'message\', null, \'{"role":"user","text":"keep me"}\')',
      ).run();
      const t0 = Date.UTC(2026, 9, 1, 12);
      const first = dailyBackup(db, path.join(dir, "backups"), t0);
      expect(path.basename(first.created ?? "")).toBe("rocky-2026-10-01.db");
      // A second call the same day does nothing.
      expect(dailyBackup(db, path.join(dir, "backups"), t0 + 3_600_000).created).toBeNull();
      for (let d = 1; d <= 8; d++) dailyBackup(db, path.join(dir, "backups"), t0 + d * DAY);
      const files = fs.readdirSync(path.join(dir, "backups", "daily")).sort();
      expect(files).toHaveLength(KEEP_DAILY);
      expect(files[0]).toBe("rocky-2026-10-03.db");
      expect(files.some((f) => f.endsWith(".partial"))).toBe(false);
      // The copy is a working database with the data in it.
      const copy = openDb(path.join(dir, "backups", "daily", files.at(-1) as string), {
        readonly: true,
      });
      expect(
        (
          copy.prepare("select count(*) as n from events where kind = 'message'").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
      copy.close();
      const receipts = eventsAfter(db, 0).filter((e) => e.kind === "receipt");
      expect(receipts).toHaveLength(9);
      expect(receipts[0]).toMatchObject({
        verb: "backed up the store",
        notDone: "kept the newest 7",
      });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
