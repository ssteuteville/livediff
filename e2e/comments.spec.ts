import { test, expect, type Page } from "@playwright/test";
import { focusUrl, hubUrl, workspaceId } from "./harness.js";

/**
 * Seed through the API rather than the UI. The add-comment button only appears on row hover, so
 * driving it would make every test about the gutter affordance instead of the thing under test.
 */
async function seed(
  page: Page,
  body: { file: string; side: string; line: number; body: string; replies?: unknown[] },
) {
  const ws = workspaceId("modfiles");
  const created = await page.evaluate(
    async ([url, id, payload]) => {
      const res = await fetch(`${url}/api/comments?ws=${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.json();
    },
    [hubUrl(), ws, body] as const,
  );
  if (!hasId(created)) throw new Error("comment API did not return an id");
  return created;
}

function hasId(value: unknown): value is { id: string } {
  return (
    value !== null && typeof value === "object" && "id" in value && typeof value.id === "string"
  );
}

async function removeAll(page: Page) {
  const ws = workspaceId("modfiles");
  await page.evaluate(
    async ([url, id]) => {
      const { comments } = await fetch(`${url}/api/comments?ws=${id}`).then((r) => r.json());
      for (const c of comments) {
        await fetch(`${url}/api/comments/${c.id}?ws=${id}`, { method: "DELETE" });
      }
    },
    [hubUrl(), ws] as const,
  );
}

test.afterEach(async ({ page }) => {
  await removeAll(page);
});

test("expanding a comment overlays the rows below and does not change document height", async ({
  page,
}) => {
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });
  await seed(page, {
    file: "mod-0.ts",
    side: "new",
    line: 3,
    body: "a comment for the overlay test",
  });
  await page.reload();

  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor();
  const slot = page.locator("[data-comment-slot]").first();
  await slot.waitFor({ timeout: 15_000 });

  const before = await scroller.evaluate((el) => el.scrollHeight);
  await slot.click();
  await expect(page.locator("[data-comment-expanded]")).toBeVisible();

  // The stated invariant: expanding overlays the rows below rather than reflowing them, so the
  // document never resizes and the reader's place is never disturbed.
  expect(await scroller.evaluate((el) => el.scrollHeight)).toBe(before);
});

test("the painted reply box opens the real one, focused", async ({ page }) => {
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });
  await seed(page, { file: "mod-0.ts", side: "new", line: 3, body: "reply focus test" });
  await page.reload();

  const placeholder = page.locator("[data-reply-placeholder]").first();
  await placeholder.waitFor({ timeout: 15_000 });
  await placeholder.click();

  // A collapsed thread paints a non-functional reply box. Clicking it must open the real thread
  // with the real input already focused, or the illusion costs the reader a second click.
  await expect(page.locator("[data-comment-expanded]")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName.toLowerCase()))
    .toBe("textarea");
});

test("a comment whose anchor line is gone is still reachable", async ({ page }) => {
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  // Line 99999 does not exist in the diff, so this comment can never be placed on a row. Before the
  // drawer there was no way to read it — or Claude's answer to it — once its anchor closed.
  await seed(page, { file: "mod-0.ts", side: "new", line: 99_999, body: "orphaned comment" });
  await page.reload();
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  await page.locator("[data-see-all-comments]").click();
  const drawer = page.locator("[data-comment-drawer]");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("orphaned comment");
});
