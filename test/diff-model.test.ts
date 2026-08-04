import { test } from "vitest";
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
  anchoredCommentIds,
} from "../src/diff-model.js";
import type { DiffMetrics, DiffRow, SplitLineRow, CommentRow } from "../src/diff-model.js";
import type { Comment, DiffFile, Reply } from "../shared/types.js";

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

const file = (over: Partial<DiffFile> = {}): DiffFile => ({
  path: "a.ts",
  oldPath: "a.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  lang: "typescript",
  patch: PATCH,
  ...over,
});

const metrics = (over: Partial<DiffMetrics> = {}): DiffMetrics => ({
  lineHeight: 20,
  charsPerLine: 80,
  fileHeaderHeight: 36,
  hunkHeaderHeight: 24,
  wrap: true,
  mode: "split",
  measured: new Map<string, number>(),
  ...over,
});

test("parsePatch reads hunk headers and numbers every line", () => {
  const hunk = parsePatch(PATCH)[0];
  assert.ok(hunk);
  assert.equal(hunk.context, "function demo()");
  assert.deepEqual(
    hunk.lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]),
    [
      ["ctx", 1, 1, "one"],
      ["del", 2, null, "two"],
      ["add", null, 2, "TWO"],
      ["ctx", 3, 3, "three"],
      ["add", null, 4, "four"],
    ],
  );
});

test("parsePatch ignores the no-newline marker and returns nothing for an empty patch", () => {
  const hunks = parsePatch("@@ -1 +1 @@\n+x\n\\ No newline at end of file\n");
  assert.equal(hunks[0]?.lines.length, 1);
  assert.deepEqual(parsePatch(""), []);
});

test("unified mode emits one row per line", () => {
  const rows = buildRows([file()], "unified");
  const first = rows[0];
  const second = rows[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.kind, ROW.FILE);
  assert.equal(second.kind, ROW.HUNK);
  assert.equal(rows.filter((r) => r.kind === ROW.LINE).length, 5);
});

test("split mode pairs a deletion with its addition, producing fewer rows", () => {
  const unified = buildRows([file()], "unified").filter((r) => r.kind === ROW.LINE);
  const split = buildRows([file()], "split").filter((r) => r.kind === ROW.LINE);
  assert.equal(unified.length, 5);
  assert.equal(split.length, 4, "the -two/+TWO pair should occupy one row");

  const modified = split.find((r) => r.type === "mod");
  assert.ok(modified);
  assert.ok("left" in modified);
  assert.ok(modified.left);
  assert.ok(modified.right);
  assert.equal(modified.left.text, "two");
  assert.equal(modified.right.text, "TWO");
});

test("an unpaired addition keeps an empty left side", () => {
  const split = buildRows([file()], "split").filter((r) => r.kind === ROW.LINE);
  const added = split.find((r) => r.type === "add");
  assert.ok(added);
  assert.ok("left" in added);
  assert.ok(added.right);
  assert.equal(added.left, null);
  assert.equal(added.right.text, "four");
});

test("a binary file contributes a header and a placeholder, not lines", () => {
  const rows = buildRows([file({ binary: true, patch: "" })], "split");
  assert.deepEqual(
    rows.map((r) => r.kind),
    [ROW.FILE, ROW.SPACER],
  );
});

test("every row key is unique across files", () => {
  const rows = buildRows([file(), file({ path: "b.ts" })], "split");
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("row height wraps by character count, exactly", () => {
  const m = metrics({ charsPerLine: 10 });
  const row = splitRow({ text: "x".repeat(25) }, null);
  assert.equal(rowHeight(row, m), 60, "25 chars over 10 per line is 3 display lines");
});

test("row height uses the wider of the two sides", () => {
  const m = metrics({ charsPerLine: 10 });
  const row = splitRow({ text: "short" }, { text: "y".repeat(30) });
  assert.equal(rowHeight(row, m), 60);
});

test("wrapping off gives every line row a single line height", () => {
  const m = metrics({ charsPerLine: 10, wrap: false });
  const row = splitRow({ text: "x".repeat(500) }, null);
  assert.equal(rowHeight(row, m), 20);
});

test("a measured height overrides the computed one", () => {
  const m = metrics({ measured: new Map([["x", 137]]) });
  const row = splitRow({ text: "short" }, null);
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

  const totalHeight = offsets.at(-1);
  assert.ok(totalHeight);
  const bottom = visibleRange(offsets, totalHeight, 400, 8);
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
  assert.ok(searchRows(rows, "a.ts").some((h) => rows[h.index]?.kind === ROW.FILE));
  assert.ok(searchRows(rows, "function demo").some((h) => rows[h.index]?.kind === ROW.HUNK));
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
  const hits = [
    { index: 5, path: "a.ts" },
    { index: 12, path: "a.ts" },
    { index: 30, path: "a.ts" },
  ];
  assert.equal(nextHit(hits, 0, 1), 0);
  assert.equal(nextHit(hits, 5, 1), 1);
  assert.equal(nextHit(hits, 30, 1), 0, "forward past the last hit wraps to the first");
  assert.equal(nextHit(hits, 31, -1), 2);
  assert.equal(nextHit(hits, 12, -1), 0);
  assert.equal(nextHit(hits, 5, -1), 2, "backward from the first hit wraps to the last");
  assert.equal(nextHit([], 0, 1), null);
});

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: "c1",
  file: "a.ts",
  side: "new",
  line: 2,
  body: "this rename reads worse than the original",
  author: "user",
  status: "open",
  replies: [],
  lineContent: "",
  branch: null,
  archivedAt: null,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  ...over,
});

test("a comment becomes its own row, directly under the line it annotates", () => {
  const rows = buildRows([file()], "split", [comment()]);
  const at = rows.findIndex((r) => r.kind === ROW.COMMENT);
  const thread = rows[at];
  const preceding = rows[at - 1];
  assert.ok(thread && thread.kind === ROW.COMMENT);
  assert.ok(preceding && preceding.kind === ROW.LINE && "right" in preceding);
  assert.equal(thread.line, 2);
  assert.equal(thread.side, "new");
  assert.equal(preceding.right?.newNo, 2, "it sits under the added line, not the deleted one");
});

test("comments on the deleted side anchor to old line numbers", () => {
  const rows = buildRows([file()], "split", [comment({ side: "old", line: 2 })]);
  const at = rows.findIndex((r) => r.kind === ROW.COMMENT);
  const preceding = rows[at - 1];
  assert.ok(preceding && preceding.kind === ROW.LINE && "left" in preceding);
  assert.equal(preceding.left?.oldNo, 2);
});

test("several comments on one line share a single row", () => {
  const rows = buildRows([file()], "split", [comment(), comment({ id: "c2", body: "agreed" })]);
  const threads = rows.filter((r) => r.kind === ROW.COMMENT);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.comments.length, 2);
});

test("a comment on a line the diff no longer contains emits no row", () => {
  const rows = buildRows([file()], "split", [comment({ line: 900 })]);
  assert.equal(rows.filter((r) => r.kind === ROW.COMMENT).length, 0);
});

const slotMetrics = metrics({ commentLines: 7, commentChrome: 96 });
const slot = (over: Partial<Comment>): number => {
  const row = buildRows([file()], "split", [comment(over)]).find(
    (candidate): candidate is CommentRow => candidate.kind === ROW.COMMENT,
  );
  assert.ok(row);
  return rowHeight(row, slotMetrics);
};

test("a collapsed slot is sized from its text, one line at a time", () => {
  assert.equal(slot({ body: "short" }), 20 + 96);
  assert.equal(slot({ body: "line one\nline two\nline three" }), 60 + 96);
});

test("a collapsed slot stops growing at the cap", () => {
  const capped = 7 * 20 + 96;
  assert.equal(slot({ body: "x".repeat(50_000) }), capped);
  assert.equal(slot({ body: "y\n".repeat(500) }), capped);
});

const reply = (body: string): Reply => ({ author: "claude", body, ts: "" });

test("a replied-to thread gets one strip, however much was said", () => {
  const body = "one line";
  const bare = slot({ body });
  const one = slot({ body, replies: [reply("sure")] });
  assert.equal(one, bare + 34, "the strip is what makes a reply visible while collapsed");
  assert.equal(slot({ body, replies: Array.from({ length: 40 }, () => reply("sure")) }), one);
  assert.equal(slot({ body, replies: [reply("x".repeat(9000))] }), one);
});

test("a slot's height ignores everything expanding would reveal", () => {
  const body = "one line";
  const many = buildRows([file()], "split", [
    comment({ body }),
    comment({ id: "c2", body: "x".repeat(9000), replies: [reply("and again")] }),
  ]).find((r) => r.kind === ROW.COMMENT);
  assert.ok(many);
  assert.equal(
    rowHeight(many, slotMetrics),
    slot({ body }),
    "only the first comment is previewed, so the rest cannot resize the slot",
  );
});

test("adding a comment does not change the height of any other row", () => {
  const bare = buildRows([file()], "split");
  const withComment = buildRows([file()], "split", [comment({ body: "short" })]);
  const heights = (rows: DiffRow[]) =>
    rows.filter((r) => r.kind !== ROW.COMMENT).map((r) => rowHeight(r, slotMetrics));
  assert.deepEqual(heights(withComment), heights(bare));
  const withCommentTotal = buildOffsets(withComment, slotMetrics).at(-1);
  const bareTotal = buildOffsets(bare, slotMetrics).at(-1);
  assert.ok(withCommentTotal);
  assert.ok(bareTotal);
  assert.equal(withCommentTotal - bareTotal, 20 + 96);
});

function splitRow(
  left: Pick<SplitLineRow["left"] & { text: string }, "text"> | null,
  right: Pick<SplitLineRow["right"] & { text: string }, "text"> | null,
): SplitLineRow {
  return {
    kind: ROW.LINE,
    key: "x",
    file: file(),
    type: left && right ? "mod" : left ? "del" : "add",
    left: left ? { type: "ctx", oldNo: 1, newNo: 1, ...left } : null,
    right: right ? { type: "ctx", oldNo: 1, newNo: 1, ...right } : null,
  };
}

test("a narrowed search still finds the comments hanging off those lines", () => {
  const rows = buildRows([file()], "split", [comment({ side: "new", line: 2 })]);
  assert.equal(searchRows(rows, "reads worse", { scope: "added" }).length, 1);
  assert.equal(searchRows(rows, "reads worse", { scope: "removed" }).length, 0);
});

test("search reaches comment bodies and their replies", () => {
  const rows = buildRows([file()], "split", [
    comment({ replies: [{ author: "claude", body: "renamed it back", ts: "" }] }),
  ]);
  assert.equal(searchRows(rows, "reads worse").length, 1);
  assert.equal(searchRows(rows, "renamed it back").length, 1);
});

test("anchored ids name the comments that found a line, so the rest can be offered elsewhere", () => {
  const kept = comment({ id: "kept", line: 2 });
  const orphan = comment({ id: "orphan", line: 900 });
  const rows = buildRows([file()], "split", [kept, orphan]);
  const anchored = anchoredCommentIds(rows);
  assert.ok(anchored.has("kept"));
  assert.ok(!anchored.has("orphan"), "a comment with no line left is hidden, not lost");
  assert.equal(anchoredCommentIds(buildRows([file()], "split")).size, 0);
});
