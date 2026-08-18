import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import ReviewBanner from "../../src/components/ReviewBanner.jsx";

async function labelFor(openCount: number): Promise<string> {
  void render(
    <div data-slot>
      <ReviewBanner openCount={openCount} onDone={() => undefined} />
    </div>,
  );
  let text = "";
  await vi.waitFor(() => {
    const button = document.body.querySelector("[data-slot] button");
    expect(button, "the banner never mounted").toBeTruthy();
    text = button?.textContent ?? "";
    expect(text.length, "the banner rendered empty").toBeGreaterThan(0);
  });
  document.body.replaceChildren();
  return text;
}

test("the review banner counts open comments, not resolved ones", async () => {
  // Regression guard: this counted every comment on the branch, so the second review of a branch
  // opened saying "2 comments" for work resolved in the first round. The button asks whether you
  // are finished; a resolved comment is not an answer to that.
  expect(await labelFor(0)).toBe("Done reviewing");
  expect(await labelFor(1)).toBe("Done reviewing (1 open)");
  expect(await labelFor(3)).toBe("Done reviewing (3 open)");
});
