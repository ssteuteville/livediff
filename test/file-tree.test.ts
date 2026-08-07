import { test } from "vitest";
import assert from "node:assert/strict";
import { buildFileTree, directoryPaths } from "../src/file-tree.js";
import type { FileTreeEntry, TreeDirNode, TreeNode } from "../src/file-tree.js";

const entry = (path: string, over: Partial<FileTreeEntry> = {}): FileTreeEntry => ({
  path,
  index: 0,
  additions: 1,
  deletions: 0,
  openComments: 0,
  ...over,
});

function dir(node: TreeNode | undefined): TreeDirNode {
  assert.ok(node, "expected a node");
  assert.equal(node.type, "dir", `expected ${node.path} to be a directory`);
  return node;
}

function names(nodes: readonly TreeNode[]): string[] {
  return nodes.map((node) => node.name);
}

test("flat paths produce files only, with no directories at all", () => {
  const tree = buildFileTree([entry("b.ts"), entry("a.ts")]);
  assert.deepEqual(names(tree), ["a.ts", "b.ts"]);
  assert.deepEqual(directoryPaths(tree), []);
});

test("directories sort before files at the same level", () => {
  const tree = buildFileTree([entry("zebra.ts"), entry("alpha/one.ts"), entry("alpha/two.ts")]);
  assert.deepEqual(names(tree), ["alpha", "zebra.ts"]);
});

test("a run of single-child directories collapses into one row", () => {
  // The whole point of compaction: this must not cost four levels of indentation.
  const tree = buildFileTree([entry("src/main/java/App.java")]);
  assert.deepEqual(names(tree), ["src/main/java"]);
  const only = dir(tree[0]);
  assert.equal(only.path, "src/main/java");
  assert.deepEqual(names(only.children), ["App.java"]);
});

test("a directory with two children is not collapsed into its parent", () => {
  const tree = buildFileTree([entry("src/app/main.ts"), entry("src/lib/util.ts")]);
  assert.deepEqual(names(tree), ["src"]);
  const src = dir(tree[0]);
  assert.deepEqual(names(src.children), ["app", "lib"]);
});

test("a directory holding one directory and one file does not collapse", () => {
  // Only a lone *directory* child folds. A file alongside it means the parent is a real level.
  const tree = buildFileTree([entry("src/nested/deep.ts"), entry("src/top.ts")]);
  const src = dir(tree[0]);
  assert.equal(src.name, "src");
  assert.deepEqual(names(src.children), ["nested", "top.ts"]);
});

test("compaction keeps the deepest path as the node identity", () => {
  // Collapse state and click targets key on this, so it has to be the real directory.
  const tree = buildFileTree([entry("a/b/c/one.ts"), entry("a/b/c/two.ts")]);
  const only = dir(tree[0]);
  assert.equal(only.name, "a/b/c");
  assert.equal(only.path, "a/b/c");
});

test("directories carry file counts aggregated from every depth", () => {
  const tree = buildFileTree([
    entry("src/app/one.ts"),
    entry("src/app/two.ts"),
    entry("src/lib/three.ts"),
  ]);
  const src = dir(tree[0]);
  assert.equal(src.files, 3);
  assert.equal(dir(src.children[0]).files, 2);
});

test("open comment counts roll up so a collapsed folder still shows there is something inside", () => {
  const tree = buildFileTree([
    entry("src/app/one.ts", { openComments: 2 }),
    entry("src/app/two.ts", { openComments: 0 }),
    entry("src/lib/three.ts", { openComments: 5 }),
  ]);
  const src = dir(tree[0]);
  assert.equal(src.openComments, 7);
  assert.equal(dir(src.children[0]).openComments, 2);
  assert.equal(dir(src.children[1]).openComments, 5);
});

test("files keep the index they had in the diff, so navigation still resolves", () => {
  const tree = buildFileTree([
    entry("b/second.ts", { index: 1 }),
    entry("a/first.ts", { index: 0 }),
  ]);
  const first = dir(tree[0]).children[0];
  assert.equal(first?.type, "file");
  assert.equal(first.entry.index, 0);
});

test("directoryPaths reaches every directory, including compacted ones", () => {
  const tree = buildFileTree([entry("src/app/one.ts"), entry("src/lib/deep/two.ts")]);
  assert.deepEqual(directoryPaths(tree).toSorted(), ["src", "src/app", "src/lib/deep"]);
});

test("a path with no basename is ignored rather than producing an empty node", () => {
  const tree = buildFileTree([entry("trailing/"), entry("real.ts")]);
  assert.deepEqual(names(tree), ["real.ts"]);
});
