import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROW,
  parsePatch,
  buildRows,
  rowHeight,
  buildOffsets,
  rowAt,
  visibleRange,
  searchRows,
  countByFile,
  nextHit,
} from "../src/diff-model.js";

const PATCH = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,4 +1,4 @@ function demo()",
  " one",
  "-two",
  "+TWO",
  " three",
  "+four",
  "",
].join("\n");

const file = (over = {}) => ({
  path: "a.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  patch: PATCH,
  ...over,
});

const metrics = (over = {}) => ({
  lineHeight: 20,
  charsPerLine: 80,
  fileHeaderHeight: 36,
  hunkHeaderHeight: 24,
  wrap: true,
  mode: "split",
  measured: new Map(),
  ...over,
});

test("parsePatch reads hunk headers and numbers every line", () => {
  const [hunk] = parsePatch(PATCH);
  assert.equal(hunk.context, "function demo()");
  assert.deepEqual(
    hunk.lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]),
    [
      ["ctx", 1, 1, "one"],
      ["del", 2, null, "two"],
      ["add", null, 2, "TWO"],
      ["ctx", 3, 3, "three"],
      ["add", null, 4, "four"],
    ]
  );
});

test("parsePatch ignores the no-newline marker and returns nothing for an empty patch", () => {
  const hunks = parsePatch("@@ -1 +1 @@\n+x\n\\ No newline at end of file\n");
  assert.equal(hunks[0].lines.length, 1);
  assert.deepEqual(parsePatch(""), []);
});

test("unified mode emits one row per line", () => {
  const rows = buildRows([file()], "unified");
  assert.equal(rows[0].kind, ROW.FILE);
  assert.equal(rows[1].kind, ROW.HUNK);
  assert.equal(rows.filter((r) => r.kind === ROW.LINE).length, 5);
});

test("split mode pairs a deletion with its addition, producing fewer rows", () => {
  const unified = buildRows([file()], "unified").filter((r) => r.kind === ROW.LINE);
  const split = buildRows([file()], "split").filter((r) => r.kind === ROW.LINE);
  assert.equal(unified.length, 5);
  assert.equal(split.length, 4, "the -two/+TWO pair should occupy one row");

  const modified = split.find((r) => r.type === "mod");
  assert.equal(modified.left.text, "two");
  assert.equal(modified.right.text, "TWO");
});

test("an unpaired addition keeps an empty left side", () => {
  const split = buildRows([file()], "split").filter((r) => r.kind === ROW.LINE);
  const added = split.find((r) => r.type === "add");
  assert.equal(added.left, null);
  assert.equal(added.right.text, "four");
});

test("a binary file contributes a header and a placeholder, not lines", () => {
  const rows = buildRows([file({ binary: true, patch: "" })], "split");
  assert.deepEqual(rows.map((r) => r.kind), [ROW.FILE, ROW.SPACER]);
});

test("every row key is unique across files", () => {
  const rows = buildRows([file(), file({ path: "b.ts" })], "split");
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("row height wraps by character count, exactly", () => {
  const m = metrics({ charsPerLine: 10 });
  const row = { kind: ROW.LINE, key: "x", left: { text: "x".repeat(25) }, right: null };
  assert.equal(rowHeight(row, m), 60, "25 chars over 10 per line is 3 display lines");
});

test("row height uses the wider of the two sides", () => {
  const m = metrics({ charsPerLine: 10 });
  const row = { kind: ROW.LINE, key: "x", left: { text: "short" }, right: { text: "y".repeat(30) } };
  assert.equal(rowHeight(row, m), 60);
});

test("wrapping off gives every line row a single line height", () => {
  const m = metrics({ charsPerLine: 10, wrap: false });
  const row = { kind: ROW.LINE, key: "x", left: { text: "x".repeat(500) }, right: null };
  assert.equal(rowHeight(row, m), 20);
});

test("a measured height overrides the computed one", () => {
  const m = metrics({ measured: new Map([["x", 137]]) });
  const row = { kind: ROW.LINE, key: "x", left: { text: "short" }, right: null };
  assert.equal(rowHeight(row, m), 137);
});

test("offsets accumulate and the total is the document height", () => {
  const rows = buildRows([file()], "split");
  const offsets = buildOffsets(rows, metrics());
  assert.equal(offsets[0], 0);
  assert.equal(offsets.length, rows.length + 1);
  // file header 36 + hunk header 24 + four single-height line rows
  assert.equal(offsets[offsets.length - 1], 36 + 24 + 4 * 20);
});

test("rowAt finds the row containing a scroll position", () => {
  const rows = buildRows([file()], "split");
  const offsets = buildOffsets(rows, metrics());
  assert.equal(rowAt(offsets, 0), 0);
  assert.equal(rowAt(offsets, 35), 0);
  assert.equal(rowAt(offsets, 36), 1);
  assert.equal(rowAt(offsets, 1e9), rows.length - 1);
});

test("visibleRange covers the viewport plus overscan and never leaves bounds", () => {
  const many = Array.from({ length: 50 }, (_, i) => file({ path: `f${i}.ts` }));
  const rows = buildRows(many, "split");
  const offsets = buildOffsets(rows, metrics());

  const range = visibleRange(offsets, 1000, 400, 8);
  assert.ok(range.start >= 0);
  assert.ok(range.end <= rows.length);
  assert.ok(range.end > range.start);

  const top = visibleRange(offsets, 0, 400, 8);
  assert.equal(top.start, 0);

  const bottom = visibleRange(offsets, offsets[rows.length], 400, 8);
  assert.equal(bottom.end, rows.length);
});

test("a viewport renders a small fraction of a large diff", () => {
  const many = Array.from({ length: 400 }, (_, i) => file({ path: `f${i}.ts` }));
  const rows = buildRows(many, "split");
  const offsets = buildOffsets(rows, metrics());
  const { start, end } = visibleRange(offsets, 5000, 800, 8);
  assert.ok(end - start < 80, `expected a small window, rendered ${end - start} of ${rows.length}`);
});

test("search finds matches in both sides of a split row", () => {
  const rows = buildRows([file()], "split");
  assert.equal(searchRows(rows, "two").length, 1, "lowercase 'two' should match the left side");
  assert.equal(searchRows(rows, "TWO", { caseSensitive: true }).length, 1);
  assert.equal(searchRows(rows, "two", { caseSensitive: true }).length, 1);
});

test("search matches file paths and hunk context, not just code", () => {
  const rows = buildRows([file()], "split");
  assert.ok(searchRows(rows, "a.ts").some((h) => rows[h.index].kind === ROW.FILE));
  assert.ok(searchRows(rows, "function demo").some((h) => rows[h.index].kind === ROW.HUNK));
});

test("scope narrows to added or removed lines — something find-in-page cannot do", () => {
  const rows = buildRows([file()], "split");
  assert.equal(searchRows(rows, "one", { scope: "added" }).length, 0, "context is not an addition");
  assert.equal(searchRows(rows, "four", { scope: "added" }).length, 1);
  assert.equal(searchRows(rows, "four", { scope: "removed" }).length, 0);
});

test("regex search works, and an invalid pattern yields no matches instead of throwing", () => {
  const rows = buildRows([file()], "split");
  assert.equal(searchRows(rows, "^T.O$", { regex: true, caseSensitive: true }).length, 1);
  assert.doesNotThrow(() => searchRows(rows, "([", { regex: true }));
  assert.equal(searchRows(rows, "([", { regex: true }).length, 0);
});

test("an empty query matches nothing", () => {
  const rows = buildRows([file()], "split");
  assert.deepEqual(searchRows(rows, ""), []);
});

test("counts are grouped per file", () => {
  const rows = buildRows([file(), file({ path: "b.ts" })], "split");
  const counts = countByFile(searchRows(rows, "TWO"));
  assert.equal(counts.get("a.ts"), 1);
  assert.equal(counts.get("b.ts"), 1);
});

test("navigation moves forward and backward, wrapping at both ends", () => {
  const hits = [{ index: 5 }, { index: 12 }, { index: 30 }];
  assert.equal(nextHit(hits, 0, 1), 0);
  assert.equal(nextHit(hits, 5, 1), 1);
  assert.equal(nextHit(hits, 30, 1), 0, "forward past the last hit wraps to the first");
  assert.equal(nextHit(hits, 31, -1), 2);
  assert.equal(nextHit(hits, 12, -1), 0);
  assert.equal(nextHit(hits, 5, -1), 2, "backward from the first hit wraps to the last");
  assert.equal(nextHit([], 0, 1), null);
});
