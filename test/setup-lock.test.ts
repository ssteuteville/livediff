import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  acquireSetupLock,
  adoptSetupLock,
  SETUP_CONTINUATION_ENV,
  SetupLockedError,
} from "../server/setup/lock.js";

const exec = promisify(execFile);
const BUILT_LOCK = pathToFileURL(
  fileURLToPath(new URL("../dist-server/server/setup/lock.js", import.meta.url)),
).href;

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "livediff-setup-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const deadPid = 2 ** 22 + 12345;

async function writeOwner(path: string, owner: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(owner) + "\n");
}

test("the lock is exclusive while its owner is alive, and names itself in the error", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    const first = await acquireSetupLock(path);
    assert.equal(first.owned, true);
    const second = await acquireSetupLock(path).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(second instanceof SetupLockedError);
    assert.equal(second.owner.pid, process.pid);
    assert.match(
      second.message,
      new RegExp(`delete ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    await first.release();
    const third = await acquireSetupLock(path);
    await third.release();
    assert.deepEqual(await readdir(dir), []);
  });
});

test("a dead owner's lock on this host is reclaimed", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    await writeOwner(path, { pid: deadPid, host: hostname(), token: "dead", startedAt: "then" });
    const lock = await acquireSetupLock(path, () => false);
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, lock.token);
    await lock.release();
    assert.deepEqual(await readdir(dir), []);
  });
});

test("another host's lock is never reclaimed, even when its pid is not running here", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    await writeOwner(path, { pid: deadPid, host: "elsewhere", token: "remote", startedAt: "then" });
    await assert.rejects(
      acquireSetupLock(path, () => false),
      SetupLockedError,
    );
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, "remote");
  });
});

test("release removes only the lock it created", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    const lock = await acquireSetupLock(path);
    await writeOwner(path, { pid: process.pid, host: hostname(), token: "someone-else" });
    await lock.release();
    lock.releaseSync();
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, "someone-else");

    await rm(path);
    const again = await acquireSetupLock(path);
    again.releaseSync();
    assert.deepEqual(await readdir(dir), []);
  });
});

test("an unreadable lock is reported with its path rather than silently removed", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    await writeFile(path, "garbage");
    await assert.rejects(acquireSetupLock(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unreadable/);
      assert.ok(error.message.includes(path));
      return true;
    });
    assert.equal(await readFile(path, "utf8"), "garbage");
  });
});

test("adoption needs both the current token and the owning parent pid", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    const lock = await acquireSetupLock(path);
    assert.equal(await adoptSetupLock("wrong-token", path, process.pid), null);
    assert.equal(await adoptSetupLock(lock.token, path, process.pid + 1), null);
    const adopted = await adoptSetupLock(lock.token, path, process.pid);
    assert.ok(adopted);
    assert.equal(adopted.owned, false);
    await adopted.release();
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, lock.token);
    await lock.release();
    assert.equal(await adoptSetupLock(lock.token, path, process.pid), null);
  });
});

/**
 * Real processes: this test process plays the `--update` parent holding the lock. Its child
 * adopts it; the same token replayed by a process that is not the owner's child cannot, and
 * cannot take the lock either — so two setups never mutate at once — and once the parent
 * releases, nothing is left behind.
 */
test("a continuation token only lets the owner's own child in", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.lock");
    const script = join(dir, "adopt.mjs");
    await writeFile(
      script,
      `import { adoptSetupLock, acquireSetupLock, SETUP_CONTINUATION_ENV } from ${JSON.stringify(BUILT_LOCK)};
const [path, mode] = process.argv.slice(2);
const token = process.env[SETUP_CONTINUATION_ENV];
const adopted = await adoptSetupLock(token, path);
let acquired = "not-tried";
if (adopted === null) {
  try { const lock = await acquireSetupLock(path); acquired = "acquired"; await lock.release(); }
  catch (error) { acquired = error.name; }
}
console.log(JSON.stringify({ adopted: adopted !== null, acquired, mode }));
`,
    );
    const lock = await acquireSetupLock(path);
    const env = { ...process.env, [SETUP_CONTINUATION_ENV]: lock.token };

    const child = await exec(process.execPath, [script, path, "child"], { env });
    assert.deepEqual(JSON.parse(child.stdout), {
      adopted: true,
      acquired: "not-tried",
      mode: "child",
    });

    // Replayed from a grandchild: the trailing `:` stops sh from exec'ing node in its place.
    const replayed = await exec(
      "/bin/sh",
      ["-c", `"${process.execPath}" "${script}" "${path}" replay; :`],
      { env },
    );
    assert.deepEqual(JSON.parse(replayed.stdout), {
      adopted: false,
      acquired: "SetupLockedError",
      mode: "replay",
    });

    await lock.release();
    const stale = await exec(process.execPath, [script, path, "stale"], { env });
    assert.deepEqual(JSON.parse(stale.stdout), {
      adopted: false,
      acquired: "acquired",
      mode: "stale",
    });
    assert.deepEqual(await readdir(dir), ["adopt.mjs"]);
  });
});
