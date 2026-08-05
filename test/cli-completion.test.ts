import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  assert.match(fish, /function __livediff_config_action/);
  assert.match(fish, /function __livediff_config_key/);
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

test("nested action flags are reachable in bash completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "livediff-completion-"));
  try {
    await writeFile(join(directory, "livediff.bash"), renderCompletion("bash"), "utf8");
    const complete = async (words: readonly string[]): Promise<string> => {
      const script = [
        `source ${directory}/livediff.bash`,
        `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")})`,
        `COMP_CWORD=${words.length - 1}`,
        "_livediff",
        'printf "%s\\n" "${COMPREPLY[@]}"',
      ].join("\n");
      return (await exec("bash", ["-c", script])).stdout;
    };

    assert.match(await complete(["livediff", "config", "edit", "--"]), /--editor/);
    assert.match(await complete(["livediff", "config", "schema", "--"]), /--update/);
    assert.match(
      await complete(["livediff", "completion", "install", "--"]),
      /--activate/,
      "completion actions must reach their own flags too",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dynamic completion candidates are never re-expanded as shell words", async () => {
  const directory = await mkdtemp(join(tmpdir(), "livediff-completion-"));
  const marker = join(directory, "PWNED");
  try {
    await writeFile(join(directory, "livediff.bash"), renderCompletion("bash"), "utf8");
    // A workspace path is untrusted data. Stand in a fake `livediff` that emits one carrying a
    // command substitution and a space, then drive the completion function the way bash would.
    await writeFile(
      join(directory, "livediff"),
      `#!/bin/bash\nprintf '%s\\t%s\\n' '/tmp/$(touch ${marker})/my repo' 'label'\n`,
      { mode: 0o755 },
    );
    const script = [
      `source ${directory}/livediff.bash`,
      "COMP_WORDS=(livediff open '')",
      "COMP_CWORD=2",
      "_livediff",
      'printf "%s\\n" "${COMPREPLY[@]}"',
    ].join("\n");
    const { stdout } = await exec("bash", ["-c", script], {
      env: { ...process.env, PATH: `${directory}:${process.env["PATH"] ?? ""}` },
    });

    assert.equal(stdout.trim(), "/tmp/$(touch " + marker + ")/my repo");
    await assert.rejects(stat(marker), "the candidate must not have been executed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
