import type { DiffRow } from "../src/diff-model.js";
import { expect, test } from "vitest";

function rowSummary(row: DiffRow): string {
  switch (row.kind) {
    case "file":
      return row.file.path;
    case "hunk":
      return row.context;
    case "line":
      return row.type;
    case "spacer":
      return row.text;
    case "comment":
      return row.comments[0]?.body ?? "";
  }
}

test("DiffRow narrows by kind", () => {
  expect(rowSummary).toBeTypeOf("function");
});
