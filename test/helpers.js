import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Point XDG_CONFIG_HOME and XDG_STATE_HOME at fresh temp dirs for the duration of `fn`.
 * Tests must never read or write the developer's real livediff state.
 */
export async function withTempXdg(fn) {
  const root = await mkdtemp(join(tmpdir(), "livediff-test-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_STATE_HOME = state;
  try {
    await fn({ config, state, root });
  } finally {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Create a git repo at `root` with one commit, plus any requested subdirectories.
 * Returns the canonical path, since that is what git reports and what livediff stores.
 */
export async function makeRepo(root, subdirs = []) {
  await mkdir(root, { recursive: true });
  const real = await realpath(root);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: real });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: real });
  await exec("git", ["config", "user.name", "Test"], { cwd: real });
  await writeFile(join(real, "README.md"), "# test\n", "utf8");
  await exec("git", ["add", "."], { cwd: real });
  await exec("git", ["commit", "-qm", "init"], { cwd: real });
  for (const sub of subdirs) await mkdir(join(real, sub), { recursive: true });
  return real;
}
