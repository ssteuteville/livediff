import { test, expect } from "@playwright/test";
import { focusUrl } from "./harness.js";

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
