import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { withTempXdg, makeRepo, startHub } from "./helpers.js";
import { openReview, reviewFor, closeReview, resetReviews } from "../server/reviews.js";

const PORT = 4199;
const base = `http://127.0.0.1:${PORT}`;

interface Review {
  reviewId: string;
}

interface Workspace {
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReview(value: unknown): value is Review {
  return isRecord(value) && typeof value["reviewId"] === "string";
}

function isWorkspace(value: unknown): value is Workspace {
  return isRecord(value) && typeof value["id"] === "string";
}

function isReviewResponse(value: unknown): value is { review: Review | null } {
  return isRecord(value) && (value["review"] === null || isReview(value["review"]));
}

async function json(path: string, init?: RequestInit): Promise<[number, unknown]> {
  const response = await fetch(`${base}${path}`, init);
  return [response.status, await response.json()];
}

test("a second open for the same workspace attaches to the existing request", () => {
  resetReviews();
  const first = openReview("aaaaaaaa");
  const second = openReview("aaaaaaaa");
  assert.equal(second.reviewId, first.reviewId);
  const review = reviewFor("aaaaaaaa");
  assert.ok(review);
  assert.equal(review.reviewId, first.reviewId);
});

test("completing a request clears it, and completing twice returns null", () => {
  resetReviews();
  const request = openReview("bbbbbbbb");
  const closed = closeReview(request.reviewId);
  assert.ok(closed);
  assert.equal(closed.reviewId, request.reviewId);
  assert.equal(closeReview(request.reviewId), null);
  assert.equal(reviewFor("bbbbbbbb"), null);
});

test("different workspaces get independent requests", () => {
  resetReviews();
  const a = openReview("cccccccc");
  const b = openReview("dddddddd");
  assert.notEqual(a.reviewId, b.reviewId);
});

test("review lifecycle over HTTP broadcasts open and done", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "review"));
    const hub = await startHub({ port: PORT });
    const ac = new AbortController();
    const frames: string[] = [];
    try {
      const [, ws] = await json("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repo }),
      });
      assert.ok(isWorkspace(ws));

      const res = await fetch(`${base}/api/events`, { signal: ac.signal });
      assert.ok(res.body);
      const reader = res.body.getReader();
      void (async () => {
        const decoder = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) !== -1) {
              frames.push(buf.slice(0, i));
              buf = buf.slice(i + 2);
            }
          }
        } catch {
          /* aborted */
        }
      })();

      const [openStatus, request] = await json("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ws: ws.id }),
      });
      assert.equal(openStatus, 201);
      assert.ok(isReview(request));

      const [getStatus, current] = await json(`/api/reviews?ws=${ws.id}`);
      assert.equal(getStatus, 200);
      assert.ok(isReviewResponse(current));
      assert.ok(current.review);
      assert.equal(current.review.reviewId, request.reviewId);

      const [doneStatus] = await json(`/api/reviews/${request.reviewId}/done`, { method: "POST" });
      assert.equal(doneStatus, 200);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !frames.some((f) => f.includes('"state":"done"'))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(
        frames.some((f) => f.includes("event: review") && f.includes('"state":"open"')),
        `no open frame: ${JSON.stringify(frames)}`,
      );
      assert.ok(
        frames.some((f) => f.includes('"state":"done"')),
        `no done frame: ${JSON.stringify(frames)}`,
      );

      const [doneAgain] = await json(`/api/reviews/${request.reviewId}/done`, { method: "POST" });
      assert.equal(doneAgain, 404);

      const [emptyStatus, empty] = await json(`/api/reviews?ws=${ws.id}`);
      assert.equal(emptyStatus, 200);
      assert.ok(isReviewResponse(empty));
      assert.equal(empty.review, null);
    } finally {
      ac.abort();
      hub.stop();
    }
  });
});
