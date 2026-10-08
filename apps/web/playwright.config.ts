import { defineConfig, devices } from "@playwright/test";

/**
 * Visual, accessibility and keyboard tests (UI spec "Final frontend blueprint"). Locally they drive
 * the installed Microsoft Edge (no browser download; docs/DECISIONS.md D-013); CI uses Playwright's
 * Chromium. Screenshots land in e2e/screenshots (not committed).
 */
const PORT = 5199;
const channel = process.env.CI ? undefined : (process.env.ROCKY_PW_CHANNEL ?? "msedge");

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    ...(channel ? { channel } : {}),
    // No third-party requests from the UI (user rule 3): anything off localhost fails the test.
    serviceWorkers: "block",
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/stories.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
