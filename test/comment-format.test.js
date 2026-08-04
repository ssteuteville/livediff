import { test } from "vitest";
import assert from "node:assert/strict";
import {
  COMMENT_STATUSES,
  filterByStatus,
  formatComments,
  emptyMessage,
} from "../server/comment-format.js";

const comment = (over = {}) => ({
  id: "aaaaaaaa",
  file: "src/app.js",
  line: 12,
  lineContent: "  const x = 1;\n",
  body: "rename this",
  status: "open",
  replies: [],
  ...over,
});

test("COMMENT_STATUSES lists exactly the accepted values", () => {
  assert.deepEqual(COMMENT_STATUSES, ["open", "resolved", "all"]);
});

test("filterByStatus selects by status, and 'all' passes everything", () => {
  const list = [comment(), comment({ id: "bbbbbbbb", status: "resolved" })];
  assert.deepEqual(
    filterByStatus(list, "open").map((c) => c.id),
    ["aaaaaaaa"],
  );
  assert.deepEqual(
    filterByStatus(list, "resolved").map((c) => c.id),
    ["bbbbbbbb"],
  );
  assert.equal(filterByStatus(list, "all").length, 2);
});

test("formatComments prints id, location, the quoted anchor, and the body", () => {
  const text = formatComments([comment()]);
  assert.equal(text, "aaaaaaaa  src/app.js:12\n    | const x = 1;\n    rename this");
});

test("formatComments truncates a long anchor to 120 characters", () => {
  const long = "x".repeat(300);
  const text = formatComments([comment({ lineContent: long })]);
  const anchorLine = text.split("\n").find((l) => l.startsWith("    | "));
  const anchor = anchorLine.slice("    | ".length);
  assert.equal(anchor.length, 120);
  assert.ok(anchor.endsWith("…"));
});

test("formatComments omits the anchor line when there is no line content", () => {
  const text = formatComments([comment({ lineContent: "   \n" })]);
  assert.doesNotMatch(text, /\|/);
});

test("formatComments counts replies, singular and plural", () => {
  const one = formatComments([comment({ replies: [{ body: "a" }] })]);
  assert.match(one, /\(1 reply\)/);
  const two = formatComments([comment({ replies: [{ body: "a" }, { body: "b" }] })]);
  assert.match(two, /\(2 replies\)/);
});

test("formatComments omits the reply line when there are none", () => {
  assert.doesNotMatch(formatComments([comment()]), /repl/);
});

test("emptyMessage reports a bare absence when there are no comments at all", () => {
  assert.equal(emptyMessage([], "open"), "no comments");
});

test("emptyMessage names the comments hidden by the filter", () => {
  const list = [comment({ status: "resolved" }), comment({ id: "b", status: "resolved" })];
  assert.equal(emptyMessage(list, "open"), "no open comments (2 resolved — see --status all)");
});

test("emptyMessage works symmetrically for the resolved filter", () => {
  assert.equal(
    emptyMessage([comment()], "resolved"),
    "no resolved comments (1 open — see --status all)",
  );
});
