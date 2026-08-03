import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "./test-results",
  // One hub, and the live-update tests mutate the fixture worktrees.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
