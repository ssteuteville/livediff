# livediff v0.4 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `livediff <path>` work in any git worktree with no server to start by hand, with the hub as the single writer to all state.

**Architecture:** The CLI gains an `ensureHub()` step that auto-starts a detached hub process, discovers its port from a state file, and replaces it on version mismatch. With a hub guaranteed running, the CLI's dual-path filesystem fallback is deleted and it becomes a pure HTTP client — making the hub the sole writer to `workspaces.json` and `comments/`. Path arguments normalize through `git rev-parse --show-toplevel` so a worktree maps to exactly one workspace.

**Tech Stack:** Node ≥18, ESM, zero runtime dependencies for server code, `node:test` for tests, existing `@git-diff-view/react` frontend untouched.

**Spec:** `docs/superpowers/specs/2026-07-31-livediff-cli-first-design.md` — this plan covers §4, §6, §8, and the §1 defects. Dormancy (§5), reviews (§7), UI (§9), doctor/packaging (§10), and doc rewrites (§11) are Plan 2.

## Global Constraints

- Node ≥18. No syntax or API newer than Node 18 (no `node:sqlite`, no `Array.prototype.group`).
- **Zero new runtime dependencies.** `package.json` `dependencies` must not grow. `devDependencies` must not grow either — tests use built-in `node:test`.
- ESM only (`"type": "module"`). Use `node:` prefixed imports for builtins.
- Server binds `127.0.0.1` only. Never `0.0.0.0`.
- Config (`workspaces.json`, `comments/`) stays in `$XDG_CONFIG_HOME/livediff` (default `~/.config/livediff`). Runtime state (`hub.json`, `hub.lock`, `hub.log`) goes in `$XDG_STATE_HOME/livediff` (default `~/.local/state/livediff`).
- Every JSON write to disk must be atomic (temp file + `rename`).
- Prefer no comments; when one is needed it explains _why_, not _what_.
- Commit messages use Conventional Commits: `type(scope): subject`.
- Tests must not touch the real `~/.config/livediff` or `~/.local/state/livediff`. Every test sets `XDG_CONFIG_HOME` and `XDG_STATE_HOME` to a temp dir.
- `node --test` runs test **files** in parallel. Any file that spawns a hub must pin its own `LIVEDIFF_PORT` band at module top so two files never race for the same port — a second hub finding an equivalent hub on its port exits by design, which would hang the other file's test. Assigned bands: `hub-startup.test.js` → 4187–4190, `ensure-hub.test.js` → 4191–4195, `cli.test.js` → 4196–4199.

---

## File Structure

**Create:**

- `server/atomic.js` — `writeJsonAtomic(file, data)`. Sole owner of durable-write semantics.
- `server/hub-state.js` — hub runtime state: `hub.json` read/write, spawn lock, liveness, `/api/meta` probing. Knows nothing about spawning.
- `server/ensure-hub.js` — the `ensureHub()` state machine: probe, version-check, spawn, wait. Depends on `hub-state.js`.
- `server/migrations.js` — one-time data migrations run by the hub at startup.
- `test/atomic.test.js`, `test/registry.test.js`, `test/migrations.test.js`, `test/hub-state.test.js`, `test/ensure-hub.test.js`, `test/cli.test.js`
- `test/helpers.js` — temp XDG dirs, temp git repos, hub spawning for integration tests.

**Modify:**

- `server/registry.js` — lazy path resolution, atomic writes, toplevel normalization in `addWorkspace`.
- `server/comments.js` — atomic writes, add `mergeInto(fromWsId, intoWsId)`.
- `server/git.js` — add `toplevel(cwd)`.
- `server/index.js` — `/api/meta` gains `name` + `version`, add `POST /api/shutdown`, port fallback on listen, write `hub.json`, run migrations at startup.
- `server/cli.js` — full rewrite as a pure HTTP client.
- `package.json` — add `test` script.

---

### Task 1: Test harness and atomic JSON writes

**Files:**

- Create: `server/atomic.js`
- Create: `test/helpers.js`
- Create: `test/atomic.test.js`
- Modify: `server/registry.js` (lines 18–22, 42–45)
- Modify: `server/comments.js` (lines 61–65)
- Modify: `package.json` (scripts)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `writeJsonAtomic(file: string, data: unknown): Promise<void>` from `server/atomic.js`
  - `withTempXdg(fn: (dirs: {config: string, state: string}) => Promise<void>): Promise<void>` from `test/helpers.js`
  - `registryPath(): string` from `server/registry.js` — **now computed per call**, not a module constant.

- [ ] **Step 1: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "node --test test/"
```

- [ ] **Step 2: Write the test helper**

Create `test/helpers.js`:

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
```

- [ ] **Step 3: Write the failing test for atomic writes**

Create `test/atomic.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempXdg } from "./helpers.js";
import { writeJsonAtomic } from "../server/atomic.js";

test("writes JSON and creates missing parent directories", async () => {
  await withTempXdg(async ({ root }) => {
    const file = join(root, "nested", "deeper", "data.json");
    await writeJsonAtomic(file, { hello: "world" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { hello: "world" });
  });
});

test("leaves no temp files behind", async () => {
  await withTempXdg(async ({ root }) => {
    const file = join(root, "data.json");
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });
    const entries = await readdir(root);
    assert.deepEqual(entries, ["data.json"]);
  });
});

test("overwrites an existing file completely, not partially", async () => {
  await withTempXdg(async ({ root }) => {
    const file = join(root, "data.json");
    await writeJsonAtomic(file, { padding: "x".repeat(5000) });
    await writeJsonAtomic(file, { small: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { small: true });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../server/atomic.js'`

- [ ] **Step 5: Implement atomic writes**

Create `server/atomic.js`:

```js
import { writeFile, rename, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";

/**
 * rename(2) is atomic on POSIX, so a reader sees either the previous file or the complete new
 * one — never a truncated write from a crash mid-flush.
 */
export async function writeJsonAtomic(file, data) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS — 3 tests

- [ ] **Step 7: Make the registry path lazy and its writes atomic**

In `server/registry.js`, delete line 18 (`const REGISTRY = join(configDir(), "workspaces.json");`) and replace the `registryPath` export at lines 20–22 with:

```js
export function registryPath() {
  return join(configDir(), "workspaces.json");
}
```

Replace every remaining use of the `REGISTRY` constant with a `registryPath()` call — in `readRegistry` (line 33), `writeRegistry` (lines 43–44), and `registrySignature` (line 102).

Replace `writeRegistry` entirely:

```js
async function writeRegistry(workspaces) {
  await writeJsonAtomic(registryPath(), { workspaces });
}
```

Add to the imports at the top of the file:

```js
import { writeJsonAtomic } from "./atomic.js";
```

`mkdir` and `writeFile` are no longer used by `writeRegistry`; leave the `node:fs/promises` import as-is since `readFile` and `stat` are still needed, but drop `writeFile` and `mkdir` from it.

- [ ] **Step 8: Make comment writes atomic**

In `server/comments.js`, replace `writeComments` (lines 61–65):

```js
async function writeComments(wsId, comments) {
  await writeJsonAtomic(storePath(wsId), { comments });
}
```

Add to the imports:

```js
import { writeJsonAtomic } from "./atomic.js";
```

Leave the `node:fs/promises` import untouched — `migrateLegacy` still uses `mkdir` and `writeFile` at lines 43–44.

- [ ] **Step 9: Write the failing test for lazy registry paths**

Create `test/registry.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { withTempXdg } from "./helpers.js";
import { registryPath, readRegistry } from "../server/registry.js";

test("registryPath follows XDG_CONFIG_HOME set after import", async () => {
  await withTempXdg(async ({ config }) => {
    assert.equal(registryPath(), join(config, "livediff", "workspaces.json"));
  });
});

test("readRegistry returns an empty list when no registry exists", async () => {
  await withTempXdg(async () => {
    assert.deepEqual(await readRegistry(), []);
  });
});
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 5 tests

- [ ] **Step 11: Commit**

```bash
git add package.json server/atomic.js server/registry.js server/comments.js test/
git commit -m "feat(livediff): atomic JSON writes and lazy config paths"
```

---

### Task 2: Worktree toplevel normalization

**Files:**

- Modify: `server/git.js` (add export near `isGitRepo`, line 46)
- Modify: `server/registry.js` (`addWorkspace`, lines 48–64)
- Modify: `server/index.js` (POST `/api/workspaces` handler, lines 135–143)
- Modify: `test/helpers.js`
- Modify: `test/registry.test.js`

**Interfaces:**

- Consumes: `writeJsonAtomic` (Task 1), `registryPath()` (Task 1).
- Produces:
  - `toplevel(cwd: string): Promise<string | null>` from `server/git.js`
  - `addWorkspace(path: string, label?: string): Promise<Workspace>` — **now async-normalizing and throwing** on non-worktree paths. `Workspace` is `{ id, path, label, addedAt }`.
  - `makeRepo(root: string, subdirs?: string[]): Promise<string>` from `test/helpers.js`

- [ ] **Step 1: Add the git repo test helper**

Append to `test/helpers.js`:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";

const exec = promisify(execFile);

/** Create a git repo at `root` with one commit, plus any requested subdirectories. */
export async function makeRepo(root, subdirs = []) {
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "# test\n", "utf8");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "init"], { cwd: root });
  for (const sub of subdirs) await mkdir(join(root, sub), { recursive: true });
  return root;
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/registry.test.js`:

```js
import { join } from "node:path";
import { withTempXdg, makeRepo } from "./helpers.js";
import { addWorkspace, idFor, readRegistry } from "../server/registry.js";

test("a subdirectory registers as the worktree root, not itself", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src/deep"]);
    const ws = await addWorkspace(join(repo, "src", "deep"));
    assert.equal(ws.path, repo);
    assert.equal(ws.id, idFor(repo));
  });
});

test("registering root then a subdirectory yields one workspace", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await addWorkspace(repo);
    await addWorkspace(join(repo, "src"));
    assert.equal((await readRegistry()).length, 1);
  });
});

test("addWorkspace rejects a path that is not a git worktree", async () => {
  await withTempXdg(async ({ root }) => {
    await assert.rejects(() => addWorkspace(root), /not a git worktree/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — the first test asserts `ws.path === repo` but gets `<repo>/src/deep`

- [ ] **Step 4: Add `toplevel` to git.js**

In `server/git.js`, immediately after `isGitRepo` (which ends at line 53), add:

```js
/**
 * Absolute path of the worktree root containing `cwd`. Returns null when `cwd` is not inside a
 * work tree. Correct for linked worktrees, where it resolves to the worktree — not the main repo.
 */
export async function toplevel(cwd) {
  try {
    const out = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    return out.stdout.trim() || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Normalize inside addWorkspace**

In `server/registry.js`, add to the imports:

```js
import { toplevel } from "./git.js";
```

Replace `addWorkspace` (lines 48–64) with:

```js
/** Add (or update the label of) a workspace. Idempotent by worktree root. */
export async function addWorkspace(path, label) {
  const root = await toplevel(resolve(path));
  if (!root) throw new Error(`not a git worktree: ${resolve(path)}`);
  const id = idFor(root);
  const workspaces = await readRegistry();
  const existing = workspaces.find((w) => w.id === id);
  if (existing) {
    if (label && label !== existing.label) {
      existing.label = label;
      await writeRegistry(workspaces);
    }
    return existing;
  }
  const ws = { id, path: root, label: label || basename(root), addedAt: new Date().toISOString() };
  workspaces.push(ws);
  await writeRegistry(workspaces);
  return ws;
}
```

- [ ] **Step 6: Surface the rejection as a 400**

In `server/index.js`, replace the POST `/api/workspaces` handler body (lines 135–143) with:

```js
if (pathname === "/api/workspaces" && req.method === "POST") {
  const body = await readBody(req);
  if (!body.path) return send(res, 400, { error: "path required" });
  let ws;
  try {
    ws = await addWorkspace(resolvePath(body.path), body.label);
  } catch (err) {
    return send(res, 400, { error: String(err.message || err) });
  }
  broadcast("workspaces", { reason: "added", ws: ws.id });
  return send(res, 201, ws);
}
```

`isGitRepo` is no longer called here — `addWorkspace` subsumes the check. Remove `isGitRepo` from the `./git.js` import on line 7 if nothing else in the file uses it.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 8 tests

- [ ] **Step 8: Commit**

```bash
git add server/git.js server/registry.js server/index.js test/
git commit -m "fix(livediff): register the worktree root, not the invoked subdirectory"
```

---

### Task 3: Registry dedupe migration

**Files:**

- Create: `server/migrations.js`
- Create: `test/migrations.test.js`
- Modify: `server/comments.js` (add `mergeInto`)

**Interfaces:**

- Consumes: `toplevel` (Task 2), `readRegistry`/`idFor`/`registryPath` (Tasks 1–2), `writeJsonAtomic` (Task 1).
- Produces:
  - `mergeInto(fromWsId: string, intoWsId: string): Promise<number>` from `server/comments.js` — appends `from`'s comments onto `into`'s, deletes `from`'s file, returns the number moved.
  - `migrateRegistry(): Promise<{normalized: number, merged: number}>` from `server/migrations.js`

- [ ] **Step 1: Write the failing test**

Create `test/migrations.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { withTempXdg, makeRepo } from "./helpers.js";
import { writeJsonAtomic } from "../server/atomic.js";
import { registryPath, readRegistry, idFor, configDir } from "../server/registry.js";
import { migrateRegistry } from "../server/migrations.js";
import { readComments } from "../server/comments.js";

/** Seed a pre-0.4 registry that recorded literal (un-normalized) paths. */
async function seedLegacy(entries) {
  await writeJsonAtomic(registryPath(), {
    workspaces: entries.map((p) => ({
      id: idFor(p),
      path: p,
      label: p.split("/").pop(),
      addedAt: "2026-01-01T00:00:00.000Z",
    })),
  });
}

test("collapses a subdirectory entry into its worktree root", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await seedLegacy([repo, join(repo, "src")]);

    const result = await migrateRegistry();

    const workspaces = await readRegistry();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].path, repo);
    assert.equal(result.merged, 1);
  });
});

test("moves comments from the collapsed entry onto the surviving one", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    const subId = idFor(join(repo, "src"));
    const rootId = idFor(repo);
    await seedLegacy([repo, join(repo, "src")]);
    await writeJsonAtomic(join(configDir(), "comments", `${rootId}.json`), {
      comments: [{ id: "aaaaaaaa", body: "from root", status: "open", replies: [] }],
    });
    await writeJsonAtomic(join(configDir(), "comments", `${subId}.json`), {
      comments: [{ id: "bbbbbbbb", body: "from subdir", status: "open", replies: [] }],
    });

    await migrateRegistry();

    const comments = await readComments(rootId, repo);
    assert.deepEqual(comments.map((c) => c.id).sort(), ["aaaaaaaa", "bbbbbbbb"]);
    await assert.rejects(() => readFile(join(configDir(), "comments", `${subId}.json`), "utf8"));
  });
});

test("drops entries whose path no longer exists", async () => {
  await withTempXdg(async ({ root }) => {
    await seedLegacy([join(root, "gone")]);
    await migrateRegistry();
    assert.deepEqual(await readRegistry(), []);
  });
});

test("is idempotent", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await seedLegacy([repo, join(repo, "src")]);
    await migrateRegistry();
    const second = await migrateRegistry();
    assert.equal(second.merged, 0);
    assert.equal(second.normalized, 0);
    assert.equal((await readRegistry()).length, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../server/migrations.js'`

- [ ] **Step 3: Export configDir from registry.js**

`configDir` is already exported at `server/registry.js:13`. Confirm no change is needed — the test imports it directly.

- [ ] **Step 4: Add mergeInto to comments.js**

Append to `server/comments.js`:

```js
/**
 * Append `from`'s comments onto `into`'s and delete `from`'s store. Used when two registry
 * entries collapse to one workspace. Returns how many comments moved.
 */
export async function mergeInto(fromWsId, intoWsId) {
  if (fromWsId === intoWsId) return 0;
  let incoming = [];
  try {
    incoming = await readComments(fromWsId, null);
  } catch {
    return 0;
  }
  if (!incoming.length) {
    await rm(storePath(fromWsId), { force: true });
    return 0;
  }
  const existing = await readComments(intoWsId, null);
  await writeComments(intoWsId, [...existing, ...incoming]);
  await rm(storePath(fromWsId), { force: true });
  return incoming.length;
}
```

`rm` is already imported at line 2. `readComments(id, null)` skips legacy migration, which is correct here — we only want the central store.

- [ ] **Step 5: Implement the migration**

Create `server/migrations.js`:

```js
import { access } from "node:fs/promises";
import { readRegistry, registryPath, idFor } from "./registry.js";
import { toplevel } from "./git.js";
import { mergeInto } from "./comments.js";
import { writeJsonAtomic } from "./atomic.js";

/**
 * Pre-0.4 registries hashed whatever path was passed to `livediff add`, so a repo could appear
 * several times — once per subdirectory it was invoked from — each with its own comments file.
 * Collapse those onto the worktree root and merge their comments. Idempotent.
 */
export async function migrateRegistry() {
  const workspaces = await readRegistry();
  if (!workspaces.length) return { normalized: 0, merged: 0 };

  const byRoot = new Map();
  let normalized = 0;
  let merged = 0;

  for (const ws of workspaces) {
    try {
      await access(ws.path);
    } catch {
      continue; // path is gone — drop it
    }
    const root = await toplevel(ws.path);
    if (!root) continue;
    if (root !== ws.path) normalized++;

    const id = idFor(root);
    const winner = byRoot.get(id);
    if (!winner) {
      byRoot.set(id, { ...ws, id, path: root });
      if (ws.id !== id) {
        merged += (await mergeInto(ws.id, id)) > 0 ? 1 : 0;
      }
      continue;
    }
    await mergeInto(ws.id, id);
    merged++;
  }

  const next = [...byRoot.values()];
  const changed =
    next.length !== workspaces.length ||
    next.some((w, i) => w.id !== workspaces[i].id || w.path !== workspaces[i].path);
  if (changed) await writeJsonAtomic(registryPath(), { workspaces: next });

  return { normalized, merged };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 12 tests

- [ ] **Step 7: Commit**

```bash
git add server/migrations.js server/comments.js test/migrations.test.js
git commit -m "feat(livediff): migrate duplicate registry entries onto worktree roots"
```

---

### Task 4: Hub state module

**Files:**

- Create: `server/hub-state.js`
- Create: `test/hub-state.test.js`

**Interfaces:**

- Consumes: `writeJsonAtomic` (Task 1).
- Produces, all from `server/hub-state.js`:
  - `stateDir(): string`, `statePath(): string`, `lockPath(): string`, `logPath(): string`
  - `readState(): Promise<HubState | null>` where `HubState = { pid: number, port: number, version: string, startedAt: string }`
  - `writeState(state: HubState): Promise<void>`
  - `clearState(): Promise<void>`
  - `pidAlive(pid: number): boolean`
  - `acquireLock(): Promise<boolean>`, `releaseLock(): Promise<void>`
  - `probeMeta(port: number, timeoutMs?: number): Promise<{name: string, version: string, port: number} | null>`

- [ ] **Step 1: Write the failing test**

Create `test/hub-state.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { utimes } from "node:fs/promises";
import { withTempXdg } from "./helpers.js";
import {
  stateDir,
  statePath,
  readState,
  writeState,
  clearState,
  pidAlive,
  acquireLock,
  releaseLock,
  lockPath,
  probeMeta,
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
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(stateDir(), { recursive: true });
    await writeFile(statePath(), "{ not json", "utf8");
    assert.equal(await readState(), null);
  });
});

test("round-trips state", async () => {
  await withTempXdg(async () => {
    const state = {
      pid: 1234,
      port: 4180,
      version: "0.4.0",
      startedAt: "2026-07-31T00:00:00.000Z",
    };
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../server/hub-state.js'`

- [ ] **Step 3: Implement hub-state.js**

Create `server/hub-state.js`:

```js
import { readFile, unlink, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";

/**
 * Hub runtime state lives under XDG_STATE_HOME, not XDG_CONFIG_HOME: it describes a running
 * process, is meaningless after a reboot, and must not be mistaken for user configuration.
 */
export function stateDir() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "livediff");
}

export const statePath = () => join(stateDir(), "hub.json");
export const lockPath = () => join(stateDir(), "hub.lock");
export const logPath = () => join(stateDir(), "hub.log");

export async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8"));
    if (!parsed || typeof parsed.port !== "number" || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeState(state) {
  await writeJsonAtomic(statePath(), state);
}

export async function clearState() {
  await unlink(statePath()).catch(() => {});
}

/** EPERM means the pid exists but belongs to another user — still alive for our purposes. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const LOCK_STALE_MS = 30_000;

export async function acquireLock(attempt = 0) {
  await mkdir(stateDir(), { recursive: true });
  try {
    const fh = await open(lockPath(), "wx");
    await fh.write(String(process.pid));
    await fh.close();
    return true;
  } catch (err) {
    if (err.code !== "EEXIST" || attempt >= 1) return false;
    let stale = false;
    try {
      stale = Date.now() - (await stat(lockPath())).mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = true; // vanished between open and stat — treat as free
    }
    if (!stale) return false;
    await unlink(lockPath()).catch(() => {});
    return acquireLock(attempt + 1);
  }
}

export async function releaseLock() {
  await unlink(lockPath()).catch(() => {});
}

export async function probeMeta(port, timeoutMs = 500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 20 tests

- [ ] **Step 5: Commit**

```bash
git add server/hub-state.js test/hub-state.test.js
git commit -m "feat(livediff): add hub runtime state module"
```

---

### Task 5: Hub startup — version, port discovery, state file, shutdown

**Files:**

- Modify: `server/index.js` (lines 20–28, 121–123, 209–267)
- Modify: `test/helpers.js`
- Create: `test/hub-startup.test.js`

**Interfaces:**

- Consumes: `writeState`/`clearState`/`probeMeta`/`logPath` (Task 4), `migrateRegistry` (Task 3).
- Produces:
  - `GET /api/meta` → `{ name: "livediff", version: string, port: number }`
  - `POST /api/shutdown` → `{ ok: true }`, then the process exits 0
  - `startHub(): Promise<{ port: number }>` from `test/helpers.js` (spawns a real hub against the current temp XDG dirs and resolves once `hub.json` appears)

- [ ] **Step 1: Add the hub-spawning test helper**

Append to `test/helpers.js`:

```js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));

/**
 * Spawn a real hub inheriting the current temp XDG env. Resolves with its state once hub.json
 * appears. Returns a `stop()` that kills the process.
 */
export async function startHub({ port = 0, timeoutMs = 10_000 } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LIVEDIFF_PORT: String(port || 4181) },
    stdio: "ignore",
    detached: false,
  });
  const statePath = join(process.env.XDG_STATE_HOME, "livediff", "hub.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (state.pid && state.port) {
        return { ...state, stop: () => child.kill("SIGKILL") };
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`hub did not start within ${timeoutMs}ms`);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/hub-startup.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempXdg, startHub } from "./helpers.js";
import { readState, probeMeta } from "../server/hub-state.js";

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
    const { createServer } = await import("node:http");
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
      squatter.close();
    }
  });
});

test("a redundant hub on an equivalent hub's port exits instead of binding", async () => {
  await withTempXdg(async () => {
    const first = await startHub({ port: 4190 });
    try {
      // startHub waits for hub.json, which the redundant process never rewrites — it exits 0.
      await assert.rejects(() => startHub({ port: 4190, timeoutMs: 2000 }), /did not start/);
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
```

Note: the second test spawns two hubs with the _same_ `LIVEDIFF_PORT`. Because both share one temp `XDG_STATE_HOME`, the second overwrites `hub.json` — which is exactly what happens in production when a second hub legitimately takes a different port, so `startHub` returning the newer state is correct here.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — no `hub.json` is written, `startHub` times out

- [ ] **Step 4: Add name to /api/meta and add /api/shutdown**

In `server/index.js`, replace the `/api/meta` handler (lines 121–123):

```js
if (pathname === "/api/meta") {
  return send(res, 200, { name: "livediff", port: BOUND_PORT, version: VERSION });
}

if (pathname === "/api/shutdown" && req.method === "POST") {
  send(res, 200, { ok: true });
  setTimeout(() => {
    clearState().finally(() => process.exit(0));
  }, 50);
  return;
}
```

Add to the imports:

```js
import { writeState, clearState, probeMeta } from "./hub-state.js";
import { migrateRegistry } from "./migrations.js";
```

Replace the `PORT` constant (line 20) with a preference plus a mutable bound port:

```js
const PREFERRED_PORT = Number(process.env.LIVEDIFF_PORT || 4180);
let BOUND_PORT = PREFERRED_PORT;
```

Update the fallback `VERSION` on line 23 from `"0.2.0"` to `"0.0.0"` — a wrong-but-plausible version is worse than an obviously-unset one, because `ensureHub` compares versions.

- [ ] **Step 5: Replace main() with port fallback and state writing**

In `server/index.js`, replace the `server.listen(...)` block at lines 256–264 with:

```js
const port = await listenWithFallback(server, PREFERRED_PORT);
if (port === null) {
  console.log(`livediff hub already running on ${PREFERRED_PORT} — exiting`);
  process.exit(0);
}
BOUND_PORT = port;
await writeState({
  pid: process.pid,
  port,
  version: VERSION,
  startedAt: new Date().toISOString(),
});

const link = `http://localhost:${port}`;
console.log(`livediff hub → ${link}  (v${VERSION})`);
if (process.env.LIVEDIFF_OPEN === "1") {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [link], () => {});
}
```

Add `listenWithFallback` above `main()`:

```js
/**
 * Bind `preferred`, or the next free port after it. An occupied port whose occupant is an
 * equivalent livediff hub means this process is redundant — signalled by returning null.
 */
async function listenWithFallback(srv, preferred, tries = 20) {
  for (let port = preferred; port < preferred + tries; port++) {
    const meta = await probeMeta(port, 300);
    if (meta && meta.name === "livediff" && meta.version === VERSION) return null;
    if (meta) continue; // something else is answering — skip it
    try {
      await new Promise((res, rej) => {
        const onError = (err) => rej(err);
        srv.once("error", onError);
        srv.listen(port, "127.0.0.1", () => {
          srv.removeListener("error", onError);
          res();
        });
      });
      return port;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`no free port in ${preferred}..${preferred + tries - 1}`);
}
```

- [ ] **Step 6: Run migrations and clear state on exit**

Still in `main()`, add as the very first statement:

```js
await migrateRegistry();
```

And after the `writeState` call, register cleanup:

```js
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearState().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 24 tests

- [ ] **Step 8: Commit**

```bash
git add server/index.js test/
git commit -m "feat(livediff): hub port discovery, state file, and graceful shutdown"
```

---

### Task 6: ensureHub

**Files:**

- Create: `server/ensure-hub.js`
- Create: `test/ensure-hub.test.js`

**Interfaces:**

- Consumes: everything from `server/hub-state.js` (Task 4); the hub startup behavior from Task 5.
- Produces:
  - `ensureHub(): Promise<string>` from `server/ensure-hub.js` — resolves to a base URL like `http://127.0.0.1:4180`, spawning or replacing the hub as needed.
  - `hubVersion(): string` — the CLI's own version, read from `package.json`.

- [ ] **Step 1: Write the failing test**

Create `test/ensure-hub.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempXdg, startHub } from "./helpers.js";
import { readState, writeState, probeMeta, acquireLock, releaseLock } from "../server/hub-state.js";
import { ensureHub } from "../server/ensure-hub.js";

// Own this file's port band so a parallel test file never spawns a hub onto the same port.
process.env.LIVEDIFF_PORT = "4191";

async function stopHub() {
  const state = await readState();
  if (state) {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: "POST" }).catch(() => {});
  }
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
    const hub = await startHub({ port: 4191 });
    try {
      const url = await ensureHub();
      assert.equal(url, "http://127.0.0.1:4191");
      assert.equal((await readState()).pid, hub.pid);
    } finally {
      hub.stop();
    }
  });
});

test("cleans up a state file whose pid is dead and spawns fresh", async () => {
  await withTempXdg(async () => {
    await writeState({
      pid: 0x7ffffffe,
      port: 4192,
      version: "0.4.0",
      startedAt: new Date().toISOString(),
    });
    try {
      const url = await ensureHub();
      assert.notEqual(new URL(url).port, "4192");
      assert.equal((await probeMeta(new URL(url).port)).name, "livediff");
    } finally {
      await stopHub();
    }
  });
});

test("replaces a hub reporting a different version", async () => {
  await withTempXdg(async () => {
    // A real hub always reports the current version, so a stale one has to be faked. This also
    // keeps the version-mismatch path testable without adding a test-only override to index.js.
    const { createServer } = await import("node:http");
    let shutdownCalled = false;
    const stale = createServer((req, res) => {
      if (req.url === "/api/shutdown") {
        shutdownCalled = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => stale.close(), 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "livediff", version: "0.0.1-stale", port: 4193 }));
    });
    await new Promise((r) => stale.listen(4193, "127.0.0.1", r));
    await writeState({
      pid: process.pid,
      port: 4193,
      version: "0.0.1-stale",
      startedAt: new Date().toISOString(),
    });

    try {
      const url = await ensureHub();
      assert.equal(shutdownCalled, true);
      assert.notEqual(new URL(url).port, "4193");
      assert.equal((await probeMeta(new URL(url).port)).name, "livediff");
    } finally {
      stale.close();
      await stopHub();
    }
  });
});

test("a caller that loses the spawn lock still gets a working hub", async () => {
  await withTempXdg(async () => {
    await acquireLock();
    const spawner = startHub({ port: 4194 });
    try {
      const [url] = await Promise.all([ensureHub(), spawner]);
      assert.equal((await probeMeta(new URL(url).port)).name, "livediff");
    } finally {
      await releaseLock();
      await stopHub();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../server/ensure-hub.js'`

- [ ] **Step 3: Implement ensureHub**

Create `server/ensure-hub.js`:

```js
import { spawn } from "node:child_process";
import { open, readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readState,
  clearState,
  pidAlive,
  probeMeta,
  acquireLock,
  releaseLock,
  logPath,
  stateDir,
} from "./hub-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "index.js");

let VERSION = "0.0.0";
try {
  VERSION = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")).version;
} catch {
  /* keep default */
}

export function hubVersion() {
  return VERSION;
}

let ensured = null;

const url = (port) => `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub(deadline) {
  while (Date.now() < deadline) {
    const state = await readState();
    if (state) {
      const meta = await probeMeta(state.port, 300);
      if (meta && meta.version === VERSION) return url(state.port);
    }
    await sleep(50);
  }
  return null;
}

async function spawnHub() {
  await mkdir(stateDir(), { recursive: true });
  const log = await open(logPath(), "a");
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  await log.close();
}

async function shutdown(state) {
  await fetch(`${url(state.port)}/api/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await probeMeta(state.port, 200))) await sleep(50);
  await clearState();
}

async function failure() {
  let tail = "";
  try {
    tail = (await readFile(logPath(), "utf8")).split("\n").slice(-20).join("\n");
  } catch {
    /* no log */
  }
  return new Error(`livediff hub failed to start within 10s${tail ? `\n\n${tail}` : ""}`);
}

/**
 * Return the base URL of a live hub running our version, starting or replacing one if needed.
 * Memoized: the first command in a process pays the cost, the rest connect directly.
 */
export async function ensureHub() {
  if (ensured) return ensured;

  const state = await readState();
  if (state) {
    const meta = await probeMeta(state.port);
    if (meta && meta.name === "livediff") {
      if (meta.version === VERSION) return (ensured = url(state.port));
      await shutdown(state);
    } else if (!pidAlive(state.pid)) {
      await clearState();
    } else {
      await shutdown(state);
    }
  }

  const deadline = Date.now() + 10_000;
  if (await acquireLock()) {
    try {
      await spawnHub();
      const found = await waitForHub(deadline);
      if (!found) throw await failure();
      return (ensured = found);
    } finally {
      await releaseLock();
    }
  }

  const found = await waitForHub(deadline);
  if (!found) throw await failure();
  return (ensured = found);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 29 tests

- [ ] **Step 5: Commit**

```bash
git add server/ensure-hub.js test/ensure-hub.test.js
git commit -m "feat(livediff): auto-start the hub on first CLI use"
```

---

### Task 7: Rewrite the CLI as a pure HTTP client

**Files:**

- Modify: `server/cli.js` (full rewrite, 203 lines → ~180)
- Create: `test/cli.test.js`

**Interfaces:**

- Consumes: `ensureHub`/`hubVersion` (Task 6), `readState`/`clearState`/`pidAlive` (Task 4).
- Produces: the CLI surface below. `server/registry.js` and `server/comments.js` are no longer imported by `cli.js`.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withTempXdg, makeRepo } from "./helpers.js";
import { readState } from "../server/hub-state.js";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../server/cli.js", import.meta.url));

/** Run the CLI with the ambient temp XDG env. Never throws — returns the failure for assertions. */
async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, LIVEDIFF_PORT: "4196", ...opts.env },
      cwd: opts.cwd,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function stopHub() {
  const state = await readState();
  if (state) {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: "POST" }).catch(() => {});
  }
}

test("registering a worktree auto-starts the hub", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      assert.equal(await readState(), null);
      const res = await cli([repo, "--no-open", "--json"]);
      assert.equal(res.code, 0);
      const out = JSON.parse(res.stdout);
      assert.equal(out.path, repo);
      assert.match(out.url, /^http:\/\/localhost:\d+\/\?ws=/);
      assert.ok((await readState()).pid);
    } finally {
      await stopHub();
    }
  });
});

test("registering from a subdirectory yields one workspace", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli([join(repo, "src"), "--no-open", "--json"]);
      const list = JSON.parse((await cli(["list", "--json"])).stdout);
      assert.equal(list.workspaces.length, 1);
      assert.equal(list.workspaces[0].path, repo);
    } finally {
      await stopHub();
    }
  });
});

test("a path that is not a git worktree exits 1 with a clear message", async () => {
  await withTempXdg(async ({ root }) => {
    try {
      const res = await cli([root, "--no-open"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /not a git worktree/);
    } finally {
      await stopHub();
    }
  });
});

test("an unknown command exits 2", async () => {
  await withTempXdg(async () => {
    const res = await cli(["frobnicate"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /unknown command/);
  });
});

test("stop shuts the hub down and clears state", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await cli([repo, "--no-open"]);
    assert.ok((await readState()).pid);
    const res = await cli(["stop"]);
    assert.equal(res.code, 0);
    assert.equal(await readState(), null);
  });
});

test("comments round-trip through the CLI without touching files", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const created = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "fix this" }),
      }).then((r) => r.json());

      const listed = JSON.parse((await cli(["comments", repo, "--json"])).stdout);
      assert.equal(listed.comments.length, 1);
      assert.equal(listed.comments[0].body, "fix this");

      const res = await cli(["resolve", created.id, "done", "--json"], { cwd: repo });
      assert.equal(res.code, 0);

      const after = JSON.parse((await cli(["comments", repo, "--json"])).stdout);
      assert.equal(after.comments[0].status, "resolved");
      assert.equal(after.comments[0].replies.length, 1);
    } finally {
      await stopHub();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — the current CLI has no `--json`, no `stop`, and treats a bare path as an unknown command

- [ ] **Step 3: Rewrite cli.js**

Replace the entire contents of `server/cli.js`:

```js
#!/usr/bin/env node
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { ensureHub } from "./ensure-hub.js";
import { readState, clearState, pidAlive } from "./hub-state.js";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.filter((a) => !a.startsWith("--"));
const JSON_OUT = flags.has("--json");

const out = (human, data) => console.log(JSON_OUT ? JSON.stringify(data, null, 2) : human);

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const isId = (s) => /^[0-9a-f]{8}$/.test(s);
const looksLikePath = (s) =>
  s === "." ||
  s === ".." ||
  s.startsWith("/") ||
  s.startsWith("./") ||
  s.startsWith("../") ||
  s.startsWith("~");

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}

/** Register a worktree and (unless --no-open) open its focused view. */
async function cmdWorkspace(pathArg) {
  const base = await ensureHub();
  const path = resolve(pathArg || process.cwd());
  const ws = await api(base, "/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const port = new URL(base).port;
  const url = `http://localhost:${port}/?ws=${ws.id}&focus=1`;
  if (!flags.has("--no-open")) openBrowser(url);
  out(`${flags.has("--no-open") ? "registered" : "opened"} ${ws.label} → ${url}`, { ...ws, url });
}

async function cmdHubUi() {
  const base = await ensureHub();
  const url = `http://localhost:${new URL(base).port}/`;
  openBrowser(url);
  out(`livediff → ${url}`, { url });
}

async function cmdList() {
  const base = await ensureHub();
  const { workspaces } = await api(base, "/api/workspaces");
  if (JSON_OUT) return out("", { workspaces });
  if (!workspaces.length) return out("no workspaces registered — `livediff .` to add one", {});
  for (const w of workspaces) {
    console.log(`${w.id}  ${String(w.label).padEnd(20)}  ${w.path}`);
  }
}

async function cmdRemove(target) {
  const base = await ensureHub();
  const arg = target || process.cwd();
  const id = isId(arg)
    ? arg
    : (await api(base, `/api/resolve?path=${encodeURIComponent(resolve(arg))}`)).id;
  const body = await api(base, `/api/workspaces/${id}`, { method: "DELETE" });
  out(body.ok ? `removed ${id}` : `not registered: ${id}`, { id, ...body });
}

async function resolveWs(base, pathArg) {
  const path = resolve(pathArg || process.cwd());
  return api(base, `/api/resolve?path=${encodeURIComponent(path)}`);
}

async function cmdComments(pathArg) {
  const base = await ensureHub();
  const ws = await resolveWs(base, pathArg);
  const { comments } = await api(base, `/api/comments?ws=${ws.id}`);
  if (JSON_OUT) return out("", { workspace: ws.id, comments });
  if (!comments.length) return console.log("no comments");
  for (const c of comments) {
    console.log(`${c.id}  ${c.status.padEnd(8)}  ${c.file}:${c.line}  ${c.body}`);
  }
}

async function cmdReplyOrResolve(rest, resolveIt) {
  const [id, ...text] = rest;
  if (!id) {
    die(`usage: livediff ${resolveIt ? "resolve <id> [text…]" : "reply <id> <text…>"}`, 2);
  }
  const body = text.join(" ").trim();
  if (!resolveIt && !body) die("reply text required", 2);

  const base = await ensureHub();
  const ws = await resolveWs(base);
  const patch = {};
  if (resolveIt) patch.status = "resolved";
  if (body) patch.reply = { author: "claude", body };
  const updated = await api(base, `/api/comments/${id}?ws=${ws.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  out(`${resolveIt ? "resolved" : "replied to"} ${updated.id}`, updated);
}

/** Lifecycle, not data — the one command that talks to the state file instead of HTTP. */
async function cmdStop() {
  const state = await readState();
  if (!state) return out("hub is not running", { running: false });
  await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    if (pidAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(state.pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await clearState();
  out("hub stopped", { running: false });
}

function usage() {
  console.log(`livediff — live worktree diff hub

usage:
  livediff                       open the hub UI (all workspaces)
  livediff <path>                register a worktree and open its focused view
  livediff <path> --no-open      register only, print the URL
  livediff list                  list registered workspaces
  livediff rm [path|id]          unregister
  livediff comments [path]       print review comments
  livediff resolve <id> [text…]  reply (optional) and mark resolved
  livediff reply <id> <text…>    reply without resolving
  livediff stop                  shut the hub down

flags:
  --json     machine-readable output
  --no-open  do not launch a browser

env: LIVEDIFF_PORT (preferred port), LIVEDIFF_POLL_MS`);
}

const [cmd, ...rest] = args;

try {
  switch (cmd) {
    case undefined:
      await cmdHubUi();
      break;
    case "list":
    case "ls":
      await cmdList();
      break;
    case "rm":
    case "remove":
      await cmdRemove(rest[0]);
      break;
    case "comments":
      await cmdComments(rest[0]);
      break;
    case "resolve":
      await cmdReplyOrResolve(rest, true);
      break;
    case "reply":
      await cmdReplyOrResolve(rest, false);
      break;
    case "stop":
      await cmdStop();
      break;
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      if (looksLikePath(cmd)) {
        await cmdWorkspace(cmd);
        break;
      }
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
} catch (err) {
  die(String(err.message || err));
}
```

Note on `looksLikePath`: `livediff /abs/path` and `livediff .` are paths; `livediff frobnicate` is an unknown command. A bare relative name like `livediff src` is treated as a command and rejected — use `./src`. This keeps typos loud instead of silently failing to register.

- [ ] **Step 4: Add /api/resolve support for absolute paths**

`GET /api/resolve` already exists at `server/index.js:125`. Confirm it returns 404 for unregistered paths and that `cmdRemove`/`resolveWs` surface that as a clean error via `api()`. No code change expected — verify by running the CLI test suite.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 35 tests

- [ ] **Step 6: Verify the CLI no longer imports storage modules**

Run: `grep -nE "registry\.js|comments\.js" server/cli.js`
Expected: no output — the CLI is a pure HTTP client.

- [ ] **Step 7: Manual smoke test**

```bash
pnpm build
node server/cli.js --help
cd /tmp && git init -q smoke && cd smoke && git commit -q --allow-empty -m init
node <path-to-livediff>/server/cli.js . --no-open --json
node <path-to-livediff>/server/cli.js list
node <path-to-livediff>/server/cli.js stop
```

Expected: registration works with no hub started by hand; `list` shows one workspace; `stop` reports `hub stopped`.

- [ ] **Step 8: Commit**

```bash
git add server/cli.js test/cli.test.js
git commit -m "feat(livediff): rewrite the CLI as a pure HTTP client"
```

---

## Self-Review Notes

**Spec coverage for this plan's scope:**

| Spec section                                      | Task |
| ------------------------------------------------- | ---- |
| §1 defect 1 (manual daemon)                       | 6, 7 |
| §1 defect 2 (two writers)                         | 7    |
| §1 defect 3 (path normalization)                  | 2, 3 |
| §4.1 state file                                   | 4, 5 |
| §4.2 `ensureHub`                                  | 6    |
| §4.3 spawning + single-flight                     | 4, 6 |
| §4.4 port discovery                               | 5    |
| §4.5 shutdown                                     | 5, 7 |
| §6.1 pure HTTP client                             | 7    |
| §6.2 surface, `--json`, exit codes, normalization | 7, 2 |
| §8 atomic writes                                  | 1    |
| §10.2 registry dedupe migration                   | 3    |

**Deferred to Plan 2:** §5 (dormancy, `fs.watch`), §6.3 + §7 (reviews, `--wait`, Done button), §9 (UI), §10.1/10.3 (packaging, `doctor`), §11 (doc rewrites).

**Known consequence:** until Plan 2 lands, the hub still polls every registered workspace once per second regardless of whether any browser is attached. That is existing v0.3 behavior and is not a regression.
