import assert from "node:assert/strict";
import { test } from "vitest";
import { renderCompletion } from "../server/cli-completion.js";

test("shell completions are generated from the command metadata", () => {
  const bash = renderCompletion("bash");
  assert.match(bash, /complete -F _livediff livediff/);
  assert.match(bash, /completion/);
  assert.match(bash, /schema/);

  const zsh = renderCompletion("zsh");
  assert.match(zsh, /#compdef livediff/);
  assert.match(zsh, /config_commands/);

  const fish = renderCompletion("fish");
  assert.match(fish, /complete -c livediff/);
  assert.match(fish, /__fish_seen_subcommand_from config/);
});

test("shell completion names are validated", () => {
  assert.throws(() => renderCompletion("powershell"), /choose bash, zsh, or fish/);
});
