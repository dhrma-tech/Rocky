// Onboarding (UI spec 3): a fresh install lands here, each step passes axe at 360 and 1280 with
// no sideways scroll, progress is saved per step, and a failed key test explains the cause.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";
import { mockApi } from "./fixtures.ts";

const SHOTS = path.join(import.meta.dirname, "screenshots", "screens");
fs.mkdirSync(SHOTS, { recursive: true });

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const NO_LOCAL = {
  ollama: false,
  hardware: { ramGb: 15.7, cuda: false, cores: 8 },
  current: { small: null, medium: null },
  speed: null,
  models: [],
  small: null,
  medium: null,
  note: "Ollama isn't running, so Rocky can't see which models are installed.",
};

/** Stateful /onboarding on top of the shared mocks; returns the PATCH bodies it saw. */
async function mockOnboarding(
  page: Page,
  opts: { local?: boolean | "ollama-empty"; keyTest?: unknown } = {},
): Promise<Record<string, unknown>[]> {
  const patches: Record<string, unknown>[] = [];
  let state: Record<string, unknown> = {
    step: 1,
    name: "Rocky",
    swatch: "periwinkle",
    preset: "ask-everything",
    readOnlyRuleId: null,
    completedAt: null,
    firstRun: true,
  };
  await mockApi(page, "populated");
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace("/api/v1", "");
    const method = route.request().method();
    if (p === "/onboarding" && method === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      state = { ...state, ...body };
      if (body.complete) state = { ...state, completedAt: 1, firstRun: false };
      return json(route, state);
    }
    if (p === "/onboarding") return json(route, state);
    if (p === "/onboarding/test-key")
      return json(route, opts.keyTest ?? { ok: true, model: "claude-haiku-4-5", ms: 800 });
    if (p === "/models" && opts.local === false) return json(route, NO_LOCAL);
    if (p === "/models" && opts.local === "ollama-empty")
      return json(route, {
        ...NO_LOCAL,
        ollama: true,
        starter: { pull: "qwen3.5:4b", use: "rocky-qwen3.5-4b-16k" },
      });
    if (p === "/models/pull")
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          'event: progress\ndata: {"model":"qwen3.5:4b","status":"pulling","total":100,"completed":50}\n\n' +
          'event: done\ndata: {"result":{"model":"rocky-qwen3.5-4b-16k"}}\n\n',
      });
    if (p === "/sample")
      return json(route, {
        loaded: false,
        tour: [
          { question: "What did we decide about the subscription price?", expect: "18 EUR." },
          { question: "When will Lena send the checkout mockups?", expect: "By Monday." },
          { question: "What is our marketing budget for Japan?", expect: "Not found." },
        ],
      });
    if (p === "/suggestions") return json(route, { questions: [] });
    if (p === "/watched-folders")
      return json(route, { error: "Not a folder: C:\\nope", code: "BAD_REQUEST" }, 400);
    return route.fallback();
  });
  return patches;
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

const continueBtn = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });

test("a fresh install lands in onboarding; every step passes axe at 360 and 1280", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);
  const problems: string[] = [];
  for (const width of [360, 1280]) {
    await page.unroute("**/api/v1/**");
    const patches = await mockOnboarding(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome$/);
    const shot = async (n: number) => {
      await page.evaluate(() => document.fonts.ready);
      await check(page, `onboarding step ${n} @${width}`, problems);
      await page.screenshot({
        path: path.join(SHOTS, `onboarding-${n}--${width}.png`),
        fullPage: true,
      });
    };

    await expect(page.getByRole("heading", { name: "Name your Rocky" })).toBeFocused();
    await page.getByLabel("Name", { exact: true }).fill("Pip");
    await page.getByRole("radio", { name: "Sage" }).check();
    await expect(page.getByRole("img", { name: "Pip, in sage" })).toBeVisible();
    await shot(1);
    await continueBtn(page).click();

    await expect(page.getByRole("heading", { name: "Choose a model" })).toBeVisible();
    await expect(page.getByText("A model on this computer: qwen3:4b")).toBeVisible();
    await shot(2);
    await continueBtn(page).click();

    await expect(page.getByRole("heading", { name: "Choose what Pip may touch" })).toBeVisible();
    await page.getByRole("radio", { name: /Read only/ }).check();
    await expect(
      page.getByText("Pip can read only what you import and won't change anything"),
    ).toBeVisible();
    await expect(page.getByLabel("Use a browser (not available yet)")).toBeDisabled();
    await shot(3);
    await continueBtn(page).click();

    await expect(page.getByRole("heading", { name: "Start a first task" })).toBeVisible();
    await shot(4);
    await page.getByRole("button", { name: "Start first task" }).click();
    await expect(page).toHaveURL(/\/ask\?q=What/);

    expect(patches).toEqual([
      { name: "Pip", swatch: "sage", step: 2 },
      { step: 3 },
      { preset: "read-only", step: 4 },
      { complete: true },
    ]);
  }
  expect(problems).toEqual([]);
});

test("no local model: the API key leads, and a failed test names the cause and keeps the key", async ({
  page,
}) => {
  await mockOnboarding(page, {
    local: false,
    keyTest: { ok: false, reason: "key-invalid", message: "The provider didn't accept that key." },
  });
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByText("Ollama isn't running on this computer.")).toBeVisible();
  const key = page.getByLabel(/Anthropic API key/);
  await key.fill("sk-wrong");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("The provider didn't accept that key.")).toBeVisible();
  await expect(key).toHaveValue("sk-wrong");
  await expect(continueBtn(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue without a model" })).toBeVisible();
});

test("a folder that isn't there keeps the step and says why", async ({ page }) => {
  await mockOnboarding(page);
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await continueBtn(page).click();
  await page.getByLabel("Read a folder on this computer").check();
  await page.getByLabel("Folder path").fill("C:\\nope");
  await expect(
    page.getByText("Rocky can read files in C:\\nope and asks before changing anything."),
  ).toBeVisible();
  await continueBtn(page).click();
  await expect(page.getByText("Not a folder: C:\\nope")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose what Rocky may touch" })).toBeVisible();
});

test("Ollama with no model: download the one sized for this computer", async ({ page }) => {
  await mockOnboarding(page, { local: "ollama-empty" });
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByText(/Rocky suggests/)).toBeVisible();
  await page.getByRole("button", { name: "Download qwen3.5:4b" }).click();
  await expect(page.getByText("Rocky now answers with rocky-qwen3.5-4b-16k.")).toBeVisible();
});
