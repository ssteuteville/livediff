/**
 * Count the DOM nodes a 20k-line diff implies, by asking the core library for the syntax tokens
 * it produces per line. Node count, not parse time, is what decides whether this renders.
 */
import { execFileSync } from "node:child_process";
import { DiffFile } from "@git-diff-view/core";

const ROOT = process.argv[2];
const patch = execFileSync("git", ["diff", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 1 << 28,
});

const file = new DiffFile("f.ts", "", "f.ts", "", [patch], "typescript", "typescript");
file.init();
file.buildSplitDiffLines();
file.buildUnifiedDiffLines();
file.initSyntaxDiff?.();

const splitLines = file.splitLineLength ?? 0;
const unifiedLines = file.unifiedLineLength ?? 0;

/** Walk a hast-like node tree counting elements, which become DOM nodes one for one. */
function countNodes(node) {
  if (!node || typeof node !== "object") return 0;
  const children = node.children ?? [];
  return 1 + children.reduce((n, c) => n + countNodes(c), 0);
}

let tokenNodes = 0;
let sampled = 0;
for (let i = 1; i <= Math.min(splitLines, 2000); i++) {
  const line = file.getSplitLeftLine?.(i) ?? file.getNewPlainLine?.(i);
  const syntax = line?.syntax?.nodeList ?? line?.syntax;
  if (!syntax) continue;
  sampled++;
  const list = Array.isArray(syntax) ? syntax : [syntax];
  for (const entry of list) tokenNodes += countNodes(entry.node ?? entry);
}

const perLineTokens = sampled ? tokenNodes / sampled : 0;

// Structure per rendered row, read from the library's markup: a <tr>, line-number and content
// cells, and a wrapper span around the tokens.
const CELLS_PER_ROW = { split: 5, unified: 4 };
const estimate = (rows, cells) => Math.round(rows * (1 + cells + 1 + perLineTokens));

console.log(
  JSON.stringify(
    {
      splitLines,
      unifiedLines,
      sampledLines: sampled,
      avgTokenNodesPerLine: +perLineTokens.toFixed(1),
      estimatedDomNodes: {
        split: estimate(splitLines, CELLS_PER_ROW.split),
        unified: estimate(unifiedLines, CELLS_PER_ROW.unified),
      },
    },
    null,
    2,
  ),
);
