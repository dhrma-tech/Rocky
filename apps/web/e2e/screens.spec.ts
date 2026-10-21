// UI spec "Screens ... Done when": each screen in its loading, empty, error and populated states at
// 360, 768 and 1280px, with no serious axe issue, no horizontal scroll, and a screenshot each.
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { DRAFTS, mockApi, type Scenario } from "./fixtures.ts";

// Transitions finish at once, so axe never measures a tooltip halfway through its fade.
test.use({ contextOptions: { reducedMotion: "reduce" } });

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
SCREENS.push(
  {
    name: "memory",
    url: "/memory",
    ready: (s) =>
      s === "populated"
        ? "text=Learned this week"
        : s === "empty"
          ? "text=Nothing remembered yet."
          : "h1",
  },
  {
    name: "projects",
    url: "/projects",
    ready: (s) =>
      s === "populated"
        ? "text=This folder moved or was deleted"
        : s === "empty"
          ? "text=Pick a folder to start."
          : "h1",
  },
  {
    name: "project",
    url: "/projects/p2",
    ready: (s) =>
      s === "populated" ? "text=Locate the folder" : "h1, [role=alert], [role=status]",
  },
  {
    name: "integrations",
    url: "/connectors",
    ready: (s) =>
      s === "populated"
        ? "text=Needs attention"
        : s === "empty"
          ? "text=No tools connected."
          : s === "error"
            ? "text=Couldn't read your integrations."
            : "h1",
  },
  {
    name: "files",
    url: "/files",
    ready: (s) =>
      s === "populated"
        ? "text=pricing-notes.md"
        : s === "empty"
          ? "text=Rocky hasn't touched any files."
          : s === "error"
            ? "text=Couldn't read the file list."
            : "h1",
  },
  {
    name: "profile",
    url: "/profile",
    ready: (s) => (s === "loading" ? "h1" : "text=Your name"),
  },
  {
    name: "help",
    url: "/help",
    ready: () => "text=Common problems",
  },
  {
    name: "history",
    url: "/tasks/history",
    ready: (s) =>
      s === "populated"
        ? "text=Routine: Monday brief"
        : s === "empty"
          ? "text=No tasks yet."
          : s === "error"
            ? "text=Couldn't read the history."
            : "h1",
  },
  {
    name: "background",
    url: "/tasks/background",
    ready: (s) =>
      s === "populated"
        ? "text=Paused after failing"
        : s === "empty"
          ? "text=Nothing runs while you're away."
          : s === "error"
            ? "text=Couldn't read your routines."
            : "h1",
  },
  {
    name: "settings",
    url: "/settings",
    ready: () => "text=Search settings",
  },
  {
    name: "notifications",
    url: "/notifications?tab=all",
    // Every tab panel stays mounted; wait in the one that shows.
    ready: (s) =>
      s === "loading"
        ? "h1"
        : `[role=tabpanel]:not([hidden]) >> text=${
            s === "populated"
              ? "Routine: Morning brief finished."
              : s === "empty"
                ? "You're caught up."
                : "Notifications didn't load."
          }`,
  },
  {
    name: "pair",
    url: "/pair",
    ready: () => "text=Pairing code",
  },
  {
    name: "notification-preferences",
    url: "/notifications?tab=preferences",
    ready: () => "text=What reaches you where",
  },
);
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

test("settings: every category passes axe at 360 and 1280", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const problems: string[] = [];
  await mockApi(page, "populated");
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of [
      "Permissions and rules",
      "Model",
      "Memory",
      "Privacy and data",
      "Appearance",
      "Advanced",
      "About",
    ]) {
      await page.goto("/settings");
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
      await page.waitForTimeout(150);
      const slug = name.split(" ")[0]?.toLowerCase();
      await check(page, `settings ${slug} @${width}`, problems);
      await page.screenshot({
        path: path.join(SHOTS, `settings-${slug}--${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.goto("/settings");
  await page.getByRole("button", { name: "Permissions and rules", exact: true }).click();
  await expect(page.getByText("Rocky never deletes anything in Gmail.")).toBeVisible();
  // Safety comes second, right under General.
  await expect(page.locator("nav[aria-label='Settings categories'] li").nth(1)).toHaveText(
    "Permissions and rules",
  );
  expect(problems).toEqual([]);
});

test("background: a self-paused routine is on top, and Pause all asks first and can be undone", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") posts.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/routines");
  await expect(page).toHaveURL(/\/tasks\/background$/);
  const stuck = page.getByRole("region", { name: "Paused after failing" });
  await expect(stuck.getByText("Failed 3 times in a row, so Rocky paused it.")).toBeVisible();
  await expect(stuck.getByText(/Ollama is not running/)).toBeVisible();
  await expect(stuck.getByRole("button", { name: "Fix: Deadline digest" })).toBeVisible();
  await expect(
    page.getByText(/Last 4 runs, newest last: done, failed, done, done\./),
  ).toBeAttached();

  await page.getByRole("button", { name: "Pause all" }).click();
  await expect(page.getByRole("dialog", { name: "Pause every routine?" })).toBeVisible();
  expect(posts).toEqual([]);
  await page.getByRole("dialog").getByRole("button", { name: "Pause all" }).click();
  await expect(page.getByText("Paused 1 routine.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(() => posts)
    .toEqual(["POST /api/v1/routines/pause-all", "PATCH /api/v1/routines/r1"]);
});

test("history: J/K and Enter open a run, a routine re-runs, archive has Undo", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tasks/history");
  await page.waitForSelector("text=Routine: Monday brief");
  // Only the routine's run can run again.
  await expect(page.getByRole("button", { name: /^Re-run:/ })).toHaveCount(1);
  await page.getByRole("button", { name: "Re-run: Routine: Monday brief" }).click();
  await expect(page.getByText("Routine: Monday brief is queued again.")).toBeVisible();
  await page.getByRole("button", { name: "Archive: Syncing Gmail" }).click();
  await expect(page.getByText("Archived 1 run.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(() => writes)
    .toEqual([
      "POST /api/v1/routines/r1/run",
      "POST /api/v1/runs/archive",
      "POST /api/v1/runs/unarchive",
    ]);
  await page.locator("body").click({ position: { x: 5, y: 890 } });
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator("tr[data-run]").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runs\//);
});

test("command palette: Ctrl+K, type, Enter; recent first; settings deep link; passes axe", async ({
  page,
}) => {
  await mockApi(page, "populated");
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.waitForSelector("h1");
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox", { name: "Search commands" });
    await expect(box).toBeFocused();
    const problems: string[] = [];
    await check(page, `palette @${width}`, problems);
    expect(problems).toEqual([]);
    await page.screenshot({ path: path.join(SHOTS, `palette--${width}.png`) });
    await box.fill("hist");
    await expect(page.getByRole("option", { name: "Task history" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tasks\/history$/);
  }
  // The last command comes first next time.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("group", { name: "Recent" })).toContainText("Task history");
  await page.getByRole("combobox", { name: "Search commands" }).fill("model ollama");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\?section=model$/);
  await expect(page.getByRole("region", { name: "Model" })).toBeVisible();
  // Escape closes without running anything.
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
});

test("help: search, an article, diagnostics, shortcuts with ?, F1 from anywhere", async ({
  page,
}) => {
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.waitForSelector("h1");
  await page.keyboard.press("F1");
  await expect(page).toHaveURL(/\/help$/);
  await page.getByLabel("Search help").fill("ollama");
  await page.getByRole("link", { name: /Answers are slow or no model is found/ }).click();
  await expect(page).toHaveURL(/\/help\?a=model$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Answers are slow or no model is found",
  );
  await page.getByRole("button", { name: "Run diagnostics" }).click();
  await expect(page.getByRole("heading", { name: "Something needs attention" })).toBeVisible();
  // Failures first, with the fix.
  await expect(page.locator(".rk-help__checks > li").first()).toContainText("Ollama");
  await expect(page.getByText("Install it from ollama.com/download and start it.")).toBeVisible();
  // The issue link carries the checks with the user's name taken out, and only opens GitHub.
  const href =
    (await page.getByRole("link", { name: "Report an issue" }).getAttribute("href")) ?? "";
  const body = new URL(href).searchParams.get("body") ?? "";
  expect(href.startsWith("https://github.com/dhrma-tech/Rocky/issues/new?")).toBe(true);
  expect(body).toContain("FAIL Ollama");
  expect(body).not.toContain("dana");
  const problems: string[] = [];
  await check(page, "help article", problems);
  await page.locator("body").click({ position: { x: 600, y: 890 } });
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.getByLabel("Search shortcuts").fill("palette");
  await expect(page.locator(".rk-shortcuts__row")).toHaveCount(1);
  await check(page, "shortcut sheet", problems);
  expect(problems).toEqual([]);
});

test("profile: the pebble previews live, Save sends only the profile, Discard restores", async ({
  page,
}) => {
  const patches: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH") patches.push(r.postDataJSON());
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/profile");
  await expect(page.getByLabel("Your name")).toHaveValue("Dana Whitfield");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.getByRole("tab", { name: "Rocky" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Pip");
  await page.getByLabel("Sage").check();
  await expect(page.getByRole("tab", { name: "Pip" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Pip, in sage" })).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Rocky");
  await page.getByLabel("Lilac").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  expect(patches).toEqual([{ userName: "Dana Whitfield", name: "Rocky", swatch: "lilac" }]);
});

test("files: preview what Rocky read, open in folder, gone files can't open, forget asks first", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/files");
  await expect(page.getByText("no longer on disk")).toBeVisible();
  await page.getByRole("radio", { name: "Changed" }).check({ force: true });
  await expect(page.getByText("Rocky has never changed one of your files.")).toBeVisible();
  await page.getByRole("radio", { name: "Read" }).check({ force: true });
  await page.getByRole("button", { name: "Preview pricing-notes.md" }).click();
  const drawer = page.getByRole("dialog", { name: "pricing-notes.md" });
  await expect(drawer.getByText("Dana prefers annual billing.")).toBeVisible();
  await expect(drawer.getByText("Showing the first part of 9,120 characters.")).toBeVisible();
  const problems: string[] = [];
  await check(page, "files preview", problems);
  expect(problems).toEqual([]);
  await drawer.getByRole("button", { name: "Open in folder" }).click();
  await drawer.getByRole("button", { name: "Forget this file" }).click();
  await expect(page.getByRole("dialog", { name: "Forget this file?" })).toBeVisible();
  expect(writes).toEqual(["POST /api/v1/files/f1/reveal"]);
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(
    page.getByText("Rocky forgot pricing-notes.md. The file is still on disk."),
  ).toBeVisible();
  expect(writes).toEqual(["POST /api/v1/files/f1/reveal", "DELETE /api/v1/documents/f1"]);
  await page.getByRole("button", { name: "Preview old-plan.pdf" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "old-plan.pdf" })
      .getByRole("button", { name: "Open in folder" }),
  ).toBeDisabled();
});

test("integrations: an expired login is on top with Reconnect; permissions are ask or block", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/connectors");
  const needs = page.getByRole("region", { name: "Needs attention" });
  await expect(needs.getByText("Your GitHub token expired.")).toBeVisible();
  await expect(needs.getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "Details: Gmail" }).click();
  const drawer = page.getByRole("dialog", { name: "Gmail" });
  // The existing block rule shows; send can't be allowed from here.
  const del = drawer.getByRole("group", { name: "Delete in Gmail" });
  await expect(del.getByRole("radio", { name: "Block" })).toBeChecked();
  await expect(drawer.getByText("Rocky always asks before anything is sent.")).toBeVisible();
  await expect(drawer.getByRole("radio", { name: "Allow" })).toHaveCount(0);
  const problems: string[] = [];
  await check(page, "integration drawer", problems);
  expect(problems).toEqual([]);
  await drawer
    .getByRole("group", { name: "Write in Gmail" })
    .getByRole("radio", { name: "Block" })
    .click({ force: true });
  await expect(
    page.getByText("Rocky can't write in Gmail now. Proposals are blocked."),
  ).toBeVisible();
  // The mock doesn't store rules, so the control shows the server's answer; only the calls count.
  await del.getByRole("radio", { name: "Ask" }).click({ force: true });
  await expect
    .poll(() => writes)
    .toEqual(["POST /api/v1/rules", "POST /api/v1/rules/rule1/revoke"]);
});

test("task creation: once goes to a scoped question; weekdays saves a routine; draft survives closing", async ({
  page,
}) => {
  const posts: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/v1/routines")) posts.push(r.postDataJSON());
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "New task" }).first().click();
  const drawer = page.getByRole("dialog", { name: "New task" });
  await expect(drawer.getByRole("button", { name: /A morning brief/ })).toBeVisible();
  // Starting without a goal says why, at the field.
  await drawer.getByRole("button", { name: "Start task" }).click();
  await expect(drawer.getByText("Say what you want Rocky to do.")).toBeVisible();

  await drawer.getByRole("button", { name: /A morning brief/ }).click();
  await expect(drawer.getByRole("radio", { name: "Weekdays" })).toBeChecked();
  await expect(drawer.getByText("Weekdays at 08:00.", { exact: false })).toBeVisible();
  const problems: string[] = [];
  await check(page, "task drawer", problems);
  expect(problems).toEqual([]);
  // Closing keeps the draft.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New task" }).first().click();
  await expect(drawer.getByLabel("What should Rocky do?")).toHaveValue(
    /Summarise what matters today/,
  );
  await drawer.getByRole("button", { name: "Save routine" }).click();
  await expect(page).toHaveURL(/\/tasks\/background$/);
  expect(posts).toEqual([
    {
      name: "Summarise what matters today: events and anything overdue.",
      schedule: "0 8 * * 1-5",
      inputs: ["calendar_today", "overdue"],
      prompt: "Summarise what matters today: events and anything overdue. Under 8 sentences.",
      enabled: true,
    },
  ]);

  // Once, scoped to a project: it becomes a question on the chat screen.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("new task");
  await page.keyboard.press("Enter");
  await drawer.getByLabel("What should Rocky do?").fill("What is still open?");
  await drawer.getByLabel("Look in").selectOption("p1");
  await expect(drawer.getByText("the files in Launch (E:/Work/Launch)")).toBeVisible();
  await drawer.getByRole("button", { name: "Start task" }).click();
  await expect(page).toHaveURL(/\/ask\?.*project=p1/);
});

test("notifications: the bell shows unread, Review goes to Approvals, mark all read sends once", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/notifications/"))
      posts.push(new URL(r.url()).pathname);
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const bell = page.getByRole("button", { name: /Notifications/ });
  await expect(bell).toContainText("2");
  await bell.click();
  const pop = page.getByRole("dialog", { name: "Notifications" });
  await expect(pop.getByText("Needs your approval: Draft a reply to Priya")).toBeVisible();
  // A glance can never approve: the only action on an approval is Review.
  await expect(pop.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await pop.getByRole("link", { name: /^Review:/ }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(pop).toBeHidden();
  expect(posts).toContain("/api/v1/notifications/read");

  await page.goto("/notifications");
  await expect(page.getByRole("tab", { name: "Needs you (1)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Updates" }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Updates" }).getByRole("heading", { name: "Today" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByText("Marked 1 as read.")).toBeVisible();
  expect(posts.filter((p) => p.endsWith("/read-all"))).toHaveLength(1);
});

test("notification preferences: a matrix change and quiet hours save through settings", async ({
  page,
}) => {
  const puts: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().endsWith("/settings")) puts.push(r.postDataJSON());
  });
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/notifications?tab=preferences");
  await page.getByLabel("Updates on this computer").check();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toMatchObject({ notifications: { system: { updates: true } } });
  await page.getByRole("switch", { name: "Use quiet hours" }).click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]).toMatchObject({ notifications: { quietHours: { enabled: true } } });
});

test("phone: a tab bar with Today, Approvals, Tasks, Chat and More; More holds the rest", async ({
  page,
}) => {
  await mockApi(page, "populated");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "Main" });
  for (const name of [/^Today/, /^Approvals/, /^Tasks/, /^Chat/])
    await expect(tabs.getByRole("link", { name })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /^More/ })).toBeVisible();
  await expect(tabs.getByRole("link", { name: /^Approvals/ })).toContainText("3");
  await tabs.getByRole("button", { name: /^More/ }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet.getByRole("link", { name: "Commitments" })).toBeVisible();
  const problems: string[] = [];
  await check(page, "more sheet", problems);
  expect(problems).toEqual([]);
  await sheet.getByRole("link", { name: /^Notifications/ }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(sheet).toBeHidden();
  await expect(tabs.getByRole("button", { name: /^More/ })).toHaveClass(/active/);
  // A tablet gets the icon rail; it follows the window back to the full sidebar.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator(".rk-side")).toHaveAttribute("data-rail", "true");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(".rk-side")).toHaveAttribute("data-rail", "false");
});

test("phone: a high-risk approval is held to approve; a tap opens the confirm step", async ({
  page,
}) => {
  // A touch screen: the browser reports a coarse pointer.
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q === "(pointer: coarse)" ? ({ ...real(q), matches: true } as MediaQueryList) : real(q);
  });
  const approvals: unknown[] = [];
  await mockApi(page, "populated");
  await page.route("**/api/v1/actions?status=draft", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ actions: [{ ...DRAFTS[0], risk: "high" }] }),
    }),
  );
  await page.route("**/api/v1/actions/*/approve", (route) => {
    approvals.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...DRAFTS[0], status: "approved", executeAfter: Date.now() + 10_000 }),
    });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/approvals");
  const hold = page.getByRole("button", { name: "Hold to approve" });
  await hold.click();
  await expect(page.getByRole("region", { name: "Confirm approval" })).toBeVisible();
  expect(approvals).toEqual([]);
  await page.getByRole("button", { name: "Go back" }).click();
  // A short press is not enough…
  await hold.dispatchEvent("pointerdown", { pointerType: "touch" });
  await page.waitForTimeout(300);
  await hold.dispatchEvent("pointerup", { pointerType: "touch" });
  expect(approvals).toEqual([]);
  // …holding for the full time approves exactly once.
  await hold.dispatchEvent("pointerdown", { pointerType: "touch" });
  await expect.poll(() => approvals.length, { timeout: 4000 }).toBe(1);
  expect(approvals[0]).toMatchObject({ payloadHash: DRAFTS[0]?.payloadHash, holdMs: 10_000 });
});

test("devices: add the Tailscale name, make a pairing code, sign a phone out after asking", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/devices"))
      writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await mockApi(page, "empty");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings?section=devices");
  await expect(page.getByText("No phone is paired yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make a pairing code" })).toBeDisabled();
  await page.getByLabel("Name from tailscale serve").fill("https://PC.tail1234.ts.net/");
  await page.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => writes).toEqual(["PUT /api/v1/devices/hosts"]);

  await page.unroute("**/api/v1/**");
  await mockApi(page, "populated");
  await page.goto("/settings?section=devices");
  await page.getByRole("button", { name: "Make a pairing code" }).click();
  await expect(page.getByText("482913")).toBeVisible();
  await expect(page.getByText("https://pc.tail1234.ts.net/pair")).toBeVisible();
  const problems: string[] = [];
  await check(page, "devices", problems);
  expect(problems).toEqual([]);
  await page.getByRole("button", { name: "Sign out" }).click();
  const confirm = page.getByRole("dialog", { name: "Sign out Pixel 8?" });
  await expect(confirm).toBeVisible();
  expect(writes.filter((w) => w.endsWith("/revoke"))).toEqual([]);
  await confirm.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => writes.filter((w) => w.endsWith("/revoke"))).toHaveLength(1);
});

test("pair: six digits and a name pair the phone, a wrong code says why", async ({ page }) => {
  const sent: unknown[] = [];
  let ok = false;
  await mockApi(page, "populated");
  await page.route("**/auth/pair", (route) => {
    sent.push(route.request().postDataJSON());
    return ok
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ paired: "d1", name: "Phone" }),
        })
      : route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: "That code is wrong or has expired. Make a new one on your computer.",
            code: "PAIR_FAILED",
          }),
        });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/pair");
  const pair = page.getByRole("button", { name: "Pair" });
  await expect(pair).toBeDisabled();
  await page.getByLabel("Pairing code").fill("12a3456");
  await expect(page.getByLabel("Pairing code")).toHaveValue("123456");
  await pair.click();
  await expect(page.getByText("That code is wrong or has expired.")).toBeVisible();
  ok = true;
  await pair.click();
  await expect(page).toHaveURL(/:\d+\/$/);
  expect(sent.at(-1)).toMatchObject({ code: "123456" });
});

test("phone notifications: a random topic goes to the keychain, then a test is sent", async ({
  page,
}) => {
  const posts: { path: string; body: unknown }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/channels/"))
      posts.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() });
  });
  await mockApi(page, "empty");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/notifications?tab=preferences");
  await expect(page.getByRole("button", { name: "Send a test" })).toBeDisabled();
  await page.getByRole("button", { name: "Make one for me" }).click();
  const topic = page.getByLabel("Topic", { exact: true });
  await expect(topic).toHaveValue(/^rocky_[a-z0-9]{20}$/);
  const value = await topic.inputValue();
  await page.getByRole("button", { name: "Save topic" }).click();
  await expect
    .poll(() => posts)
    .toEqual([{ path: "/api/v1/channels/ntfy/secret", body: { name: "topic", value } }]);
  // Saved topics are never shown again.
  await expect(topic).toHaveValue("");
  const problems: string[] = [];
  await check(page, "phone channel", problems);
  expect(problems).toEqual([]);
});
