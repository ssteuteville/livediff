import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTempXdg, makeRepo, startHub } from "./helpers.js";

const exec = promisify(execFile);

/**
 * The reported failure, end to end: an agent commits everything to a feature branch, a human
 * reviews it against main and leaves comments, and `livediff comments` shows nothing — because
 * staleness was judged against HEAD while the diff being reviewed came from the merge base.
 */
async function committedFeatureBranch(root: string): Promise<string> {
  const repo = await makeRepo(join(root, "repo"));
  await writeFile(join(repo, "a.txt"), "one\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "base"], { cwd: repo });

  await exec("git", ["checkout", "-qb", "feature"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "two\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "all of the work"], { cwd: repo });
  return repo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function staleIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["stale"])) throw new Error("expected stale ids");
  return value["stale"].filter((entry): entry is string => typeof entry === "string");
}

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

interface Api {
  register(path: string, base?: string | null): Promise<string>;
  tryRegister(path: string, base: unknown): Promise<Sent>;
  comment(ws: string, file: string): Promise<string>;
  stale(ws: string, base?: string): Promise<string[]>;
  setBase(ws: string, base: unknown): Promise<Sent>;
  storedBase(ws: string): Promise<string | null>;
}

function apiFor(port: number): Api {
  const origin = `http://127.0.0.1:${port}`;
  const send = async (method: string, path: string, body: unknown): Promise<Sent> => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await res.json();
    if (!isRecord(parsed)) throw new Error(`expected an object from ${path}`);
    return { status: res.status, body: parsed };
  };
  const ok = async (
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> => {
    const { status, body: parsed } = await send(method, path, body);
    if (status >= 400) throw new Error(`${path} → ${status} ${JSON.stringify(parsed)}`);
    return parsed;
  };
  return {
    async register(path, base) {
      const body = base === undefined ? { path } : { path, base };
      return String((await ok("POST", "/api/workspaces", body))["id"]);
    },
    tryRegister(path, base) {
      return send("POST", "/api/workspaces", { path, base });
    },
    async comment(ws, file) {
      const body = { file, side: "new", line: 1, lineContent: "two\n", body: "look at this" };
      return String((await ok("POST", `/api/comments?ws=${ws}`, body))["id"]);
    },
    async stale(ws, base) {
      const query = base === undefined ? "" : `&base=${encodeURIComponent(base)}`;
      const res = await fetch(`${origin}/api/stale?ws=${ws}${query}`);
      return staleIds(await res.json());
    },
    setBase(ws, base) {
      return send("PATCH", `/api/workspaces/${ws}`, { base });
    },
    async storedBase(ws) {
      const res = await fetch(`${origin}/api/workspaces`);
      const body: unknown = await res.json();
      if (!isRecord(body) || !Array.isArray(body["workspaces"])) return null;
      for (const entry of body["workspaces"]) {
        if (!isRecord(entry) || entry["id"] !== ws) continue;
        return typeof entry["base"] === "string" ? entry["base"] : null;
      }
      return null;
    },
  };
}

test("comments on committed work are not stale when the workspace has a base", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await committedFeatureBranch(root);
    const hub = await startHub();
    try {
      const api = apiFor(hub.port);
      const ws = await api.register(repo, "main");
      const id = await api.comment(ws, "a.txt");
      assert.deepEqual(await api.stale(ws), []);

      // And the same comment is stale without a base, which is why this was reported at all.
      await api.setBase(ws, null);
      assert.deepEqual(await api.stale(ws), [id]);
    } finally {
      hub.stop();
    }
  });
});

test("the stored base survives re-registering the worktree", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await committedFeatureBranch(root);
    const hub = await startHub();
    try {
      const api = apiFor(hub.port);
      const ws = await api.register(repo, "main");
      await api.comment(ws, "a.txt");

      await api.register(repo); // plain `livediff .`
      assert.deepEqual(await api.stale(ws), []);
    } finally {
      hub.stop();
    }
  });
});

test("?base= overrides the stored base for one query", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await committedFeatureBranch(root);
    const hub = await startHub();
    try {
      const api = apiFor(hub.port);
      const ws = await api.register(repo);
      const id = await api.comment(ws, "a.txt");

      assert.deepEqual(await api.stale(ws), [id]);
      assert.deepEqual(await api.stale(ws, "main"), []);
      // The override is not persisted.
      assert.deepEqual(await api.stale(ws), [id]);
    } finally {
      hub.stop();
    }
  });
});

test("a base that does not resolve is refused rather than stored", async () => {
  // A ref git cannot resolve produces an empty diff and a clean exit, not an error — `git()`
  // returns whatever reached stdout. So an unvalidated base silently hides every comment in the
  // worktree, exactly the failure this field exists to prevent. Reject it at the boundary instead.
  await withTempXdg(async ({ root }) => {
    const repo = await committedFeatureBranch(root);
    const hub = await startHub();
    try {
      const api = apiFor(hub.port);
      const ws = await api.register(repo, "main");
      const id = await api.comment(ws, "a.txt");

      for (const bad of ["m", "ma", "mai", "definitely-not-a-ref"]) {
        const { status } = await api.setBase(ws, bad);
        assert.equal(status, 400, `expected ${bad} to be refused`);
      }

      // The good base is untouched, so the comment is still visible.
      assert.equal(await api.storedBase(ws), "main");
      assert.deepEqual(await api.stale(ws), []);
      assert.equal(id.length > 0, true);
    } finally {
      hub.stop();
    }
  });
});

test("registering with an unresolvable base fails instead of storing the typo", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await committedFeatureBranch(root);
    const hub = await startHub();
    try {
      const api = apiFor(hub.port);
      const { status } = await api.tryRegister(repo, "mian");
      assert.equal(status, 400);
    } finally {
      hub.stop();
    }
  });
});

test("a malformed base is rejected, not read as a request to clear", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await committedFeatureBranch(root);
    const hub = await startHub();
    try {
      const api = apiFor(hub.port);
      const ws = await api.register(repo, "main");

      for (const malformed of [42, {}, []]) {
        const { status } = await api.setBase(ws, malformed);
        assert.equal(status, 400, `expected ${JSON.stringify(malformed)} to be refused`);
      }
      assert.equal(await api.storedBase(ws), "main");

      // An explicit null still clears, which is the one legitimate way to get back to HEAD.
      assert.equal((await api.setBase(ws, null)).status, 200);
      assert.equal(await api.storedBase(ws), null);
    } finally {
      hub.stop();
    }
  });
});
