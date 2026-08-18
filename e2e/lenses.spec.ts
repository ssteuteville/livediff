import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { hubUrl, workspaceId, focusUrl } from "./harness.js";

/**
 * Seed the lens set over HTTP rather than through the CLI: the hub is already running for e2e, and
 * going through the API keeps these specs about the browser instead of about argument parsing.
 */
async function setLenses(lenses: unknown[]): Promise<void> {
  const response = await fetch(`${hubUrl()}/api/lenses?ws=${workspaceId("nested")}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lenses }),
  });
  if (!response.ok) throw new Error(`seeding lenses failed: ${response.status}`);
}

const UI_LENS = {
  name: "ui",
  why: "the component work",
  paths: ["src/components/**"],
};

const DEEP_LENS = {
  name: "deep",
  why: "one file, deliberately",
  paths: ["deep/one/two/three/leaf.ts"],
  highlights: [{ path: "deep/one/two/three/leaf.ts", start: 3, end: 6 }],
};

const EMPTY_LENS = {
  name: "gone",
  why: "matches nothing here",
  paths: ["does/not/exist/**"],
};

async function showFiles(page: Page) {
  const closed = page.locator('[data-file-panel-toggle][aria-expanded="false"]');
  if ((await closed.count()) > 0) await closed.click();
  await page.locator("[data-file-list]").waitFor();
}

async function openDiff(page: Page, query = "") {
  await page.goto(focusUrl("nested") + query);
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });
}

test.beforeEach(async () => {
  await setLenses([UI_LENS, DEEP_LENS, EMPTY_LENS]);
});

test.afterAll(async () => {
  await fetch(`${hubUrl()}/api/lenses?ws=${workspaceId("nested")}`, { method: "DELETE" });
});

test("the header control reads Full diff when no lens is applied", async ({ page }) => {
  await openDiff(page);
  const control = page.locator("[data-lens-control]");
  await expect(control).toHaveAttribute("data-lens-active", "false");
  await expect(control).toContainText("Full diff");
});

test("a lens in the URL filters the file tree to its own files", async ({ page }) => {
  await openDiff(page, "&lens=ui");
  await showFiles(page);
  await expect(page.locator("[data-file-item]")).toHaveCount(2);
  await expect(page.locator('[data-file-item="src/components/ui/Button.tsx"]')).toBeVisible();
  await expect(page.locator('[data-file-item="README.md"]')).toHaveCount(0);
});

test("the control names the applied lens and marks itself active", async ({ page }) => {
  await openDiff(page, "&lens=ui");
  const control = page.locator("[data-lens-control]");
  await expect(control).toHaveAttribute("data-lens-active", "true");
  await expect(control).toContainText("ui");
});

test("an unknown lens falls back to the full diff rather than an empty screen", async ({
  page,
}) => {
  await openDiff(page, "&lens=no-such-lens");
  await showFiles(page);
  await expect(page.locator("[data-file-item]")).toHaveCount(7);
  await expect(page.locator("[data-lens-control]")).toHaveAttribute("data-lens-active", "false");
});

test("choosing a lens from the picker filters and puts it in the URL", async ({ page }) => {
  await openDiff(page);
  await page.locator("[data-lens-control]").click();
  await page.locator('[data-lens-option="ui"]').click();

  await expect(page.locator("[data-lens-control]")).toHaveAttribute("data-lens-active", "true");
  await expect.poll(() => new URL(page.url()).searchParams.get("lens")).toBe("ui");
  await showFiles(page);
  await expect(page.locator("[data-file-item]")).toHaveCount(2);
});

test("choosing Full diff restores every file and drops lens from the URL", async ({ page }) => {
  await openDiff(page, "&lens=ui");
  await page.locator("[data-lens-control]").click();
  await page.locator('[data-lens-option="Full diff"]').click();

  await expect(page.locator("[data-lens-control]")).toHaveAttribute("data-lens-active", "false");
  await expect.poll(() => new URL(page.url()).searchParams.get("lens")).toBeNull();
  await showFiles(page);
  await expect(page.locator("[data-file-item]")).toHaveCount(7);
});

test("the picker lists each lens with its why and a file count", async ({ page }) => {
  await openDiff(page);
  await page.locator("[data-lens-control]").click();

  const ui = page.locator('[data-lens-option="ui"]');
  await expect(ui).toContainText("the component work");
  await expect(ui).toContainText("2 files");

  // A lens that resolves to nothing has to say so here, or it looks like a broken click.
  await expect(page.locator('[data-lens-option="gone"]')).toContainText("matches nothing");
});

test("a lens matching no files shows an empty state that still offers the way back", async ({
  page,
}) => {
  // Not openDiff: with nothing to show there is no diff scroller to wait for, which is the point.
  await page.goto(focusUrl("nested") + "&lens=gone");
  const escape = page.locator("[data-lens-escape]");
  await escape.waitFor({ timeout: 30_000 });
  await expect(escape).toBeVisible();
  await expect(page.locator("main")).toContainText("gone");

  await escape.click();
  await expect(page.locator("[data-lens-control]")).toHaveAttribute("data-lens-active", "false");
});

test("highlighted rows carry the tint, and the rows around them do not", async ({ page }) => {
  await openDiff(page, "&lens=deep");
  await page.waitForSelector("[data-row]");

  const marks = page.locator("[data-highlight]");
  await expect(marks.first()).toBeVisible();

  // start / middle / middle / end across lines 3..6, and nothing outside that run.
  await expect(page.locator('[data-highlight="start"]')).toHaveCount(1);
  await expect(page.locator('[data-highlight="end"]')).toHaveCount(1);
  await expect(marks).toHaveCount(4);
});

test("a lens with no highlights renders no tint at all", async ({ page }) => {
  await openDiff(page, "&lens=ui");
  await page.waitForSelector("[data-row]");
  await expect(page.locator("[data-highlight]")).toHaveCount(0);
});

test("highlights do not change row geometry, which virtualization computes rather than measures", async ({
  page,
}) => {
  // Row offsets come from an arithmetic height model, never from the DOM. If the tint added a
  // border, padding or line-height, every row below the highlight would drift out of place and the
  // scroll height would move with it. Same diff, same total height, highlights or not.
  await setLenses([{ ...DEEP_LENS, highlights: [] }]);
  await openDiff(page, "&lens=deep");
  await page.waitForSelector("[data-row]");
  const scroller = page.locator("[data-diff-scroll]");
  const plain = await scroller.evaluate((el) => el.scrollHeight);
  const plainRow = await page
    .locator("[data-row]")
    .first()
    .evaluate((el) => el.clientHeight);

  await setLenses([DEEP_LENS]);
  await openDiff(page, "&lens=deep");
  await page.waitForSelector("[data-highlight]");
  const tinted = await scroller.evaluate((el) => el.scrollHeight);
  const tintedRow = await page
    .locator("[data-row]")
    .first()
    .evaluate((el) => el.clientHeight);

  expect(tinted).toBe(plain);
  expect(tintedRow).toBe(plainRow);
});

test("a highlight range outside the file's hunks renders nothing and breaks nothing", async ({
  page,
}) => {
  await setLenses([
    {
      ...DEEP_LENS,
      highlights: [{ path: "deep/one/two/three/leaf.ts", start: 9000, end: 9100 }],
    },
  ]);
  await openDiff(page, "&lens=deep");
  await page.waitForSelector("[data-row]");
  await expect(page.locator("[data-highlight]")).toHaveCount(0);
  await expect(page.locator("[data-row]").first()).toBeVisible();
});
