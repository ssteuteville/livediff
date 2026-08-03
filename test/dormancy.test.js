import { test } from "vitest";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { withTempXdg, makeRepo, startHub } from "./helpers.js";
import { writeJsonAtomic } from "../server/atomic.js";

const PORT = 4198;
const base = `http://127.0.0.1:${PORT}`;

const meta = () => fetch(`${base}/api/meta`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a raw SSE connection and return a closer. Node 18 has no EventSource. */
async function openStream() {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const frames = [];
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          frames.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { frames, close: () => ac.abort() };
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return false;
}

test("polling starts with the first SSE client and stops with the last", async () => {
  await withTempXdg(async () => {
    const hub = await startHub({ port: PORT });
    try {
      const idle = await meta();
      assert.equal(idle.clients, 0);
      assert.equal(idle.polling, false);

      const stream = await openStream();
      assert.ok(await until(async () => (await meta()).polling === true), "polling did not start");
      assert.equal((await meta()).clients, 1);

      stream.close();
      assert.ok(await until(async () => (await meta()).polling === false), "polling did not stop");
      assert.equal((await meta()).clients, 0);
    } finally {
      hub.stop();
    }
  });
});

test("a hand-edited comments file broadcasts without a client attached", async () => {
  await withTempXdg(async ({ root, config }) => {
    const repo = await makeRepo(join(root, "handedit"));
    const hub = await startHub({ port: PORT });
    let stream;
    try {
      const ws = await fetch(`${base}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repo }),
      }).then((r) => r.json());

      stream = await openStream();
      // Bypass the API entirely, the way a curious user with an editor would.
      await writeJsonAtomic(join(config, "livediff", "comments", `${ws.id}.json`), {
        comments: [
          { id: "deadbeef", file: "README.md", side: "new", line: 1, body: "hand edited", status: "open", replies: [] },
        ],
      });

      const sawComments = await until(() => stream.frames.some((f) => f.includes("event: comments")));
      assert.ok(sawComments, `no comments frame; saw: ${JSON.stringify(stream.frames)}`);
    } finally {
      stream?.close();
      hub.stop();
    }
  });
});

test("a workspace whose directory is deleted is pruned while a client watches", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "doomed"));
    const hub = await startHub({ port: PORT });
    let stream;
    try {
      await fetch(`${base}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repo }),
      });
      const before = await fetch(`${base}/api/workspaces`).then((r) => r.json());
      assert.equal(before.workspaces.length, 1);

      stream = await openStream();
      await rm(repo, { recursive: true, force: true });

      const pruned = await until(async () => {
        const { workspaces } = await fetch(`${base}/api/workspaces`).then((r) => r.json());
        return workspaces.length === 0;
      });
      assert.ok(pruned, "workspace was not pruned");
    } finally {
      stream?.close();
      hub.stop();
    }
  });
});
