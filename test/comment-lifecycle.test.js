import { test } from "vitest";
import assert from "node:assert/strict";
import {



  isOrphaned,
  shouldArchive,
  shouldPurge,
  daysUntilPurge,
} from "../server/comment-lifecycle.js";
import { ORPHAN_ARCHIVE_DAYS, RESOLVED_ARCHIVE_DAYS, PURGE_DAYS } from "../server/constants.js";

const NOW = Date.parse("2026-07-31T00:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const comment = (over = {}) => ({
  id: "aaaaaaaa",
  file: "src/app.js",
  status: "open",
  archivedAt: null,
  updatedAt: daysAgo(0),
  ...over,
});

test("thresholds are 5, 30 and 200 days", () => {
  assert.equal(ORPHAN_ARCHIVE_DAYS, 5);
  assert.equal(RESOLVED_ARCHIVE_DAYS, 30);
  assert.equal(PURGE_DAYS, 200);
});

test("a file among the changed paths is not orphaned", () => {
  assert.equal(isOrphaned(comment(), new Set(["src/app.js"])), false);
});

test("a file absent from the changed paths is orphaned", () => {
  assert.equal(isOrphaned(comment(), new Set(["other.js"])), true);
});

test("an orphaned comment archives only after 5 days", () => {
  const young = comment({ updatedAt: daysAgo(4) });
  const old = comment({ updatedAt: daysAgo(6) });
  assert.equal(shouldArchive(young, { orphaned: true, now: NOW }), false);
  assert.equal(shouldArchive(old, { orphaned: true, now: NOW }), true);
});

test("a resolved comment still in the diff archives only after 30 days", () => {
  const young = comment({ status: "resolved", updatedAt: daysAgo(29) });
  const old = comment({ status: "resolved", updatedAt: daysAgo(31) });
  assert.equal(shouldArchive(young, { orphaned: false, now: NOW }), false);
  assert.equal(shouldArchive(old, { orphaned: false, now: NOW }), true);
});

test("an open comment still in the diff never archives, however old", () => {
  const ancient = comment({ updatedAt: daysAgo(900) });
  assert.equal(shouldArchive(ancient, { orphaned: false, now: NOW }), false);
});

test("an already archived comment does not archive again", () => {
  const archived = comment({ archivedAt: daysAgo(1), updatedAt: daysAgo(90) });
  assert.equal(shouldArchive(archived, { orphaned: true, now: NOW }), false);
});

test("purging happens only after 200 archived days", () => {
  assert.equal(shouldPurge(comment({ archivedAt: daysAgo(199) }), NOW), false);
  assert.equal(shouldPurge(comment({ archivedAt: daysAgo(201) }), NOW), true);
});

test("a comment that was never archived never purges", () => {
  assert.equal(shouldPurge(comment({ updatedAt: daysAgo(900) }), NOW), false);
});

test("daysUntilPurge counts down from 200", () => {
  assert.equal(daysUntilPurge(comment({ archivedAt: daysAgo(6) }), NOW), 194);
  assert.equal(daysUntilPurge(comment({ archivedAt: null }), NOW), null);
});
