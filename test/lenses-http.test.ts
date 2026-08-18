import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeRepo, startHub } from "./helpers.js";
import type { StartedHub } from "./helpers.js";

// Every other test file's port is already spoken for — grep the suite for 41xx before changing
// this. Sharing one is worse than a bind conflict, which scan-forward would resolve: the second
// hub probes the occupant, recognizes an equivalent livediff, and exits as redundant, so the state
// file its caller is waiting on is never written at all. That reads as a 10s hang, in a different
// test from the one that caused it.
const PORT = 4186;

/**
 * Set from the hub actually started for the current test, never assumed from PORT: a hub whose
 * preferred port is still closing scans forward, and hardcoding the request URL made every test
 * after the first one race a socket it did not own.
 */
let base = "";

interface Workspace {
  id: string;
}

interface LensLike {
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorField(value: unknown): string {
  return isRecord(value) && typeof value["error"] === "string" ? value["error"] : "";
}

function isWorkspace(value: unknown): value is Workspace {
  return isRecord(value) && typeof value["id"] === "string";
}

function isLensListResponse(value: unknown): value is { lenses: LensLike[] } {
  return isRecord(value) && Array.isArray(value["lenses"]);
}

async function json(path: string, init?: RequestInit): Promise<[number, unknown]> {
  const response = await fetch(`${base}${path}`, init);
  return [response.status, await response.json()];
}

function lens(name: string, paths: readonly string[] = ["src/**"]) {
  return { name, paths };
}

/**
 * One hub for the whole file, and a fresh workspace per test.
 *
 * Spawning a hub per test meant ten spawn/kill cycles racing each other for a port, which failed
 * intermittently and only when this file ran beside another that also starts hubs. Lens stores are
 * keyed by workspace, so a new workspace gives each test the isolation it actually needs.
 */
let hub: StartedHub | null = null;
let root = "";
let savedEnv: Record<string, string | undefined> = {};
let workspaceSeq = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "livediff-lenses-http-"));
  savedEnv = {
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
    XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
    HOME: process.env["HOME"],
  };
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  process.env["XDG_CONFIG_HOME"] = join(root, "config");
  process.env["XDG_STATE_HOME"] = join(root, "state");
  process.env["HOME"] = home;

  hub = await startHub({ port: PORT });
  base = `http://127.0.0.1:${hub.port}`;
});

afterAll(async () => {
  hub?.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function withHubAndWorkspace(fn: (args: { ws: Workspace }) => Promise<void>): Promise<void> {
  const repo = await makeRepo(join(root, `repo-${workspaceSeq++}`));
  const [, wsBody] = await json("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repo }),
  });
  assert.ok(isWorkspace(wsBody));
  await fn({ ws: wsBody });
}

/** Opens the SSE stream and returns the raw frames collected so far plus a stop function. */
function subscribe(): { frames: string[]; stop: () => void; ready: Promise<void> } {
  const ac = new AbortController();
  const frames: string[] = [];
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  void (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    if (!res.body) return;
    resolveReady();
    const reader = res.body.getReader();
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
  return { frames, stop: () => ac.abort(), ready };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("GET on a workspace with no lenses returns an empty set", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    const [status, body] = await json(`/api/lenses?ws=${ws.id}`);
    assert.equal(status, 200);
    assert.ok(isLensListResponse(body));
    assert.deepEqual(body.lenses, []);
  });
});

test("PUT a set then GET returns both lenses in order", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    const [putStatus, putBody] = await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("a"), lens("b")] }),
    });
    assert.equal(putStatus, 200);
    assert.ok(isLensListResponse(putBody));
    assert.deepEqual(
      putBody.lenses.map((l) => l.name),
      ["a", "b"],
    );

    const [getStatus, getBody] = await json(`/api/lenses?ws=${ws.id}`);
    assert.equal(getStatus, 200);
    assert.ok(isLensListResponse(getBody));
    assert.deepEqual(
      getBody.lenses.map((l) => l.name),
      ["a", "b"],
    );
  });
});

test("PUT replaces the whole set rather than merging", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("a"), lens("b")] }),
    });
    const [status, body] = await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("c")] }),
    });
    assert.equal(status, 200);
    assert.ok(isLensListResponse(body));
    assert.deepEqual(
      body.lenses.map((l) => l.name),
      ["c"],
    );

    const [, getBody] = await json(`/api/lenses?ws=${ws.id}`);
    assert.ok(isLensListResponse(getBody));
    assert.deepEqual(
      getBody.lenses.map((l) => l.name),
      ["c"],
    );
  });
});

test("POST appends a lens, and posting the same name again replaces it in place", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("a"), lens("b")] }),
    });

    const [postStatus, postBody] = await json(`/api/lenses?ws=${ws.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lens("c")),
    });
    assert.equal(postStatus, 200);
    assert.ok(isLensListResponse(postBody));
    assert.deepEqual(
      postBody.lenses.map((l) => l.name),
      ["a", "b", "c"],
    );

    const [replaceStatus, replaceBody] = await json(`/api/lenses?ws=${ws.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lens("a", ["docs/**"])),
    });
    assert.equal(replaceStatus, 200);
    assert.ok(isLensListResponse(replaceBody));
    assert.deepEqual(
      replaceBody.lenses.map((l) => l.name),
      ["a", "b", "c"],
    );
  });
});

test("DELETE with a name removes one lens; an absent name returns ok: false", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("a"), lens("b")] }),
    });

    const [removedStatus, removedBody] = await json(`/api/lenses?ws=${ws.id}&name=a`, {
      method: "DELETE",
    });
    assert.equal(removedStatus, 200);
    assert.deepEqual(removedBody, { ok: true });

    const [absentStatus, absentBody] = await json(`/api/lenses?ws=${ws.id}&name=nope`, {
      method: "DELETE",
    });
    assert.equal(absentStatus, 200);
    assert.deepEqual(absentBody, { ok: false });

    const [, getBody] = await json(`/api/lenses?ws=${ws.id}`);
    assert.ok(isLensListResponse(getBody));
    assert.deepEqual(
      getBody.lenses.map((l) => l.name),
      ["b"],
    );
  });
});

test("DELETE with no name clears the whole set", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("a"), lens("b")] }),
    });

    const [status, body] = await json(`/api/lenses?ws=${ws.id}`, { method: "DELETE" });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });

    const [, getBody] = await json(`/api/lenses?ws=${ws.id}`);
    assert.ok(isLensListResponse(getBody));
    assert.deepEqual(getBody.lenses, []);
  });
});

test("PUT with a malformed lens returns 400 naming the lens index and field", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    const [status, body] = await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [{ name: "ok", paths: ["src/**"] }, { name: "Bad Name!" }] }),
    });
    assert.equal(status, 400);
    assert.match(errorField(body), /lens 1/);
  });
});

test("GET with an unknown workspace returns 404", async () => {
  await withHubAndWorkspace(async () => {
    const [status, body] = await json("/api/lenses?ws=doesnotexist");
    assert.equal(status, 404);
    assert.ok(isRecord(body));
    assert.equal(typeof body["error"], "string");
  });
});

test("PUT, POST and DELETE each emit a lenses SSE frame naming why, and the workspace", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    const { frames, stop, ready } = subscribe();
    // The hub also watches `lenses/` and re-broadcasts its own writes with `reason: "file"`, on a
    // debounce. Counting every frame would race that; these assertions are about the API's own.
    const reasons = (): string[] =>
      frames
        .filter((f) => f.includes("event: lenses") && f.includes(`"ws":"${ws.id}"`))
        .flatMap((f) => [...f.matchAll(/"reason":"(\w+)"/g)].map((m) => m[1] ?? ""))
        .filter((reason) => reason !== "file");
    try {
      await ready;

      await json(`/api/lenses?ws=${ws.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lenses: [lens("a")] }),
      });
      await waitFor(() => reasons().length === 1);
      assert.deepEqual(reasons(), ["set"]);

      await json(`/api/lenses?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lens("b")),
      });
      await waitFor(() => reasons().length === 2);
      assert.deepEqual(reasons(), ["set", "added"]);

      await json(`/api/lenses?ws=${ws.id}&name=a`, { method: "DELETE" });
      await waitFor(() => reasons().length === 3);
      assert.deepEqual(reasons(), ["set", "added", "removed"]);
    } finally {
      stop();
    }
  });
});

test("an empty name does not clear the set — it is a client bug, not a request to wipe", async () => {
  await withHubAndWorkspace(async ({ ws }) => {
    await json(`/api/lenses?ws=${ws.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lenses: [lens("a"), lens("b")] }),
    });

    const [status, body] = await json(`/api/lenses?ws=${ws.id}&name=`, { method: "DELETE" });
    assert.equal(status, 200);
    assert.ok(isRecord(body));
    assert.equal(body["ok"], false, "an empty name matched nothing, so nothing was removed");

    const [, after] = await json(`/api/lenses?ws=${ws.id}`);
    assert.ok(isRecord(after));
    assert.ok(Array.isArray(after["lenses"]));
    assert.equal(after["lenses"].length, 2, "the set was wiped by an empty name");
  });
});
