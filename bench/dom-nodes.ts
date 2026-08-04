/**
 * Count the DOM nodes a 20k-line diff implies, by asking the core library for the syntax tokens
 * it produces per line. Node count, not parse time, is what decides whether this renders.
 */
import { execFileSync } from "node:child_process";
import { DiffFile, type SyntaxNode } from "@git-diff-view/core";

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
file.initSyntax();

const splitLines = file.splitLineLength ?? 0;
const unifiedLines = file.unifiedLineLength ?? 0;

/** Walk a hast-like node tree counting elements, which become DOM nodes one for one. */
function countNodes(node: SyntaxNode): number {
  return 1 + (node.children?.reduce((count, child) => count + countNodes(child), 0) ?? 0);
}

let tokenNodes = 0;
let sampled = 0;
for (let i = 1; i <= Math.min(splitLines, 2000); i++) {
  const line = file.getSplitLeftLine(i);
  if (line.lineNumber === undefined) continue;
  const syntax = file.getOldSyntaxLine(line.lineNumber);
  sampled++;
  for (const entry of syntax.nodeList) tokenNodes += countNodes(entry.node);
}

const perLineTokens = sampled ? tokenNodes / sampled : 0;

// Structure per rendered row, read from the library's markup: a <tr>, line-number and content
// cells, and a wrapper span around the tokens.
const CELLS_PER_ROW = { split: 5, unified: 4 };
const estimate = (rows: number, cells: number) =>
  Math.round(rows * (1 + cells + 1 + perLineTokens));

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
