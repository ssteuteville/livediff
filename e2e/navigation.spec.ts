import { test, expect } from "@playwright/test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceUrl, focusUrl, fixturePath } from "./harness.js";

/** Focused mode starts with the file panel collapsed, so anything that clicks a file opens it. */
async function showFiles(page: import("@playwright/test").Page) {
  const closed = page.locator('[data-file-panel-toggle][aria-expanded="false"]');
  if ((await closed.count()) > 0) await closed.click();
  await page.locator("[data-file-list]").waitFor();
}

test("a ?ws= deep link selects the workspace it names", async ({ page }) => {
  // Regression guard: the "keep a valid selection" effect used to run before the workspace list
  // had loaded and clear the selection this URL just made, so a deep link opened whichever
  // workspace happened to be first. Fixed by distinguishing "not fetched yet" from "none exist".
  await page.goto(workspaceUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });
  await expect(page.locator("[data-file-item]")).toHaveCount(40);
});

test("clicking a file in the list jumps to it in the diff", async ({ page }) => {
  await page.goto(focusUrl("modfiles"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await showFiles(page);
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.locator('[data-file-item="mod-20.ts"]').click();

  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).not.toBe(before);

  // Not [data-row]:first — the window is rendered with overscan, so the first row in the DOM sits
  // several rows above the viewport. Check where the file's own header actually landed.
  const header = page.locator('[data-row-kind="file"]', { hasText: "mod-20.ts" });
  await expect(header).toBeVisible();

  const offset = await header.evaluate((row) => {
    const box = row.getBoundingClientRect();
    // Queried rather than walked up from the header: the header of the file you are looking at is
    // the pinned one, and that is a sibling of the scroller rather than a descendant of it.
    const view = document.querySelector("[data-diff-scroll]")!.getBoundingClientRect();
    return box.top - view.top;
  });
  expect(Math.abs(offset)).toBeLessThan(4);
});

test("the last file cannot reach the top, and that is not a bug", async ({ page }) => {
  await page.goto(focusUrl("modfiles"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await showFiles(page);

  // The list is sorted by path, so the last entry is mod-9.ts rather than mod-39.ts. Read it.
  const last = page.locator("[data-file-item]").last();
  const path = (await last.getAttribute("data-file-item"))!;
  await last.click();
  await expect(page.locator('[data-row-kind="file"]', { hasText: path })).toBeVisible();

  // A jump puts the file's *rows* at the top unless the document ends first, in which case
  // scrollTop clamps at scrollHeight - clientHeight and they land lower. That clamping was chased
  // as a 234px bug once. Both outcomes are correct; overscrolling is not.
  //
  // The header itself no longer distinguishes the two — it is pinned, so it is at the top either
  // way. So this reads scrollTop directly, which is what the clamp was ever about.
  const state = await scroller.evaluate((el) => ({
    scrollTop: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));

  expect(state.scrollTop).toBeLessThanOrEqual(state.max + 2);
  expect(state.scrollTop).toBeGreaterThan(0);

  // And the pinned header must name the file that was actually asked for.
  expect(await page.locator("[data-file-sticky]").getAttribute("data-file-sticky")).toBe(path);
});

test("an edit to an already-modified file updates the diff and holds the reader's place", async ({
  page,
}) => {
  await page.goto(focusUrl("modfiles"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await scroller.evaluate((el) => {
    el.scrollTop = 12_000;
  });
  const before = await scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));
  const topRow = await page.locator("[data-row]").first().textContent();

  // mod-0.ts is already in the diff, so `git status` alone never changes for this edit. That is
  // exactly the case that silently did not work until worktreeSignature folded in size and mtime.
  await appendFile(join(fixturePath("modfiles"), "mod-0.ts"), "\n// live update check\n");

  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight), { timeout: 20_000 })
    .not.toBe(before.height);

  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(before.top);
  expect(await page.locator("[data-row]").first().textContent()).toBe(topRow);
});

test("search finds matches that were never rendered", async ({ page }) => {
  await page.goto(focusUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  // In-app find replaces the browser's, which cannot see virtualized rows, so it opens on the same
  // keystroke rather than being on screen by default.
  await page.keyboard.press("ControlOrMeta+f");
  await page.locator("[data-diff-search]").waitFor();

  // value19000 lives far below the rendered window, so a DOM-based search could not reach it.
  await page.locator("[data-diff-search] input").fill("value19000");

  await expect.poll(() => page.locator("[data-diff-search]").textContent()).toMatch(/[1-9]/);
});

test("a minified single-line bundle does not break the height model", async ({ page }) => {
  await page.goto(focusUrl("minified"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  const box = await scroller.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));

  // A 20,000-character line must wrap to many lines' worth of height, not be measured as one.
  // This half holds: the analytic height model handles the shape correctly.
  expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
});

test("a minified single-line bundle stays within the node budget", async ({ page }) => {
  // Regression guard: virtualization bounds rows, not the tokens inside one, so a single
  // 20,000-character line once rendered 40,058 nodes and took ~11s. MAX_HIGHLIGHT_LINE_CHARS caps
  // it by rendering an over-long line as plain text.
  await page.goto(focusUrl("minified"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  expect(nodes).toBeLessThan(5_000);
});

test("a 20k-line lockfile renders under the same node budget", async ({ page }) => {
  await page.goto(focusUrl("lockfile"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  expect(nodes).toBeLessThan(5_000);
});
