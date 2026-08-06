import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { renderCliReference } from "../scripts/generate-cli-docs.js";
import { describeCli, COMMANDS } from "../server/cli-help.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("docs/CLI.md matches the command registry (no drift)", async () => {
  const checkedIn = await readFile(join(repoRoot, "docs", "CLI.md"), "utf8");
  // Two different version strings must render identical output — the body must never depend on it.
  const rendered = renderCliReference(describeCli("0.0.0-test"));
  assert.equal(rendered, checkedIn);
});

test("every top-level command is documented in README", async () => {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  for (const command of COMMANDS) {
    if (command.id === "help") continue;
    assert.match(
      readme,
      new RegExp(`\\b${command.name}\\b`),
      `README.md should mention the "${command.name}" command`,
    );
  }
});
