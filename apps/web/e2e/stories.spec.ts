// Every component story, in light and dark: no serious axe violations, controls at least 44px
// (dense ones keep a 44px hit area), no request leaves localhost, and a screenshot of the
// default, hover and focus states for review.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

interface StoryInfo {
  id: string;
  parameters: { states?: ("hover" | "focus")[]; layout?: "component" | "screen" };
}

const SHOTS = path.join(import.meta.dirname, "screenshots", "stories");
fs.mkdirSync(SHOTS, { recursive: true });

async function listStories(page: Page): Promise<StoryInfo[]> {
  await page.goto("/stories.html");
  return page.evaluate(() => (window as unknown as { __stories: StoryInfo[] }).__stories);
}

/** Fails the test on any request that is not to the local dev server. */
function noThirdParty(page: Page) {
  const offsite: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol !== "data:")
      offsite.push(r.url());
  });
  return offsite;
}

test("every story passes axe, keeps 44px targets, and makes no third-party request", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const stories = await listStories(page);
  expect(stories.length).toBeGreaterThan(0);
  const offsite = noThirdParty(page);
  const problems: string[] = [];
  for (const s of stories) {
    for (const theme of ["light", "dark"] as const) {
      await page.goto(`/stories.html?story=${s.id}&theme=${theme}`);
      await page.waitForSelector(`[data-story="${s.id}"]`);
      await page.evaluate(() => document.fonts.ready);
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      for (const v of axe.violations.filter(
        (x) => x.impact === "serious" || x.impact === "critical",
      ))
        problems.push(`${s.id} (${theme}): ${v.id} — ${v.help} [${v.nodes.length}]`);

      // 44px targets; a dense control may be smaller only if it carries the 44px hit-area class.
      const small = await page.$$eval(
        "button, [role='button'], input:not([type='hidden']), select, textarea, [role='tab'], [role='switch'], [role='checkbox'], [role='radio']",
        (els) =>
          els
            .filter((el) => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) return false;
              const dense = el.closest(".rk-button--dense, [data-hit44]");
              return !dense && (r.height < 44 || r.width < 24);
            })
            .map((el) => el.outerHTML.slice(0, 80)),
      );
      for (const el of small) problems.push(`${s.id} (${theme}): target under 44px: ${el}`);

      await page.screenshot({ path: path.join(SHOTS, `${s.id}--${theme}.png`), fullPage: true });
      const target = page.locator("button, a, input, [tabindex='0']").first();
      for (const state of s.parameters.states ?? []) {
        if (state === "hover") await target.hover();
        else {
          await page.mouse.move(0, 0);
          await page.keyboard.press("Tab");
        }
        await page.waitForTimeout(650); // tooltips appear after 500ms
        await page.screenshot({ path: path.join(SHOTS, `${s.id}--${theme}--${state}.png`) });
      }
    }
  }
  expect(problems).toEqual([]);
  expect(offsite).toEqual([]);
});
