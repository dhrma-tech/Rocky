import { createHttp } from "@rocky/connector-sdk";
import { type Exchange, memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { blockText, notion, propertyLines } from "../src/notion/index.ts";

// Hand-built from developers.notion.com shapes (Notion-Version 2026-03-11); to be replaced by
// scrubbed recordings from a real workspace (acceptance #1).
const API = "https://api.notion.com/v1";
const rt = (t: string) => [{ plain_text: t }];
const page = (id: string, edited: string, extra: Record<string, unknown> = {}) => ({
  object: "page",
  id,
  url: `https://www.notion.so/${id.replace(/-/g, "")}`,
  created_time: "2026-08-01T00:00:00.000Z",
  last_edited_time: edited,
  in_trash: false,
  parent: { type: "workspace", workspace: true },
  properties: { Name: { type: "title", title: rt(`Page ${id}`) } },
  ...extra,
});
const block = (id: string, type: string, text: string, has_children = false) => ({
  id,
  type,
  has_children,
  [type]: { rich_text: rt(text) },
});
const search = (results: unknown[], next: string | null = null) => ({
  results,
  next_cursor: next,
  has_more: next !== null,
  request_status: { type: "complete" },
});
const S = (body: unknown): Exchange => ({ method: "POST", url: `${API}/search`, body });
const kids = (id: string, results: unknown[]): Exchange => ({
  url: `${API}/blocks/${id}/children?page_size=100`,
  body: { results, next_cursor: null, has_more: false },
});
const config = { sweepDays: 7 };
const secrets = () => memorySecrets({ token: "ntn_x" });

describe("Notion connector", () => {
  it("syncs pages into heading-grouped units with block anchors, and rows with their properties", async () => {
    const row = page("row-1", "2026-09-02T00:00:00.000Z", {
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties: {
        Name: { type: "title", title: rt("Exam: Linear algebra") },
        Date: { type: "date", date: { start: "2026-11-03" } },
        Status: { type: "status", status: { name: "Planned" } },
      },
    });
    const r = replay([
      S(search([page("p-1", "2026-09-03T00:00:00.000Z"), row])),
      kids("p-1", [
        block("b-1", "paragraph", "Intro line."),
        block("b-2", "heading_2", "Decisions"),
        block("b-3", "to_do", "Ship the beta", false),
        block("b-4", "bulleted_list_item", "Pricing", true),
      ]),
      kids("b-4", [block("b-5", "paragraph", "We drop the free tier.")]),
      kids("row-1", []),
    ]);
    const res = await runSync(notion, { fetch: r.fetch, config, secrets: secrets() });
    expect(r.unused()).toEqual([]);
    const [p1, r1] = res.documents;
    if (p1?.body.kind !== "text" || r1?.body.kind !== "text")
      throw new Error("text bodies expected");
    expect(p1.body.units?.map((u) => [u.anchor, u.text])).toEqual([
      [{ kind: "notion_block", blockId: "b-1", pageId: "p-1" }, "Intro line."],
      [
        { kind: "notion_block", blockId: "b-2", pageId: "p-1" },
        "## Decisions\n- [ ] Ship the beta\n- Pricing\n  We drop the free tier.",
      ],
    ]);
    expect(r1.body.units).toEqual([
      { anchor: { kind: "row", rowId: "row-1" }, text: "Date: 2026-11-03\nStatus: Planned" },
    ]);
    expect(r1.title).toBe("Exam: Linear algebra");
    expect(r1.meta).toMatchObject({
      kind: "row",
      dataSourceId: "ds-1",
      dates: [{ name: "Date", start: "2026-11-03", end: null }],
    });
    expect(p1.meta).not.toHaveProperty("dates");
    // First sync is a sweep: the full id list lets the core drop unshared pages.
    expect(res.batches.at(-1)).toMatchObject({ presentExternalIds: ["p-1", "row-1"] });
    expect(res.cursor).toMatchObject({ lastEdited: "2026-09-03T00:00:00.000Z" });
  });

  it("an incremental sync stops at the cursor and only fetches changed pages (acceptance #2)", async () => {
    const r = replay([
      S(
        search(
          [page("p-2", "2026-09-10T00:00:00.000Z"), page("p-1", "2026-09-03T00:00:00.000Z")],
          "next",
        ),
      ),
      kids("p-2", [block("x", "paragraph", "New page")]),
    ]);
    const res = await runSync(notion, {
      fetch: r.fetch,
      config,
      secrets: secrets(),
      cursor: { lastEdited: "2026-09-05T00:00:00.000Z", lastSweep: Date.now() },
    });
    expect(res.documents.map((d) => d.externalId)).toEqual(["p-2"]);
    expect(res.requests).toBe(2); // one search page (stopped at the cursor), one block fetch
    expect(res.cursor).toMatchObject({ lastEdited: "2026-09-10T00:00:00.000Z" });
    expect(res.batches.some((b) => b.presentExternalIds)).toBe(false);
  });

  it("turns trashed pages into tombstones", async () => {
    const r = replay([S(search([page("p-9", "2026-09-10T00:00:00.000Z", { in_trash: true })]))]);
    const res = await runSync(notion, {
      fetch: r.fetch,
      config,
      secrets: secrets(),
      cursor: { lastEdited: "2026-09-01T00:00:00.000Z", lastSweep: Date.now() },
    });
    expect(res.deleted).toEqual(["p-9"]);
  });

  it("maps a rejected token to auth expired, and health warns when nothing is shared", async () => {
    const r = replay([
      { method: "POST", url: `${API}/search`, status: 401, body: { code: "unauthorized" } },
    ]);
    await expect(
      runSync(notion, { fetch: r.fetch, config, secrets: secrets() }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const h = replay([
      {
        url: `${API}/users/me`,
        body: { name: "Rocky", bot: { workspace_name: "Dharma's Notion" } },
      },
      S(search([])),
    ]);
    expect(
      await notion.health({ config, http: createHttp({ fetch: h.fetch }), secrets: secrets() }),
    ).toMatchObject({
      status: "degraded",
      message: expect.stringMatching(/no pages are shared/),
    });
  });

  it("renders block types and row properties as text", () => {
    expect(
      blockText({
        id: "c",
        type: "code",
        has_children: false,
        code: { rich_text: rt("x = 1"), language: "python" },
      }),
    ).toBe("```python\nx = 1\n```");
    expect(blockText({ id: "d", type: "divider", has_children: false, divider: {} })).toBeNull();
    expect(
      propertyLines({
        object: "page",
        id: "r",
        url: "",
        created_time: "",
        last_edited_time: "",
        parent: { type: "data_source_id" },
        properties: {
          Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
          Done: { type: "checkbox", checkbox: true },
        },
      }),
    ).toEqual(["Tags: a, b", "Done: yes"]);
  });
});
