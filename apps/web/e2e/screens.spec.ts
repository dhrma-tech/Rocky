// UI spec "Screens ... Done when": each screen in its loading, empty, error and populated states at
// 360, 768 and 1280px, with no serious axe issue, no horizontal scroll, and a screenshot each.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { DRAFTS, mockApi, type Scenario } from "./fixtures.ts";

const SHOTS = path.join(import.meta.dirname, "screenshots", "screens");
fs.mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [360, 768, 1280] as const;
const SCREENS: { name: string; url: string; ready: (s: Scenario) => string }[] = [
  {
    name: "today",
    url: "/",
    ready: (s) =>
      s === "populated" ? "text=Needs you" : s === "empty" ? "text=Nothing needs you." : "h1",
  },
  {
    name: "approvals",
    url: "/approvals",
    ready: (s) =>
      s === "populated"
        ? "text=Draft an email to dana@acme.dev"
        : s === "empty"
          ? "text=Nothing is waiting."
          : s === "error"
            ? "text=Couldn't load the approvals."
            : "h1",
  },
  {
    name: "ledger",
    url: "/ledger",
    ready: (s) =>
      s === "populated"
        ? "text=Gmail → synced 12 items"
        : s === "empty"
          ? "text=No activity yet."
          : "h1",
  },
  {
    name: "tasks",
    url: "/tasks",
    ready: (s) =>
      s === "populated"
        ? "text=Transcribing a recording"
        : s === "empty"
          ? "text=No tasks yet."
          : "h1",
  },
  {
    name: "run",
    url: "/runs/job2",
    ready: (s) =>
      s === "populated" ? "text=What Rocky tried:" : "h1, [role=alert], [role=status]",
  },
];
const SCENARIOS: Scenario[] = ["populated", "empty", "loading", "error"];

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
  // The page and the main scroll area: neither may scroll sideways.
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".rk-main");
    return Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      main ? main.scrollWidth - main.clientWidth : 0,
    );
  });
  if (overflow > 1) problems.push(`${label}: scrolls horizontally by ${overflow}px`);
}

for (const screen of SCREENS)
  test(`${screen.name}: four states at three widths`, async ({ page }) => {
    test.setTimeout(5 * 60_000);
    const problems: string[] = [];
    for (const scenario of SCENARIOS) {
      await page.unroute("**/api/v1/**");
      await mockApi(page, scenario);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(screen.url);
        await page.waitForSelector(screen.ready(scenario));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(150);
        const label = `${screen.name} ${scenario} @${width}`;
        await check(page, label, problems);
        await page.screenshot({
          path: path.join(SHOTS, `${screen.name}--${scenario}--${width}.png`),
          fullPage: true,
        });
      }
    }
    expect(problems).toEqual([]);
  });

test("engine down: a banner with Retry, and the page below is read-only", async ({ page }) => {
  await mockApi(page, "engine-down");
  await page.goto("/");
  await expect(page.getByText("Rocky's engine isn't responding.")).toBeVisible();
  await expect(page.locator(".rk-main__content")).toHaveAttribute("inert", "");
  await page.screenshot({ path: path.join(SHOTS, "today--engine-down--1280.png") });
});

test("keyboard only: skip link, queue with J/K, and Enter never approves", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/approvals");
  await page.waitForSelector("text=Draft an email to dana@acme.dev");
  // The first Tab lands on the skip link, which jumps to the main content.
  await page.keyboard.press("Tab");
  await expect(page.getByText("Skip to content")).toBeFocused();
  await page.keyboard.press("Enter");
  // J moves to the next item in the queue; Enter on a queue row only selects it.
  const rows = page.locator(".rk-queue__row");
  await rows.first().focus();
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.press("k");
  await expect(rows.first()).toBeFocused();
  expect(posts.filter((p) => p.includes("/approve"))).toEqual([]);
  // The strict-review item can't be approved until its sources are acknowledged.
  const strict = DRAFTS[1];
  await page.getByRole("button", { name: /Draft an email to dana@acme.dev/ }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await page.getByLabel("I checked where this came from").check();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  expect(strict?.review).toBe("strict");
});
