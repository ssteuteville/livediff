import { test, expect } from "@playwright/test";
import { focusUrl, hubUrl, workspaceId } from "./harness.js";

test("the compare field offers the repo's branches", async ({ page }) => {
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const options = await page
    .locator("#livediff-refs option")
    .evaluateAll((els) => els.map((el) => el.getAttribute("value")));

  expect(options).toContain("HEAD");
  expect(options).toContain("main");
});

test("choosing a ref marks the field as active and offers to clear it", async ({ page }) => {
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const field = page.locator("[data-compare-against]");
  await expect(page.locator("[data-clear-compare]")).toHaveCount(0);

  await field.fill("main");
  // A chosen ref changes what the whole page means, so the field must not still read as empty.
  await expect(page.locator("[data-clear-compare]")).toBeVisible();
  await expect(field).toHaveClass(/border-blue-400/);

  await page.locator("[data-clear-compare]").click();
  await expect(field).toHaveValue("");
  await expect(page.locator("[data-clear-compare]")).toHaveCount(0);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The base as the hub has it on disk, which is the only copy the CLI and the sweep can see. */
async function storedBase(
  page: import("@playwright/test").Page,
  id: string,
): Promise<string | null> {
  const res = await page.request.get(`${hubUrl()}/api/workspaces`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body["workspaces"])) return null;
  for (const entry of body["workspaces"]) {
    if (!isRecord(entry) || entry["id"] !== id) continue;
    return typeof entry["base"] === "string" ? entry["base"] : null;
  }
  return null;
}

/** Type a ref and commit it the way a person does — the value is only stored on the way out. */
async function chooseBase(page: import("@playwright/test").Page, ref: string): Promise<void> {
  const field = page.locator("[data-compare-against]");
  await field.fill(ref);
  await field.blur();
}

test("the chosen ref belongs to the worktree, not the tab", async ({ page }) => {
  // The base has to outlive the browser: `livediff comments` and the archive sweep both ask
  // "is this file still in the diff?" long after the tab that chose the base has gone. Keeping it
  // per tab is what made comments on an already-committed branch read as stale.
  const id = workspaceId("modfiles");
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  await chooseBase(page, "main");
  await expect.poll(() => storedBase(page, id)).toBe("main");

  // A fresh page must come back to the same comparison rather than resetting to HEAD.
  await page.goto(focusUrl("modfiles"));
  await expect(page.locator("[data-compare-against]")).toHaveValue("main");

  await page.locator("[data-clear-compare]").click();
  await expect.poll(() => storedBase(page, id)).toBe(null);
});

test("switching worktrees never stamps one worktree's ref onto another", async ({ page }) => {
  // Selecting a workspace changes `selected` and the adopted base in the same commit, so the
  // diff-loading effect can fire once with the previous worktree's ref still in state. Persisting
  // from that load would write worktree A's base onto worktree B — silently, and to disk.
  const from = workspaceId("modfiles");
  const to = workspaceId("nested");
  await page.goto(hubUrl());
  await page.locator(`[data-rail-workspace="${from}"]`).click();
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  await chooseBase(page, "main");
  await expect.poll(() => storedBase(page, from)).toBe("main");

  await page.locator(`[data-rail-workspace="${to}"]`).click();
  // The field adopting the empty stored base is the signal that the switch has settled.
  await expect(page.locator("[data-compare-against]")).toHaveValue("");
  await expect.poll(() => storedBase(page, to)).toBe(null);

  // Leave the registry as it was found; these fixtures are shared with every other spec.
  await page.locator(`[data-rail-workspace="${from}"]`).click();
  await page.locator("[data-clear-compare]").click();
  await expect.poll(() => storedBase(page, from)).toBe(null);
});

test("typing a ref does not store the prefixes it passes through", async ({ page }) => {
  // `fill()` fires one input event and so never saw this. Typing does: each keystroke reloads the
  // diff, and an unresolvable ref returns an empty diff with a clean exit rather than an error —
  // so "m", "ma", "mai" all look like successful loads. Storing any of them makes every comment in
  // the worktree read as stale, which is the failure this whole field exists to prevent.
  const id = workspaceId("modfiles");
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const seen: (string | null)[] = [];
  const field = page.locator("[data-compare-against]");
  await field.click();
  for (const ch of "main") {
    await field.pressSequentially(ch);
    seen.push(await storedBase(page, id));
  }
  expect(seen).toEqual([null, null, null, null]);

  // Nor is the reader shouted at on the way. The server refuses each prefix, so persisting per
  // keystroke would spray "not a ref in this worktree" across the page while they are still typing.
  await expect(page.locator("[data-error]")).toHaveCount(0);

  await field.blur();
  await expect.poll(() => storedBase(page, id)).toBe("main");

  await page.locator("[data-clear-compare]").click();
  await expect.poll(() => storedBase(page, id)).toBe(null);
});

test("a ref that does not resolve is reported and never stored", async ({ page }) => {
  const id = workspaceId("modfiles");
  await page.goto(focusUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  await chooseBase(page, "no-such-branch");
  await expect(page.locator("body")).toContainText("not a ref in this worktree");
  expect(await storedBase(page, id)).toBe(null);
});
