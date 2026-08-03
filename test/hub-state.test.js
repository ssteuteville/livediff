import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { withTempXdg } from "./helpers.js";
import {
  stateDir, statePath, readState, writeState, clearState,
  pidAlive, acquireLock, releaseLock, lockPath, probeMeta,
} from "../server/hub-state.js";

test("statePath follows XDG_STATE_HOME set after import", async () => {
  await withTempXdg(async ({ state }) => {
    assert.equal(stateDir(), join(state, "livediff"));
    assert.equal(statePath(), join(state, "livediff", "hub.json"));
  });
});

test("readState returns null when no state file exists", async () => {
  await withTempXdg(async () => {
    assert.equal(await readState(), null);
  });
});

test("readState returns null on corrupt JSON rather than throwing", async () => {
  await withTempXdg(async () => {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(statePath(), "{ not json", "utf8");
    assert.equal(await readState(), null);
  });
});

test("round-trips state", async () => {
  await withTempXdg(async () => {
    const state = { pid: 1234, port: 4180, version: "0.4.0", startedAt: "2026-07-31T00:00:00.000Z" };
    await writeState(state);
    assert.deepEqual(await readState(), state);
    await clearState();
    assert.equal(await readState(), null);
  });
});

test("pidAlive is true for this process and false for an unused pid", async () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0x7ffffffe), false);
});

test("only one caller acquires the lock", async () => {
  await withTempXdg(async () => {
    assert.equal(await acquireLock(), true);
    assert.equal(await acquireLock(), false);
    await releaseLock();
    assert.equal(await acquireLock(), true);
  });
});

test("a lock older than 30s is treated as abandoned", async () => {
  await withTempXdg(async () => {
    await acquireLock();
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath(), old, old);
    assert.equal(await acquireLock(), true);
  });
});

test("probeMeta returns null when nothing is listening", async () => {
  assert.equal(await probeMeta(59_999, 200), null);
});
