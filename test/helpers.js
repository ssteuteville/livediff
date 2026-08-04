import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SERVER = fileURLToPath(new URL("../dist-server/server/index.js", import.meta.url));

/**
 * Point XDG_CONFIG_HOME, XDG_STATE_HOME and HOME at fresh temp dirs for the duration of `fn`.
 * Tests must never read or write the developer's real livediff state — HOME is included because
 * `os.homedir()` honours it, and doctor inspects ~/.claude/skills.
 */
export async function withTempXdg(fn) {
  const root = await mkdtemp(join(tmpdir(), "livediff-test-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
  };
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_STATE_HOME = state;
  process.env.HOME = home;
  try {
    await fn({ config, state, home, root });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

/**
 * Spawn a real hub inheriting the current temp XDG env. Resolves once *this* child writes
 * hub.json — matching on pid, because an already-running hub's state file would otherwise make
 * this return instantly and leak the child. Returns a `stop()` that kills the process.
 */
export async function startHub({ port = 0, timeoutMs = 10_000 } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LIVEDIFF_PORT: String(port || 4181) },
    stdio: "ignore",
    detached: false,
  });
  const state = join(process.env.XDG_STATE_HOME, "livediff", "hub.json");
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const parsed = JSON.parse(await readFile(state, "utf8"));
      if (parsed.pid === child.pid && parsed.port) {
        return { ...parsed, stop: () => child.kill("SIGKILL") };
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`hub did not start within ${timeoutMs}ms`);
}
