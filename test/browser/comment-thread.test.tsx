import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CommentThreadPreview } from "../../src/components/CommentThread.jsx";

// Without the real stylesheet every Tailwind class is a no-op, so the card sizes to its content
// and the clipping this file exists to verify cannot happen.
import "../../src/index.css";

const SLOT_PX = 150;

const thread = (body: string, replies: { author: string; body: string }[] = []) => [
  { id: "c1", author: "shane", body, replies, status: "open", side: "new", line: 2 },
];

// React 19 commits asynchronously, so the node is not in the DOM the instant render() returns.
async function renderInSlot(comments: ReturnType<typeof thread>): Promise<HTMLElement> {
  void render(
    <div style={{ height: `${SLOT_PX}px`, width: "600px" }} data-slot>
      <CommentThreadPreview comments={comments} lines={7} file="a.ts" line={2} />
    </div>,
  );
  let slot: HTMLElement | null = null;
  await vi.waitFor(() => {
    slot = document.body.querySelector("[data-slot]");
    expect(slot, "the slot never mounted").toBeTruthy();
  });
  if (!slot) throw new Error("the slot never mounted");
  return slot;
}

test("a long body is clipped to the slot rather than growing it", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long comment body`).join(
    "\n",
  );
  const slot = await renderInSlot(thread(long));

  const card = slot.firstElementChild;
  if (!(card instanceof HTMLElement)) throw new Error("nothing rendered");

  // The invariant: a collapsed thread is the expanded card drawn and clipped. However much text it
  // holds, it must not push past the slot the row model budgeted for it.
  expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(SLOT_PX);

  // The card itself fills the slot exactly; the clipping happens on whichever inner element holds
  // the body, so look for it there rather than on the outer box.
  const clipped = [...card.querySelectorAll<HTMLElement>("*")].some(
    (el) => el.scrollHeight > el.clientHeight + 1,
  );
  expect(clipped, "nothing inside the card is clipped — the body was not truncated").toBe(true);
});

test("a short body occupies the same slot as a long one", async () => {
  const shortSlot = await renderInSlot(thread("short"));
  const shortCard = shortSlot.firstElementChild;
  if (!(shortCard instanceof HTMLElement)) throw new Error("short thread did not render");
  const shortHeight = shortCard.getBoundingClientRect().height;
  document.body.innerHTML = "";

  const longSlot = await renderInSlot(
    thread(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")),
  );
  const longCard = longSlot.firstElementChild;
  if (!(longCard instanceof HTMLElement)) throw new Error("long thread did not render");
  const longHeight = longCard.getBoundingClientRect().height;

  expect(longHeight).toBe(shortHeight);
});

test("a collapsed thread says whether Claude replied", async () => {
  // The bug this pins: replies were invisible until the thread was focused, and the badge was
  // missed entirely in review.
  const replied = await renderInSlot(thread("short", [{ author: "claude", body: "I fixed it" }]));
  expect(replied.textContent ?? "").toMatch(/claude replied/i);
  document.body.innerHTML = "";

  const silent = await renderInSlot(thread("short"));
  expect(silent.textContent ?? "").toMatch(/no reply/i);
});

test("a user reply does not claim Claude answered", async () => {
  const slot = await renderInSlot(thread("short", [{ author: "user", body: "bumping this" }]));
  expect(slot.textContent ?? "").toMatch(/no reply/i);
});
