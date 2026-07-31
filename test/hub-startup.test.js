import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { withTempXdg, startHub } from "./helpers.js";
import { readState, probeMeta, isBlockedPort } from "../server/hub-state.js";

test("never binds a port that fetch refuses to connect to", async () => {
  await withTempXdg(async () => {
    // 4190 (ManageSieve) is on the WHATWG bad-port list: bindable via net, unreachable via fetch.
    assert.equal(isBlockedPort(4190), true);
    const hub = await startHub({ port: 4190 });
    try {
      assert.notEqual(hub.port, 4190);
      assert.equal((await probeMeta(hub.port)).name, "livediff");
    } finally {
      hub.stop();
    }
  });
});

test("hub writes hub.json with its real port and identifies itself", async () => {
  await withTempXdg(async () => {
    const hub = await startHub({ port: 4187 });
    try {
      const state = await readState();
      assert.equal(state.port, 4187);
      assert.equal(state.pid, hub.pid);
      const meta = await probeMeta(4187);
      assert.equal(meta.name, "livediff");
      assert.equal(meta.port, 4187);
      assert.match(meta.version, /^\d+\.\d+\.\d+/);
    } finally {
      hub.stop();
    }
  });
});

test("falls back past a port held by a non-livediff process", async () => {
  await withTempXdg(async () => {
    const squatter = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "something-else" }));
    });
    await new Promise((r) => squatter.listen(4188, "127.0.0.1", r));
    try {
      const hub = await startHub({ port: 4188 });
      try {
        assert.notEqual(hub.port, 4188);
        assert.equal((await probeMeta(hub.port)).name, "livediff");
      } finally {
        hub.stop();
      }
    } finally {
      squatter.closeAllConnections();
      squatter.close();
    }
  });
});

test("a redundant hub on an equivalent hub's port exits instead of binding", async () => {
  await withTempXdg(async () => {
    const first = await startHub({ port: 4192 });
    try {
      // The redundant process exits 0 without rewriting hub.json, so startHub times out.
      await assert.rejects(() => startHub({ port: 4192, timeoutMs: 2000 }), /did not start/);
      assert.equal((await readState()).pid, first.pid);
    } finally {
      first.stop();
    }
  });
});

test("POST /api/shutdown exits the hub and clears state", async () => {
  await withTempXdg(async () => {
    const hub = await startHub({ port: 4189 });
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/shutdown`, { method: "POST" });
    assert.equal(res.status, 200);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await probeMeta(hub.port, 200))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(await probeMeta(hub.port, 200), null);
    assert.equal(await readState(), null);
  });
});
