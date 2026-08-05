import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "vitest";
import { renderCompletion } from "../server/cli-completion.js";

const exec = promisify(execFile);

test("shell completions are generated from the command metadata", () => {
  const bash = renderCompletion("bash");
  assert.match(bash, /complete -F _livediff livediff/);
  assert.match(bash, /completion/);
  assert.match(bash, /schema/);
  assert.match(bash, /--timeout/);
  assert.match(bash, /--editor/);
  assert.match(bash, /retention\.archiveWarningBytes/);

  const zsh = renderCompletion("zsh");
  assert.match(zsh, /#compdef livediff/);
  assert.match(zsh, /config_commands/);
  assert.match(zsh, /--keep-days/);

  const fish = renderCompletion("fish");
  assert.match(fish, /complete -c livediff/);
  assert.match(fish, /__fish_seen_subcommand_from config/);
  assert.match(fish, /-l no-open/);
});

test("shell completion names are validated", () => {
  assert.throws(() => renderCompletion("powershell"), /choose bash, zsh, or fish/);
});

test("generated bash completion parses in bash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "livediff-completion-"));
  const path = join(directory, "livediff.bash");
  try {
    await writeFile(path, renderCompletion("bash"), "utf8");
    const { stderr } = await exec("bash", ["-n", path]);
    assert.equal(stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
