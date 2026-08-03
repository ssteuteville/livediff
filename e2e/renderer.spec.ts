import { test, expect } from "@playwright/test";
import { workspaceUrl } from "./harness.js";

test("the hub serves the fast renderer, not a stale bundle", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  // The most expensive mistake on record: a packed tarball predating the fast renderer served a
  // bundle whose RENDERERS lacked "fast", so ?renderer=fast fell through to the default and every
  // number collected described the classic renderer.
  const renderers = await page.evaluate(() => window.__LIVEDIFF_RENDERERS__ ?? null);
  expect(renderers, "the served bundle does not expose its renderer list").not.toBeNull();
  expect(renderers).toContain("fast");
});

test("DOM node count stays bounded on a 20k-line diff", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  // Measured: 1,203 virtualized against 500,156 not. This separates those two worlds; it is not a
  // tight threshold and must not be tightened into one.
  expect(nodes).toBeLessThan(5_000);
});

test("only a window of rows is rendered, wherever you scroll", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await scroller.evaluate((el) => {
    el.scrollTop = 250_000;
  });
  await expect.poll(() => page.locator("[data-row]").count()).toBeGreaterThan(0);

  const rendered = await page.locator("[data-row]").count();
  // Measured: 62 rows at this scroll position.
  expect(rendered).toBeLessThan(200);
});

test("first-load JS stays under budget", async ({ page }) => {
  const bytes: number[] = [];
  page.on("response", async (res) => {
    if (!res.url().endsWith(".js")) return;
    const body = await res.body().catch(() => null);
    if (body) bytes.push(body.byteLength);
  });

  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const total = bytes.reduce((n, b) => n + b, 0);
  expect(total, "no JS responses were captured — the budget would pass vacuously").toBeGreaterThan(0);
  // Measured: 71 KB gzip on the fast path, from 413 KB before the split. Uncompressed here, so the
  // budget is loose — its job is to catch the classic renderer being pulled in eagerly again.
  expect(total).toBeLessThan(600_000);
});
