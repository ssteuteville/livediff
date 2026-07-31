import { randomUUID } from "node:crypto";

/**
 * A review request is a "someone is waiting on you" marker: `livediff <path> --wait` opens one,
 * the UI shows a Done button while it is open, and clicking Done releases the waiting CLI.
 *
 * Deliberately in-memory. The hub no longer exits on its own, so there is nothing to survive; and
 * a request that outlived the process that was waiting on it would be a button that does nothing.
 */

const byId = new Map();
const byWorkspace = new Map();

/** Open a request for `ws`, or return the one already open so a second waiter attaches to it. */
export function openReview(ws) {
  const existing = byWorkspace.get(ws);
  if (existing) return existing;
  const request = { reviewId: randomUUID().slice(0, 8), ws, startedAt: new Date().toISOString() };
  byId.set(request.reviewId, request);
  byWorkspace.set(ws, request);
  return request;
}

export function reviewFor(ws) {
  return byWorkspace.get(ws) ?? null;
}

export function getReview(reviewId) {
  return byId.get(reviewId) ?? null;
}

function close(reviewId) {
  const request = byId.get(reviewId);
  if (!request) return null;
  byId.delete(reviewId);
  byWorkspace.delete(request.ws);
  return request;
}

export const completeReview = close;
export const cancelReview = close;

/** Test seam: drop all state between cases. */
export function resetReviews() {
  byId.clear();
  byWorkspace.clear();
}
