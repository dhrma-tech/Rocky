import fs from "node:fs";
import path from "node:path";
import type { AuditRow } from "@rocky/contracts";
import { createNotebook, echoAction, memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { seedCitation } from "../../../packages/core/test/security/actions-helpers.ts";
import { runActions } from "../src/actions.ts";
import { micInput, parseDshowAudio } from "../src/record.ts";
import { findNotebook, runReview } from "../src/study.ts";
import { templatesCommand } from "../src/templates.ts";

let dir: string;
let rt: Runtime;
let echo: ReturnType<typeof echoAction>;

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  echo = echoAction();
  rt.registry.register(echo.def);
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Captures output; `answers` scripts the terminal (null = end of input). */
function io(answers: (string | null)[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      ask: async () => (answers.length ? (answers.shift() ?? null) : null),
    },
  };
}

const propose = () =>
  rt.actions.propose({
    type: "test.echo",
    payload: { message: "open a ticket" },
    origin: "user_turn",
    citations: [seedCitation(rt.db)],
  });

describe("rocky actions (acceptance #3: headless approval)", () => {
  it("approve --yes binds the hash shown, audits it, and run executes once", async () => {
    const a = propose();
    const t = io();
    expect(await runActions(rt, "approve", a.id, { yes: true }, t.io)).toBe(0);
    expect(t.out.join("\n")).toContain(`Payload hash: ${a.payloadHash}`);
    expect(t.out.join("\n")).toContain('"message": "open a ticket"');
    expect(rt.actions.get(a.id).status).toBe("approved");
    const audit = rt.db
      .prepare("select event_type as eventType, meta from audit_log where event_type = ?")
      .all("action_approved") as (Pick<AuditRow, "eventType"> & { meta: string })[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.meta ?? "{}")).toEqual({
      payloadHash: a.payloadHash,
      review: "standard",
    });

    expect(await runActions(rt, "run", a.id, {}, t.io)).toBe(0);
    expect(echo.calls).toHaveLength(1);
    expect(rt.actions.get(a.id).status).toBe("executed");
    // A second run does nothing: only approved actions run.
    await expect(runActions(rt, "run", a.id, {}, t.io)).rejects.toThrow();
    expect(echo.calls).toHaveLength(1);
  });

  it("refuses to approve without a terminal unless --yes is given", async () => {
    const a = propose();
    const t = io();
    expect(await runActions(rt, "approve", a.id, {}, t.io)).toBe(1);
    expect(t.err.join()).toContain("--yes");
    expect(rt.actions.get(a.id).status).toBe("draft");
  });

  it("asks on a terminal, and a no leaves the draft alone", async () => {
    const a = propose();
    const t = io();
    const code = await runActions(rt, "approve", a.id, {}, { ...t.io, confirm: async () => false });
    expect(code).toBe(1);
    expect(rt.actions.get(a.id).status).toBe("draft");
  });

  it("lists by status, resolves id prefixes, rejects", async () => {
    const a = propose();
    const t = io();
    await runActions(rt, "list", undefined, { status: "draft" }, t.io);
    expect(t.out.join()).toContain(a.id);
    expect(await runActions(rt, "reject", a.id.slice(0, 10), {}, t.io)).toBe(0);
    expect(rt.actions.get(a.id).status).toBe("rejected");
    expect(await runActions(rt, "list", undefined, { status: "bogus" }, t.io)).toBe(1);
  });
});

describe("rocky study", () => {
  it("reviews due cards with 1-4 ratings and finds notebooks by name", async () => {
    const nb = createNotebook(rt.db, { name: "Thermodynamics" });
    const ins = rt.db.prepare(
      "insert into cards (id, notebook_id, front, back) values (?, ?, ?, ?)",
    );
    ins.run("CARD1", nb.id, "First law?", "Energy is conserved.");
    ins.run("CARD2", nb.id, "Entropy of a closed system?", "Never decreases.");
    expect(findNotebook(rt, "thermo").id).toBe(nb.id);

    const t = io(["", "3", "", "x", "1"]);
    expect(await runReview(rt, nb.id, t.io)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("Q: First law?");
    expect(text).toContain("A: Energy is conserved.");
    expect(text).toContain("Reviewed 2 card(s).");
    const reviews = rt.db.prepare("select count(*) as n from card_reviews").get() as {
      n: number;
    };
    expect(reviews.n).toBe(2);
  });

  it("quits cleanly at end of input", async () => {
    const nb = createNotebook(rt.db, { name: "Chem" });
    rt.db
      .prepare("insert into cards (id, notebook_id, front, back) values ('C', ?, 'Q', 'A')")
      .run(nb.id);
    const t = io([]);
    expect(await runReview(rt, nb.id, t.io)).toBe(0);
    expect(rt.db.prepare("select count(*) as n from card_reviews").get()).toEqual({ n: 0 });
  });
});

describe("rocky templates", () => {
  it("ejects a pack into the override dir and keeps edited files", () => {
    const t = io();
    expect(templatesCommand("eject", "student", { dataDir: dir }, t.io)).toBe(0);
    const pack = path.join(dir, "templates", "student", "pack.yaml");
    expect(fs.existsSync(pack)).toBe(true);
    fs.writeFileSync(pack, "name: Mine\nsegment: student\ndescription: edited\n");
    templatesCommand("eject", "student", { dataDir: dir }, t.io);
    expect(fs.readFileSync(pack, "utf8")).toContain("edited");
    expect(t.out.at(-2)).toContain("kept 1");
    templatesCommand("list", undefined, { dataDir: dir }, t.io);
    expect(t.out.join("\n")).toContain("student (customized): Mine");
    expect(templatesCommand("eject", "../etc", { dataDir: dir }, t.io)).toBe(1);
  });
});

describe("rocky record helpers", () => {
  it("parses dshow audio devices and builds per-OS inputs", () => {
    const stderr = [
      '[in#0 @ 0] "HD Camera" (video)',
      '[in#0 @ 0] "Microphone (Realtek(R) Audio)" (audio)',
      '[in#0 @ 0]   Alternative name "@device_cm_{X}\\wave_{Y}"',
      '[in#0 @ 0] "Headset (USB)" (audio)',
    ].join("\r\n");
    expect(parseDshowAudio(stderr)).toEqual(["Microphone (Realtek(R) Audio)", "Headset (USB)"]);
    expect(micInput("win32", "Headset (USB)")).toEqual([
      "-f",
      "dshow",
      "-i",
      "audio=Headset (USB)",
    ]);
    expect(micInput("darwin", "0")).toEqual(["-f", "avfoundation", "-i", ":0"]);
    expect(micInput("linux", "default")).toEqual(["-f", "pulse", "-i", "default"]);
  });
});
