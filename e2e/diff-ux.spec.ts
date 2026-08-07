import { test, expect } from "@playwright/test";
import { focusUrl, workspaceUrl } from "./harness.js";

const SCROLLER = "[data-diff-scroll]";

async function open(page: import("@playwright/test").Page, fixture: "modfiles" | "nested") {
  await page.goto(focusUrl(fixture));
  const scroller = page.locator(SCROLLER);
  await scroller.waitFor({ timeout: 30_000 });
  return scroller;
}

/** Focused mode starts with the file panel collapsed, so anything about the tree opens it first. */
async function showFiles(page: import("@playwright/test").Page) {
  const closed = page.locator('[data-file-panel-toggle][aria-expanded="false"]');
  if ((await closed.count()) > 0) await closed.click();
  await page.locator("[data-file-list]").waitFor();
}

test("the current file's header stays pinned to the top while scrolling through it", async ({
  page,
}) => {
  const scroller = await open(page, "modfiles");

  // Deep enough to be well inside a file rather than near its boundary.
  await scroller.evaluate((el) => {
    el.scrollTop = 3_000;
  });

  const pinned = page.locator("[data-file-sticky]");
  await expect(pinned).toHaveCount(1);

  const offset = await pinned.evaluate((el) => {
    // The pinned header is a sibling of the scroller, not a descendant, so find it by query.
    const view = document.querySelector("[data-diff-scroll]")!.getBoundingClientRect();
    return el.getBoundingClientRect().top - view.top;
  });
  expect(Math.abs(offset)).toBeLessThan(2);
});

test("pinning is invisible until you have scrolled past the header", async ({ page }) => {
  // At rest the pinned element must sit exactly where the real row would, so arriving at a diff
  // looks no different from before. Only scrolling should reveal that anything is pinned.
  const scroller = await open(page, "modfiles");
  await showFiles(page);

  const first = await page.locator("[data-file-item]").first().getAttribute("data-file-item");
  const pinned = page.locator("[data-file-sticky]");
  expect(await pinned.getAttribute("data-file-sticky")).toBe(first);

  const offset = await pinned.evaluate((el) => {
    // The pinned header is a sibling of the scroller, not a descendant, so find it by query.
    const view = document.querySelector("[data-diff-scroll]")!.getBoundingClientRect();
    return el.getBoundingClientRect().top - view.top;
  });
  expect(Math.abs(offset)).toBeLessThan(2);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
});

test("the next file pushes the pinned header off rather than covering it", async ({ page }) => {
  const scroller = await open(page, "modfiles");

  // Forty equally sized files, so one file's height is the surface over forty. Sitting just short
  // of that boundary puts the second file's real header into the top strip.
  const fileHeight = await scroller.evaluate((el) => {
    const surface = el.firstElementChild;
    return surface === null ? 0 : surface.getBoundingClientRect().height / 40;
  });
  expect(fileHeight).toBeGreaterThan(100);

  await scroller.evaluate((el, top) => {
    el.scrollTop = top;
  }, fileHeight - 12);

  // Precondition: a real header really is arriving. Without this the test could pass by accident
  // on a fixture whose files stopped being uniform.
  const arriving = await scroller.evaluate((el) => {
    const view = el.getBoundingClientRect();
    return [...el.querySelectorAll('[data-row-kind="file"]:not([data-file-sticky])')].some(
      (header) => {
        const top = header.getBoundingClientRect().top - view.top;
        return top >= 0 && top < 60;
      },
    );
  });
  expect(arriving, "expected the next file's header to be entering the viewport").toBe(true);

  const offset = await page.locator("[data-file-sticky]").evaluate((el) => {
    // The pinned header is a sibling of the scroller, not a descendant, so find it by query.
    const view = document.querySelector("[data-diff-scroll]")!.getBoundingClientRect();
    return el.getBoundingClientRect().top - view.top;
  });

  // Displaced upward: partly or wholly above the top edge, never pushed down over the newcomer.
  expect(offset).toBeLessThanOrEqual(1);
});

test("the pinned header is clipped on the way out, never painting over the app header", async ({
  page,
}) => {
  // Being pushed up means leaving the pane, and an absolutely positioned element does that by
  // drawing over whatever is above it. Hit-testing inside the app header is the honest check:
  // it asks what is actually painted there, not merely where a box claims to be.
  const scroller = await open(page, "modfiles");

  const fileHeight = await scroller.evaluate((el) => {
    const surface = el.firstElementChild;
    return surface === null ? 0 : surface.getBoundingClientRect().height / 40;
  });

  await scroller.evaluate((el, top) => {
    el.scrollTop = top;
  }, fileHeight - 8);
  await page.waitForTimeout(100);

  const painted = await page.evaluate(() => {
    const appHeader = document.querySelector("header");
    if (appHeader === null) return "no-app-header";
    const box = appHeader.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 3);
    if (hit === null) return "nothing";
    return hit.closest("[data-file-sticky]") === null ? "app-header" : "diff-header";
  });

  expect(painted).toBe("app-header");
});

test("the pinned header does not drift when scrolling outruns React", async ({ page }) => {
  // The jitter this guards against: with the header positioned inside the scrolling content, its
  // position was only corrected on re-render, so anything faster than one frame dragged it off
  // the top until the scroll stopped. Several synchronous jumps reproduce that without a wait —
  // React cannot have re-rendered in between, so a correct header must already be in place.
  const scroller = await open(page, "modfiles");

  const offset = await scroller.evaluate((el) => {
    el.scrollTop = 5_000;
    el.scrollTop = 60_000;
    el.scrollTop = 220_000;
    const pinned = document.querySelector("[data-file-sticky]");
    if (pinned === null) return Number.NaN;
    return pinned.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });

  // At most one header's height of displacement — the push-off window. Before the fix this was
  // hundreds of thousands of pixels adrift.
  expect(Number.isNaN(offset)).toBe(false);
  expect(offset).toBeLessThanOrEqual(1);
  expect(offset).toBeGreaterThan(-45);
});

test("the sidebar highlights the file that is pinned, and follows the scroll", async ({ page }) => {
  const scroller = await open(page, "modfiles");
  await showFiles(page);

  await expect(page.locator("[data-file-active]")).toHaveCount(1);
  const first = await page.locator("[data-file-active]").getAttribute("data-file-item");

  // A quarter of the way in, not a fixed pixel count: one file in this fixture is ~20,000px tall,
  // so a "big" absolute scroll can easily land inside the first file and prove nothing.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 4;
  });

  await expect
    .poll(() => page.locator("[data-file-active]").getAttribute("data-file-item"))
    .not.toBe(first);

  // Whatever is highlighted must be the file the pinned header names.
  const highlighted = await page.locator("[data-file-active]").getAttribute("data-file-item");
  const pinned = await page.locator("[data-file-sticky]").getAttribute("data-file-sticky");
  expect(highlighted).toBe(pinned);
});

test("focused mode opens with the file panel collapsed", async ({ page }) => {
  // Focused mode is opened at one worktree deliberately, so the width is worth more than a list
  // naming the thing you already chose.
  await open(page, "nested");

  await expect(page.locator("[data-file-list]")).toHaveCount(0);
  await expect(page.locator('[data-file-panel-toggle][aria-expanded="false"]')).toBeVisible();
});

test("the hub view opens with the file panel showing", async ({ page }) => {
  await page.goto(workspaceUrl("nested"));
  await page.locator(SCROLLER).waitFor({ timeout: 30_000 });

  await expect(page.locator("[data-file-list]")).toBeVisible();
  await expect(page.locator('[data-file-panel-toggle][aria-expanded="true"]')).toBeVisible();
});

test("the file panel collapses and reopens on demand", async ({ page }) => {
  await open(page, "nested");

  await page.locator('[data-file-panel-toggle][aria-expanded="false"]').click();
  await expect(page.locator("[data-file-list]")).toBeVisible();
  await expect(page.locator('[data-file-item="README.md"]')).toBeVisible();

  await page.locator('[data-file-panel-toggle][aria-expanded="true"]').click();
  await expect(page.locator("[data-file-list]")).toHaveCount(0);
  await expect(page.locator('[data-file-item="README.md"]')).toHaveCount(0);
});

test("the collapsed panel still says how many files and open comments there are", async ({
  page,
}) => {
  // Collapsed must not mean gone: there has to be something to click, and the two counts worth
  // knowing without the list are worth keeping on screen.
  await open(page, "nested");

  const spine = page.locator('[data-file-panel-toggle][aria-expanded="false"]');
  await expect(spine).toBeVisible();
  await expect(spine).toContainText("7");
});

test("collapsing the panel gives the width to the diff", async ({ page }) => {
  const scroller = await open(page, "nested");
  const collapsed = await scroller.evaluate((el) => el.clientWidth);

  await page.locator('[data-file-panel-toggle][aria-expanded="false"]').click();
  await expect(page.locator("[data-file-list]")).toBeVisible();

  const expanded = await scroller.evaluate((el) => el.clientWidth);
  expect(collapsed).toBeGreaterThan(expanded);
});

test("the left panel shows folder structure, compacting single-child chains", async ({ page }) => {
  await open(page, "nested");
  await showFiles(page);

  await expect(page.locator("[data-file-tree]")).toBeVisible();

  // src holds app, lib and components — a real branch, so it stays its own row.
  await expect(page.locator('[data-file-dir="src"]')).toBeVisible();

  // deep/one/two/three holds exactly one thing at each level, so it is one row, not four.
  await expect(page.locator('[data-file-dir="deep/one/two/three"]')).toBeVisible();
  await expect(page.locator('[data-file-dir="deep"]')).toHaveCount(0);

  // components has only ui beneath it, so those two fold together.
  await expect(page.locator('[data-file-dir="src/components/ui"]')).toBeVisible();

  // A root-level file is not filed under any directory.
  await expect(page.locator('[data-file-item="README.md"]')).toBeVisible();
});

test("collapsing a folder hides its files and survives being reopened", async ({ page }) => {
  await open(page, "nested");
  await showFiles(page);

  await expect(page.locator('[data-file-item="src/app/main.ts"]')).toBeVisible();
  await page.locator('[data-file-dir="src"]').click();
  await expect(page.locator('[data-file-item="src/app/main.ts"]')).toHaveCount(0);

  await page.locator('[data-file-dir="src"]').click();
  await expect(page.locator('[data-file-item="src/app/main.ts"]')).toBeVisible();
});

test("clicking a file in the tree still jumps to it", async ({ page }) => {
  const scroller = await open(page, "nested");
  await showFiles(page);
  const before = await scroller.evaluate((el) => el.scrollTop);

  await page.locator('[data-file-item="src/lib/util.ts"]').click();

  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).not.toBe(before);
  await expect
    .poll(() => page.locator("[data-file-sticky]").getAttribute("data-file-sticky"))
    .toBe("src/lib/util.ts");
});

test("the add-comment button sits beside the line numbers, not at the far edge", async ({
  page,
}) => {
  const scroller = await open(page, "nested");
  const row = page.locator('[data-row-kind="line"]').first();
  await row.hover();

  const geometry = await row.evaluate((el) => {
    const button = el.querySelector("[data-add-comment]");
    if (button === null) return null;
    const side = button.closest(".group");
    if (side === null) return null;
    const box = button.getBoundingClientRect();
    const sideBox = side.getBoundingClientRect();
    return { fromLeft: box.left - sideBox.left, width: sideBox.width };
  });

  expect(geometry).not.toBeNull();
  // Within the gutter's neighbourhood rather than out at the right-hand edge of the pane.
  expect(geometry!.fromLeft).toBeLessThan(90);
  expect(geometry!.fromLeft).toBeLessThan(geometry!.width / 2);
  await expect(scroller).toBeVisible();
});

test("revealing the add-comment button does not reflow the line", async ({ page }) => {
  // It lives in a column of its own for this reason: appearing on hover must not shove the code
  // sideways, which is what an inline button that only exists while hovered would do.
  await open(page, "nested");
  const row = page.locator('[data-row-kind="line"]').first();

  const textLeft = () =>
    row.evaluate((el) => {
      const code = el.querySelector(".min-w-0.flex-1");
      return code === null ? Number.NaN : code.getBoundingClientRect().left;
    });

  const before = await textLeft();
  await row.hover();
  await expect(page.locator("[data-add-comment]").first()).toBeVisible();
  expect(await textLeft()).toBe(before);
});

test("the line a comment is being written against is highlighted", async ({ page }) => {
  await open(page, "nested");
  const row = page.locator('[data-row-kind="line"]').first();

  await expect(page.locator("[data-composing]")).toHaveCount(0);

  await row.hover();
  await page.locator("[data-add-comment]").first().click();

  await expect(page.locator("[data-comment-composer]")).toBeVisible();
  await expect(page.locator("[data-composing]")).toHaveCount(1);

  // The marked row must be the one the composer names, not merely some row.
  const composerLabel = await page.locator("[data-comment-composer]").textContent();
  const markedNumber = await page
    .locator("[data-composing]")
    .evaluate((el) => el.textContent?.match(/\d+/)?.[0] ?? "");
  expect(composerLabel).toContain(`:${markedNumber}`);

  // Dismissing the composer clears the mark rather than leaving it stranded.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-composing]")).toHaveCount(0);
});

test("the app header states the size of the whole diff", async ({ page }) => {
  await open(page, "nested");

  const summary = page.locator("[data-diff-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("7 files");
  await expect(summary).toContainText("+420");
  await expect(summary).toContainText("−0");
  await expect(summary).toContainText(/\d+(\.\d+)? (B|KB|MB)/);

  // In the header, so it costs no vertical space in the diff pane itself.
  const inHeader = await summary.evaluate((el) => el.closest("header") !== null);
  expect(inHeader).toBe(true);
});

test("the top summary and the end cap report the same totals", async ({ page }) => {
  // They are two views of one count. Letting them drift would make one of them a lie.
  const scroller = await open(page, "nested");

  // Read the values off labelled elements. Regexing the rendered text folded the byte size into
  // the deletion count — adjacent elements leave no separator in textContent.
  const totals = (root: string) =>
    page.evaluate((selector) => {
      const scope = document.querySelector(selector);
      const read = (name: string) => scope?.querySelector(`[${name}]`)?.getAttribute(name) ?? null;
      return {
        files: read("data-diff-files"),
        additions: read("data-diff-additions"),
        deletions: read("data-diff-deletions"),
      };
    }, root);

  const top = await totals("[data-diff-summary]");
  expect(top).toEqual({ files: "7", additions: "420", deletions: "0" });

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await totals("[data-diff-end]")).toEqual(top);
});

test("the pinned file header never covers the size summary", async ({ page }) => {
  const scroller = await open(page, "nested");

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await page.waitForTimeout(100);

  const order = await page.evaluate(() => {
    const summary = document.querySelector("[data-diff-summary]")?.getBoundingClientRect();
    const pinned = document.querySelector("[data-file-sticky]")?.getBoundingClientRect();
    if (!summary || !pinned) return "missing";
    return pinned.top >= summary.bottom - 1 ? "below" : "overlapping";
  });
  expect(order).toBe("below");
});

test("the diff ends with an explicit end-of-files area rather than stopping dead", async ({
  page,
}) => {
  const scroller = await open(page, "nested");

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const end = page.locator("[data-diff-end]");
  await expect(end).toBeVisible();
  await expect(end).toContainText("No more files");
  await expect(end).toContainText("7 files");
});

test("back to top returns to the first file", async ({ page }) => {
  const scroller = await open(page, "nested");
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  await page.locator("[data-back-to-top]").click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(10);
});

test("pinning a header does not render every header at once", async ({ page }) => {
  // The failure this guards against: a sticky implementation that keeps all file headers mounted
  // would still look correct while quietly undoing virtualization on a 40-file diff.
  const scroller = await open(page, "modfiles");
  await scroller.evaluate((el) => {
    el.scrollTop = 20_000;
  });

  const headers = await page.locator('[data-row-kind="file"]').count();
  expect(headers).toBeLessThan(6);

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  expect(nodes).toBeLessThan(5_000);
});

test("exactly one header is drawn per file, pinned or not", async ({ page }) => {
  // The pinned header replaces the real row rather than sitting on top of it. If both rendered,
  // the file's name would appear twice and the row beneath would show through at the boundary.
  const scroller = await open(page, "modfiles");
  await scroller.evaluate((el) => {
    el.scrollTop = 3_000;
  });

  const paths = await page.evaluate(() =>
    [...document.querySelectorAll('[data-row-kind="file"]')].map(
      (el) => el.textContent?.match(/mod-\d+\.ts/)?.[0] ?? "",
    ),
  );
  const seen = paths.filter(Boolean);
  expect(new Set(seen).size).toBe(seen.length);
});
