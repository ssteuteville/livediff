import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { withTempXdg, startHub } from "./helpers.js";
import { readState, writeState, probeMeta, acquireLock, releaseLock } from "../server/hub-state.js";
import { ensureHub, resetEnsuredHub } from "../server/ensure-hub.js";

// Own this file's port band so a parallel test file never spawns a hub onto the same port.
process.env.LIVEDIFF_PORT = "4193";

/**
 * /api/shutdown responds before the process exits, so a teardown that only awaits the response
 * leaves the port held and races the next test's bind.
 */
async function stopHub() {
  const state = await readState();
  if (state) {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: "POST" }).catch(() => {});
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await probeMeta(state.port, 200))) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  resetEnsuredHub();
}

test("spawns a hub when none is running", async () => {
  await withTempXdg(async () => {
    try {
      const url = await ensureHub();
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const meta = await probeMeta(new URL(url).port);
      assert.equal(meta.name, "livediff");
    } finally {
      await stopHub();
    }
  });
});

test("reuses a healthy hub without spawning another", async () => {
  await withTempXdg(async () => {
    const hub = await startHub({ port: 4194 });
    try {
      const url = await ensureHub();
      assert.equal(url, "http://127.0.0.1:4194");
      assert.equal((await readState()).pid, hub.pid);
    } finally {
      hub.stop();
      resetEnsuredHub();
    }
  });
});

test("cleans up a state file whose pid is dead and spawns fresh", async () => {
  await withTempXdg(async () => {
    await writeState({
      pid: 0x7ffffffe,
      port: 4195,
      version: "0.4.0",
      startedAt: new Date().toISOString(),
    });
    try {
      const url = await ensureHub();
      assert.notEqual(new URL(url).port, "4195");
      assert.equal((await probeMeta(new URL(url).port)).name, "livediff");
    } finally {
      await stopHub();
    }
  });
});

test("replaces a hub reporting a different version", async () => {
  await withTempXdg(async () => {
    // A real hub always reports the current version, so a stale one has to be faked. This also
    // keeps the version-mismatch path testable without a test-only override in index.js.
    let shutdownCalled = false;
    const stale = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/shutdown") {
        shutdownCalled = true;
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => {
          stale.closeAllConnections();
          stale.close();
        }, 20);
        return;
      }
      res.end(JSON.stringify({ name: "livediff", version: "0.0.1-stale", port: 4196 }));
    });
    await new Promise((r) => stale.listen(4196, "127.0.0.1", r));
    await writeState({
      pid: process.pid,
      port: 4196,
      version: "0.0.1-stale",
      startedAt: new Date().toISOString(),
    });

    try {
      const url = await ensureHub();
      assert.equal(shutdownCalled, true);
      assert.notEqual(new URL(url).port, "4196");
      assert.equal((await probeMeta(new URL(url).port)).name, "livediff");
    } finally {
      stale.closeAllConnections();
      stale.close();
      await stopHub();
    }
  });
});

test("a caller that loses the spawn lock still gets a working hub", async () => {
  await withTempXdg(async () => {
    await acquireLock();
    const spawner = startHub({ port: 4193 });
    try {
      const [url] = await Promise.all([ensureHub(), spawner]);
      assert.equal((await probeMeta(new URL(url).port)).name, "livediff");
    } finally {
      await releaseLock();
      await stopHub();
      const hub = await spawner.catch(() => null);
      if (hub) hub.stop();
    }
  });
});
