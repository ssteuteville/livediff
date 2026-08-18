import { test } from "vitest";
import assert from "node:assert/strict";
import { matchesGlob, pathMatcher } from "../server/glob.js";

test("a pattern with no metacharacter matches only itself", () => {
  assert.equal(matchesGlob("src/retry.ts", "src/retry.ts"), true);
  assert.equal(matchesGlob("src/retry.test.ts", "src/retry.ts"), false);
  assert.equal(matchesGlob("a/src/retry.ts", "src/retry.ts"), false);
});

test("a star stays inside one segment", () => {
  assert.equal(matchesGlob("src/retry.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/deep/retry.ts", "src/*.ts"), false);
  assert.equal(matchesGlob("src/.ts", "src/*.ts"), true, "star matches the empty run");
});

test("a globstar spans any number of segments, including zero", () => {
  assert.equal(matchesGlob("foo.ts", "**/foo.ts"), true);
  assert.equal(matchesGlob("a/foo.ts", "**/foo.ts"), true);
  assert.equal(matchesGlob("a/b/c/foo.ts", "**/foo.ts"), true);
  assert.equal(matchesGlob("a/b", "a/**/b"), true);
  assert.equal(matchesGlob("a/x/y/b", "a/**/b"), true);
});

test("a trailing globstar matches everything beneath a directory but not the directory itself", () => {
  assert.equal(matchesGlob("test/unit/a.ts", "test/**"), true);
  assert.equal(matchesGlob("test/a.ts", "test/**"), true);
  assert.equal(matchesGlob("test", "test/**"), false);
  assert.equal(matchesGlob("tests/a.ts", "test/**"), false);
});

test("a bare globstar matches every path", () => {
  assert.equal(matchesGlob("a", "**"), true);
  assert.equal(matchesGlob("a/b/c.ts", "**"), true);
});

test("a question mark matches exactly one character and never a separator", () => {
  assert.equal(matchesGlob("src/a.ts", "src/?.ts"), true);
  assert.equal(matchesGlob("src/ab.ts", "src/?.ts"), false);
  assert.equal(matchesGlob("src/a/ts", "src/?.ts"), false);
});

test("regex metacharacters in a pattern are literal", () => {
  assert.equal(matchesGlob("a+b.ts", "a+b.ts"), true);
  assert.equal(matchesGlob("aab.ts", "a+b.ts"), false);
  assert.equal(matchesGlob("v1.2.ts", "v1.2.ts"), true);
  assert.equal(matchesGlob("v1x2.ts", "v1.2.ts"), false);
});

test("matching is case-sensitive", () => {
  assert.equal(matchesGlob("SRC/a.ts", "src/*.ts"), false);
});

test("a leading bang is literal, not negation", () => {
  assert.equal(matchesGlob("test/a.ts", "!test/**"), false);
  assert.equal(matchesGlob("!test/a.ts", "!test/**"), true);
});

test("a segment that is only whitespace is a literal, not a disguised globstar", () => {
  // The `**` sentinel is NUL rather than a space precisely so this cannot collapse into `docs/**`.
  assert.equal(matchesGlob("docs/ /notes.md", "docs/ /notes.md"), true);
  assert.equal(matchesGlob("docs/deep/notes.md", "docs/ /notes.md"), false);
  assert.equal(matchesGlob("docs/a/b/notes.md", "docs/ /notes.md"), false);
});

test("a matcher unions its patterns and an empty matcher matches nothing", () => {
  const match = pathMatcher(["test/**", "src/retry.ts"]);
  assert.equal(match("test/a.ts"), true);
  assert.equal(match("src/retry.ts"), true);
  assert.equal(match("src/other.ts"), false);
  assert.equal(pathMatcher([])("anything"), false);
});
