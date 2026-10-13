// Chat and workspace (UI spec 5): saved history, the run card, the work pane, the failed-send
// state and the keyboard rules, each passing axe at 360, 768 and 1280 with no sideways scroll.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";
import { mockApi } from "./fixtures.ts";

const SHOTS = path.join(import.meta.dirname, "screenshots", "screens");
fs.mkdirSync(SHOTS, { recursive: true });

const CONV = "01JCHAT0000000000000000001";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const RESULT = {
  answer: [
    {
      i: 0,
      text: "The CloudHost contract renews on November 1.",
      status: "supported",
      citations: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Renewal",
          anchor: { kind: "text" },
          quote: "renews on November 1",
        },
      ],
    },
  ],
  notFound: false,
  closestMatches: [],
  path: { provider: "ollama", model: "rocky-qwen3.5-4b-16k", local: true, attempts: 1 },
  verifierPath: null,
  usage: { inputTokens: 900, outputTokens: 40, costUsd: 0 },
};

const sse = (events: [string, unknown][]) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

async function mockChat(page: Page, opts: { ask?: "ok" | "error" | "hang" } = {}) {
  const calls: string[] = [];
  await mockApi(page, "populated");
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace("/api/v1", "");
    const method = route.request().method();
    calls.push(`${method} ${p}`);
    if (p === `/conversations/${CONV}`)
      return json(route, {
        id: CONV,
        title: "When does the CloudHost contract renew?",
        scope: {},
        turns: 1,
        createdAt: 1,
        updatedAt: 1,
        history: [
          {
            id: "t1",
            question: "When does the CloudHost contract renew?",
            result: RESULT,
            createdAt: 1,
          },
        ],
      });
    if (p === "/conversations" && method === "POST") return json(route, { id: CONV }, 201);
    if (p === "/conversations")
      return json(route, {
        conversations: [
          {
            id: CONV,
            title: "When does the CloudHost contract renew?",
            scope: {},
            turns: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });
    if (p === "/suggestions")
      return json(route, {
        questions: ["What did we decide about pricing?", "What does Lena owe us?"],
      });
    if (p === "/sample") return json(route, { loaded: false, tour: [] });
    if (p === "/onboarding")
      return json(route, {
        step: 4,
        name: "Rocky",
        swatch: "periwinkle",
        preset: "ask-everything",
        completedAt: 1,
        firstRun: false,
      });
    if (p === "/ask") {
      if (opts.ask === "hang") return; // never answers: the run card stays up
      if (opts.ask === "error")
        return json(route, { error: "The store could not be read.", code: "INTERNAL" }, 500);
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          ["retrieval", { chunks: [{ id: "c1", docTitle: "Renewal", anchor: { kind: "text" } }] }],
          ["draft_sentence", { i: 0, text: RESULT.answer[0]?.text, citations: ["c1"] }],
          ["verified", { i: 0, status: "supported", quote: "renews on November 1" }],
          ["done", { result: RESULT }],
        ]),
      });
    }
    return route.fallback();
  });
  return calls;
}

async function check(page: Page, label: string, problems: string[]) {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  for (const v of axe.violations.filter((x) => x.impact === "serious" || x.impact === "critical"))
    problems.push(
      `${label}: ${v.id} — ${v.help} (${v.nodes
        .map((n) => n.target.join(" "))
        .slice(0, 2)
        .join(", ")})`,
    );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 1) problems.push(`${label}: scrolls horizontally by ${overflow}px`);
}

test("saved conversation, empty state, run card and failed send pass axe at three widths", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const problems: string[] = [];
  const shoot = async (name: string, width: number) => {
    await page.evaluate(() => document.fonts.ready);
    await check(page, `chat ${name} @${width}`, problems);
    await page.screenshot({ path: path.join(SHOTS, `chat-${name}--${width}.png`), fullPage: true });
  };
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });

    await page.unroute("**/api/v1/**");
    await mockChat(page);
    await page.goto(`/ask?c=${CONV}`);
    await expect(page.getByText("Every statement checked against its source")).toBeVisible();
    await expect(page.getByRole("button", { name: /cited 1 source/ })).toBeVisible();
    await shoot("populated", width);

    await page.goto("/ask");
    await expect(page.getByRole("heading", { name: "What do you want to know?" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "What did we decide about pricing?" }),
    ).toBeVisible();
    await shoot("empty", width);

    await page.unroute("**/api/v1/**");
    await mockChat(page, { ask: "hang" });
    await page.goto("/ask?q=When%20does%20it%20renew%3F");
    await expect(page.getByRole("button", { name: "Stop" }).first()).toBeVisible();
    await shoot("running", width);

    await page.unroute("**/api/v1/**");
    await mockChat(page, { ask: "error" });
    await page.goto("/ask?q=When%20does%20it%20renew%3F");
    await expect(page.getByText("Couldn't send.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible();
    await shoot("error", width);
  }
  expect(problems).toEqual([]);
});

test("a starter question creates the conversation, streams, and the work pane shows its steps", async ({
  page,
}) => {
  const calls = await mockChat(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/ask");
  await page.getByRole("button", { name: "What did we decide about pricing?" }).click();
  await expect(page.getByText("The CloudHost contract renews on November 1.")).toBeVisible();
  expect(calls).toContain("POST /conversations");
  await expect(page).toHaveURL(new RegExp(`c=${CONV}`));
  // The pane is open at this width; its steps are all done.
  await expect(page.getByRole("tab", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("Checked every statement · 1 supported")).toBeVisible();
  await page.getByRole("tab", { name: "Sources" }).click();
  await expect(page.getByRole("tabpanel").getByRole("button", { name: /Renewal/ })).toBeVisible();
});

test("keyboard: ↑ brings back the last question, Ctrl+. stops, Esc never stops", async ({
  page,
}) => {
  await mockChat(page, { ask: "hang" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/ask");
  const box = page.getByLabel("Ask about your work");
  await box.fill("When does it renew?");
  await box.press("Enter");
  await expect(page.getByText("Searching your sources")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Searching your sources")).toBeVisible();
  await page.keyboard.press("Control+.");
  await expect(page.getByText("Stopped before answering.")).toBeVisible();
  await box.focus();
  await box.press("ArrowUp");
  await expect(box).toHaveValue("When does it renew?");
});
