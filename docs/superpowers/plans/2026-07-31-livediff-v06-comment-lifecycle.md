# livediff v0.6 Comment Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope comments to the branch they were left on, hide them once their file leaves the diff, and age them through an archive tier before deleting anything.

**Architecture:** Lifecycle decisions live in a pure `comment-lifecycle.js` module taking an explicit `now`, so every threshold is testable without clocks or a hub. The store moves to a v2 shape keyed by comment id. A throttled sweep in the hub's poll loop archives and purges; `livediff archive` and `livediff prune` do the same work on demand.

**Tech Stack:** Node >= 18, ESM, `node:test`, no runtime dependencies in `server/`.

## Global Constraints

- Target version is **0.6.0** in both `package.json` and `.claude-plugin/plugin.json`.
- `package.json` keeps `"private": true`.
- No new runtime dependencies. `server/` uses only Node builtins.
- Node >= 18: no `fs.promises.glob`, no newer APIs.
- Tests run with `pnpm test`. Never `npm`.
- Shell rules: one command per invocation, no `&&`/`||`/`|`/`;`, never `git -C`.
- Commit style: `type(scope): subject`, scope `livediff`.
- Thresholds: `ORPHAN_ARCHIVE_DAYS = 5`, `RESOLVED_ARCHIVE_DAYS = 30`, `PURGE_DAYS = 200`. No env overrides.
- No model-invocable skill may mention `archive`, `prune`, `restore`, `doctor`, `list`, or `stop`.
- Nothing is deleted less than 205 days after a comment's last activity.

## Corrections to the spec

Two spec statements are wrong about the existing code. The plan follows the code.

1. **There is no SSE payload to filter.** `index.js:192` broadcasts `{reason, ws}` only; the UI
   refetches through `GET /api/comments`, which this plan filters. No SSE work is needed.
2. **`git.js` exports `summary`, not `summaryFor`.**

One deliberate improvement over the spec: the sweep is **throttled to once every 12 hours**
rather than running every poll tick. Sweeping needs a `changedPaths` git spawn per workspace,
and the poll loop runs every second — that would double git spawns per second to enforce
thresholds measured in days. Twice a day is ample for a 5-day rule, and `livediff archive`
exists for when you want it now.

---

## File Structure

**Create:**

- `server/comment-lifecycle.js` — pure predicates and thresholds. No I/O, no clock.
- `test/comment-lifecycle.test.js`
- `test/comments.test.js`
- `skills/prune/SKILL.md`

**Modify:**

- `server/git.js` — export `currentBranch`, add `changedPaths`, refactor `summary` onto it
- `server/comments.js` — v2 keyed store, `branch` stamping, `getComment`, `sweep`, `restoreComment`, `listComments`
- `server/index.js` — branch filter on the comments GET, throttled sweep, rename internal `prune`
- `server/cli.js`, `server/cli-help.js` — `--branch`, `--stale`, `--archived`, `restore`, `archive`, `prune`
- `server/comment-format.js` — archived countdown marker
- `server/doctor.js` — `checkArchive`
- `package.json`, `.claude-plugin/plugin.json`, `README.md`, `DESIGN.md`

---

### Task 1: Lifecycle predicates

**Files:**

- Create: `server/comment-lifecycle.js`
- Test: `test/comment-lifecycle.test.js`

**Interfaces:**

- Produces:
  - `ORPHAN_ARCHIVE_DAYS = 5`, `RESOLVED_ARCHIVE_DAYS = 30`, `PURGE_DAYS = 200`
  - `isOrphaned(comment, changedPaths: Set<string>): boolean`
  - `shouldArchive(comment, { orphaned: boolean, now: number }): boolean`
  - `shouldPurge(comment, now: number): boolean`
  - `daysUntilPurge(comment, now: number): number`

- [ ] **Step 1: Write the failing test**

Create `test/comment-lifecycle.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORPHAN_ARCHIVE_DAYS,
  RESOLVED_ARCHIVE_DAYS,
  PURGE_DAYS,
  isOrphaned,
  shouldArchive,
  shouldPurge,
  daysUntilPurge,
} from "../server/comment-lifecycle.js";

const NOW = Date.parse("2026-07-31T00:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const comment = (over = {}) => ({
  id: "aaaaaaaa",
  file: "src/app.js",
  status: "open",
  archivedAt: null,
  updatedAt: daysAgo(0),
  ...over,
});

test("thresholds are 5, 30 and 200 days", () => {
  assert.equal(ORPHAN_ARCHIVE_DAYS, 5);
  assert.equal(RESOLVED_ARCHIVE_DAYS, 30);
  assert.equal(PURGE_DAYS, 200);
});

test("a file among the changed paths is not orphaned", () => {
  assert.equal(isOrphaned(comment(), new Set(["src/app.js"])), false);
});

test("a file absent from the changed paths is orphaned", () => {
  assert.equal(isOrphaned(comment(), new Set(["other.js"])), true);
});

test("an orphaned comment archives only after 5 days", () => {
  const young = comment({ updatedAt: daysAgo(4) });
  const old = comment({ updatedAt: daysAgo(6) });
  assert.equal(shouldArchive(young, { orphaned: true, now: NOW }), false);
  assert.equal(shouldArchive(old, { orphaned: true, now: NOW }), true);
});

test("a resolved comment still in the diff archives only after 30 days", () => {
  const young = comment({ status: "resolved", updatedAt: daysAgo(29) });
  const old = comment({ status: "resolved", updatedAt: daysAgo(31) });
  assert.equal(shouldArchive(young, { orphaned: false, now: NOW }), false);
  assert.equal(shouldArchive(old, { orphaned: false, now: NOW }), true);
});

test("an open comment still in the diff never archives, however old", () => {
  const ancient = comment({ updatedAt: daysAgo(900) });
  assert.equal(shouldArchive(ancient, { orphaned: false, now: NOW }), false);
});

test("an already archived comment does not archive again", () => {
  const archived = comment({ archivedAt: daysAgo(1), updatedAt: daysAgo(90) });
  assert.equal(shouldArchive(archived, { orphaned: true, now: NOW }), false);
});

test("purging happens only after 200 archived days", () => {
  assert.equal(shouldPurge(comment({ archivedAt: daysAgo(199) }), NOW), false);
  assert.equal(shouldPurge(comment({ archivedAt: daysAgo(201) }), NOW), true);
});

test("a comment that was never archived never purges", () => {
  assert.equal(shouldPurge(comment({ updatedAt: daysAgo(900) }), NOW), false);
});

test("daysUntilPurge counts down from 200", () => {
  assert.equal(daysUntilPurge(comment({ archivedAt: daysAgo(6) }), NOW), 194);
  assert.equal(daysUntilPurge(comment({ archivedAt: null }), NOW), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/comment-lifecycle.test.js`
Expected: FAIL — `Cannot find module '.../server/comment-lifecycle.js'`

- [ ] **Step 3: Write the implementation**

Create `server/comment-lifecycle.js`:

```js
/**
 * When a comment stops being live, gets archived, and finally gets deleted.
 *
 * Pure: no I/O and no clock — `now` is always a parameter, so every threshold is testable
 * without sleeping or faking timers. Orphaning is never stored, only computed, so it heals
 * itself the moment a file returns to the diff.
 */

export const ORPHAN_ARCHIVE_DAYS = 5;
export const RESOLVED_ARCHIVE_DAYS = 30;
export const PURGE_DAYS = 200;

const DAY_MS = 86_400_000;

const ageInDays = (iso, now) => (now - Date.parse(iso)) / DAY_MS;

/** A comment is orphaned when the file it was left on is no longer part of the diff. */
export function isOrphaned(comment, changedPaths) {
  return !changedPaths.has(comment.file);
}

/**
 * Either trigger archives: orphaned and stale, or resolved and stale. An open comment that is
 * still in the diff never archives, however old — it is live work, not clutter.
 */
export function shouldArchive(comment, { orphaned, now }) {
  if (comment.archivedAt) return false;
  const age = ageInDays(comment.updatedAt, now);
  if (orphaned && age > ORPHAN_ARCHIVE_DAYS) return true;
  return comment.status === "resolved" && age > RESOLVED_ARCHIVE_DAYS;
}

export function shouldPurge(comment, now) {
  if (!comment.archivedAt) return false;
  return ageInDays(comment.archivedAt, now) > PURGE_DAYS;
}

/** Days left before purge, or null when the comment is not archived. */
export function daysUntilPurge(comment, now) {
  if (!comment.archivedAt) return null;
  return Math.ceil(PURGE_DAYS - ageInDays(comment.archivedAt, now));
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test test/comment-lifecycle.test.js`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/comment-lifecycle.js test/comment-lifecycle.test.js
```

```bash
git commit -m "feat(livediff): add comment lifecycle predicates"
```

---

### Task 2: `changedPaths` in git.js

**Files:**

- Modify: `server/git.js:68-71` (export `currentBranch`), `server/git.js:198-217` (`summary`)
- Test: `test/git.test.js` (create if absent)

**Interfaces:**

- Produces:
  - `currentBranch(cwd): Promise<string>` — now exported; `"(detached)"` for detached HEAD
  - `changedPaths(cwd): Promise<string[]>` — tracked changes vs HEAD plus untracked files

- [ ] **Step 1: Write the failing test**

Create `test/git.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTempXdg, makeRepo } from "./helpers.js";
import { changedPaths, currentBranch, summary } from "../server/git.js";

const exec = promisify(execFile);

test("changedPaths reports modified tracked files and untracked ones", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    assert.deepEqual(await changedPaths(repo), []);

    await writeFile(join(repo, "README.md"), "# changed\n", "utf8");
    await writeFile(join(repo, "new.txt"), "hello\n", "utf8");

    const paths = (await changedPaths(repo)).sort();
    assert.deepEqual(paths, ["README.md", "new.txt"]);
  });
});

test("summary's changedFiles count agrees with changedPaths", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "a.txt"), "a\n", "utf8");
    await writeFile(join(repo, "b.txt"), "b\n", "utf8");
    const info = await summary(repo);
    assert.equal(info.changedFiles, (await changedPaths(repo)).length);
  });
});

test("currentBranch reports the branch, and (detached) when detached", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    assert.equal(await currentBranch(repo), "main");

    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["checkout", "-q", head], { cwd: repo });
    assert.equal(await currentBranch(repo), "(detached)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — `changedPaths is not a function` and `currentBranch is not exported`.

- [ ] **Step 3: Export `currentBranch`**

In `server/git.js`, change line 68 from `async function currentBranch(cwd) {` to:

```js
export async function currentBranch(cwd) {
```

- [ ] **Step 4: Add `changedPaths` and refactor `summary` onto it**

In `server/git.js`, replace the whole `summary` function (currently lines 198-217) with:

```js
/**
 * Paths that differ from HEAD, plus untracked files. Shared by the rail's summary and by the
 * lifecycle sweep, so a poll never runs the same git twice for the same information.
 */
export async function changedPaths(cwd) {
  const paths = [];
  if (await hasHead(cwd)) {
    const tracked = (await git(cwd, ["diff", "--name-only", "HEAD", ...EXCLUDE]))
      .split("\n")
      .filter(Boolean);
    paths.push(...tracked);
  }
  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...EXCLUDE])
  )
    .split("\0")
    .filter(Boolean);
  paths.push(...untracked);
  return paths;
}

/** Cheap per-workspace summary for the rail: branch, head, changed-file count. */
export async function summary(cwd) {
  if (!(await isGitRepo(cwd))) {
    return { valid: false, branch: null, head: null, changedFiles: 0 };
  }
  const branch = await currentBranch(cwd);
  const head = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() || null;
  return { valid: true, branch, head, changedFiles: (await changedPaths(cwd)).length };
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node --test test/git.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 6: Run the full suite to check nothing regressed**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/git.js test/git.test.js
```

```bash
git commit -m "feat(livediff): add changedPaths and share it with the rail summary"
```

---

### Task 3: The v2 keyed store

**Files:**

- Modify: `server/comments.js` (whole file)
- Test: `test/comments.test.js`

**Interfaces:**

- Consumes: `currentBranch` from `server/git.js`.
- Produces:
  - `listComments(wsId, repoPath, { branch }): Promise<Comment[]>` — `branch` may be a name or `"all"`
  - `getComment(wsId, id): Promise<Comment|null>` — O(1)
  - `addComment(wsId, repoPath, input): Promise<Comment>` — stamps `branch` and `archivedAt: null`
  - `updateComment(wsId, repoPath, id, patch): Promise<Comment|null>`
  - `deleteComment(wsId, repoPath, id): Promise<boolean>`
  - `mergeInto(fromWsId, intoWsId): Promise<number>`
  - `commentsSignature(wsId): Promise<string>`

  `readComments` is replaced by `listComments`. Callers must be updated in Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/comments.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTempXdg, makeRepo } from "./helpers.js";
import { addComment, listComments, getComment, updateComment } from "../server/comments.js";
import { configDir } from "../server/registry.js";

const exec = promisify(execFile);
const input = { file: "README.md", side: "new", line: 1, lineContent: "# test\n", body: "fix" };

test("a new comment records the branch it was left on", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    assert.equal(c.branch, "main");
    assert.equal(c.archivedAt, null);
  });
});

test("a comment made on a detached HEAD records (detached)", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["checkout", "-q", head], { cwd: repo });
    const c = await addComment("ws1", repo, input);
    assert.equal(c.branch, "(detached)");
  });
});

test("the store is written keyed by comment id", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    const raw = JSON.parse(await readFile(join(configDir(), "comments", "ws1.json"), "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.comments[c.id].body, "fix");
  });
});

test("getComment finds a record by key", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    assert.equal((await getComment("ws1", c.id)).id, c.id);
    assert.equal(await getComment("ws1", "nosuchid"), null);
  });
});

test("listComments filters by branch, and 'all' returns everything", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const onMain = await addComment("ws1", repo, input);
    await exec("git", ["checkout", "-qb", "feat"], { cwd: repo });
    const onFeat = await addComment("ws1", repo, input);

    const feat = await listComments("ws1", repo, { branch: "feat" });
    assert.deepEqual(
      feat.map((c) => c.id),
      [onFeat.id],
    );

    const main = await listComments("ws1", repo, { branch: "main" });
    assert.deepEqual(
      main.map((c) => c.id),
      [onMain.id],
    );

    assert.equal((await listComments("ws1", repo, { branch: "all" })).length, 2);
  });
});

test("a comment with no branch matches every branch", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    await updateComment("ws1", repo, c.id, { branch: null });
    assert.equal((await listComments("ws1", repo, { branch: "anything" })).length, 1);
  });
});

test("a v1 array store is read without loss", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const { writeJsonAtomic } = await import("../server/atomic.js");
    await writeJsonAtomic(join(configDir(), "comments", "ws1.json"), {
      comments: [
        { id: "old00001", file: "a.js", line: 1, body: "legacy", status: "open", replies: [] },
      ],
    });
    const all = await listComments("ws1", repo, { branch: "all" });
    assert.deepEqual(
      all.map((c) => c.id),
      ["old00001"],
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/comments.test.js`
Expected: FAIL — `listComments is not a function`.

- [ ] **Step 3: Rewrite the store**

In `server/comments.js`, replace everything from the file docblock down to and including
`deleteComment` (currently lines 7-111) with:

```js
/**
 * Comments are stored centrally — keyed by workspace id, not inside the worktree — so livediff
 * never leaves files in a registered repo. Agents never touch this store directly; they go
 * through the `livediff` CLI / HTTP API, which is what makes the storage location free to change.
 * Location: $XDG_CONFIG_HOME/livediff/comments/<workspace-id>.json (defaults to ~/.config/livediff).
 *
 * v2 keys records by comment id, so update, resolve, reply and restore are O(1) lookups rather
 * than scans. Secondary indexes were considered and rejected: the file is rewritten wholesale on
 * every write, so an index is state that can desync, and the failure mode is comments silently
 * disappearing. Grouping by file and filtering by branch or status are derived per read.
 *
 * Shape of one comment:
 * {
 *   id, file, side: "old"|"new", line, lineContent, body,
 *   author: "user"|"claude", status: "open"|"resolved",
 *   branch, archivedAt: string|null,
 *   replies: [{ author, body, ts }], createdAt, updatedAt
 * }
 */

function storePath(wsId) {
  return join(configDir(), "comments", `${wsId}.json`);
}

// Pre-v0.3 versions wrote comments into <worktree>/.diff-review/comments.json. Migrate that file
// into the central store the first time this workspace's comments are touched, then remove it so
// the worktree stops showing an untracked file.
async function migrateLegacy(wsId, repoPath) {
  if (!repoPath) return;
  const dest = storePath(wsId);
  try {
    await stat(dest);
    return; // already migrated (or never had legacy data)
  } catch {
    /* no central file yet — check for a legacy one */
  }
  const legacyDir = join(repoPath, ".diff-review");
  const legacyFile = join(legacyDir, "comments.json");
  let raw;
  try {
    raw = await readFile(legacyFile, "utf8");
  } catch {
    return; // nothing to migrate
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, raw, "utf8");
  await rm(legacyFile, { force: true });
  await rmdir(legacyDir).catch(() => {}); // only succeeds if now empty
}

/**
 * Accept either shape on read and always write v2. The v1 array only appears in stores written
 * before 0.6; normalizing here is five lines and removes a whole class of "what if an old file
 * turns up" from every caller.
 */
function normalize(data) {
  const raw = data?.comments;
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((c) => [c.id, c]));
  return raw && typeof raw === "object" ? raw : {};
}

async function readStore(wsId, repoPath) {
  await migrateLegacy(wsId, repoPath);
  try {
    return normalize(JSON.parse(await readFile(storePath(wsId), "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(wsId, comments) {
  await writeJsonAtomic(storePath(wsId), { version: 2, comments });
}

/**
 * Comments for a workspace, optionally narrowed to one branch. A record with no branch matches
 * every branch — nothing will have one after the 0.6 wipe, but it costs one `||` and removes any
 * path where a record silently vanishes.
 */
export async function listComments(wsId, repoPath, { branch = "all" } = {}) {
  const store = await readStore(wsId, repoPath);
  const all = Object.values(store);
  if (branch === "all") return all;
  return all.filter((c) => !c.branch || c.branch === branch);
}

/** O(1) — the reason the store is keyed. */
export async function getComment(wsId, id) {
  return (await readStore(wsId, null))[id] ?? null;
}

export async function addComment(wsId, repoPath, input) {
  const store = await readStore(wsId, repoPath);
  const now = new Date().toISOString();
  const comment = {
    id: randomUUID().slice(0, 8),
    file: input.file,
    side: input.side === "old" ? "old" : "new",
    line: Number(input.line),
    lineContent: input.lineContent ?? "",
    body: String(input.body ?? "").trim(),
    author: input.author === "claude" ? "claude" : "user",
    status: "open",
    branch: repoPath ? await currentBranch(repoPath).catch(() => null) : null,
    archivedAt: null,
    replies: [],
    createdAt: now,
    updatedAt: now,
  };
  store[comment.id] = comment;
  await writeStore(wsId, store);
  return comment;
}

export async function updateComment(wsId, repoPath, id, patch) {
  const store = await readStore(wsId, repoPath);
  const comment = store[id];
  if (!comment) return null;
  if (typeof patch.body === "string") comment.body = patch.body;
  if (patch.status === "open" || patch.status === "resolved") comment.status = patch.status;
  if ("branch" in patch) comment.branch = patch.branch;
  if (patch.reply && patch.reply.body) {
    comment.replies.push({
      author: patch.reply.author === "user" ? "user" : "claude",
      body: String(patch.reply.body).trim(),
      ts: new Date().toISOString(),
    });
  }
  comment.updatedAt = new Date().toISOString();
  await writeStore(wsId, store);
  return comment;
}

export async function deleteComment(wsId, repoPath, id) {
  const store = await readStore(wsId, repoPath);
  if (!store[id]) return false;
  delete store[id];
  await writeStore(wsId, store);
  return true;
}
```

Then update `mergeInto` (currently lines 117-133) to merge keyed objects:

```js
export async function mergeInto(fromWsId, intoWsId) {
  if (fromWsId === intoWsId) return 0;
  let incoming = {};
  try {
    incoming = await readStore(fromWsId, null);
  } catch {
    return 0;
  }
  const count = Object.keys(incoming).length;
  if (!count) {
    await rm(storePath(fromWsId), { force: true });
    return 0;
  }
  const existing = await readStore(intoWsId, null);
  await writeStore(intoWsId, { ...existing, ...incoming });
  await rm(storePath(fromWsId), { force: true });
  return count;
}
```

Finally, add `currentBranch` to the imports at the top of the file:

```js
import { currentBranch } from "./git.js";
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test test/comments.test.js`
Expected: PASS — 7 tests. Other suites will fail until Task 5 updates `readComments` callers;
that is expected and fixed there.

- [ ] **Step 5: Commit**

```bash
git add server/comments.js test/comments.test.js
```

```bash
git commit -m "feat(livediff): key the comment store by id and stamp the branch"
```

---

### Task 4: Sweep and restore

**Files:**

- Modify: `server/comments.js` (append)
- Test: `test/comments.test.js` (append)

**Interfaces:**

- Consumes: `shouldArchive`, `shouldPurge`, `isOrphaned` from `server/comment-lifecycle.js`.
- Produces:
  - `sweep(wsId, repoPath, changed: string[], { now, force }): Promise<{archived: number, purged: number}>`
    where `force` is `{ stale?: boolean, resolved?: boolean }` overriding the age gates
  - `restoreComment(wsId, id): Promise<Comment|null>`
  - `purgeArchived(wsId, { olderThanDays, now }): Promise<number>`

- [ ] **Step 1: Write the failing test**

Append to `test/comments.test.js`:

```js
import { sweep, restoreComment, purgeArchived } from "../server/comments.js";

const DAY = 86_400_000;

async function seed(repo, over = {}) {
  const c = await addComment("ws1", repo, input);
  await updateComment("ws1", repo, c.id, {});
  const store = await import("../server/comments.js");
  const all = await store.listComments("ws1", repo, { branch: "all" });
  Object.assign(
    all.find((x) => x.id === c.id),
    over,
  );
  await store.__writeForTest("ws1", Object.fromEntries(all.map((x) => [x.id, x])));
  return c.id;
}

test("sweep archives an orphaned comment older than 5 days", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed(repo, { updatedAt: new Date(now - 6 * DAY).toISOString() });

    const result = await sweep("ws1", repo, [], { now });
    assert.equal(result.archived, 1);
    assert.ok((await getComment("ws1", id)).archivedAt);
  });
});

test("sweep leaves an orphaned comment younger than 5 days alone", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed(repo, { updatedAt: new Date(now - 2 * DAY).toISOString() });

    assert.equal((await sweep("ws1", repo, [], { now })).archived, 0);
    assert.equal((await getComment("ws1", id)).archivedAt, null);
  });
});

test("sweep --stale ignores the age gate", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed(repo, {});
    const result = await sweep("ws1", repo, [], { now, force: { stale: true } });
    assert.equal(result.archived, 1);
    assert.ok((await getComment("ws1", id)).archivedAt);
  });
});

test("sweep purges a record archived more than 200 days ago", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed(repo, { archivedAt: new Date(now - 201 * DAY).toISOString() });
    assert.equal((await sweep("ws1", repo, [], { now })).purged, 1);
    assert.equal(await getComment("ws1", id), null);
  });
});

test("restore clears archivedAt and refreshes updatedAt so a sweep does not re-archive", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed(repo, {
      updatedAt: new Date(now - 90 * DAY).toISOString(),
      archivedAt: new Date(now - 10 * DAY).toISOString(),
    });

    const restored = await restoreComment("ws1", id);
    assert.equal(restored.archivedAt, null);

    assert.equal((await sweep("ws1", repo, [], { now })).archived, 0);
    assert.equal((await getComment("ws1", id)).archivedAt, null);
  });
});

test("purgeArchived deletes by an explicit window", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed(repo, { archivedAt: new Date(now - 11 * DAY).toISOString() });
    assert.equal(await purgeArchived("ws1", { olderThanDays: 10, now }), 1);
    assert.equal(await getComment("ws1", id), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/comments.test.js`
Expected: FAIL — `sweep is not a function`.

- [ ] **Step 3: Implement sweep, restore and purgeArchived**

Append to `server/comments.js`:

```js
/**
 * Archive and purge one workspace's comments for the branch currently checked out.
 *
 * Only the current branch is evaluated, because orphan detection is meaningless against another
 * branch's diff — which is also why a branch you are not on can never lose its review notes.
 *
 * `force` overrides only the age gates, never what qualifies: `{ stale: true }` archives every
 * orphaned comment, `{ resolved: true }` every resolved one.
 */
export async function sweep(wsId, repoPath, changed, { now = Date.now(), force = {} } = {}) {
  const store = await readStore(wsId, repoPath);
  const branch = repoPath ? await currentBranch(repoPath).catch(() => null) : null;
  const changedSet = new Set(changed);
  let archived = 0;
  let purged = 0;

  for (const [id, comment] of Object.entries(store)) {
    if (shouldPurge(comment, now)) {
      delete store[id];
      purged++;
      continue;
    }
    if (comment.branch && branch && comment.branch !== branch) continue;
    const orphaned = isOrphaned(comment, changedSet);
    const forced =
      !comment.archivedAt &&
      ((force.stale && orphaned) || (force.resolved && comment.status === "resolved"));
    if (forced || shouldArchive(comment, { orphaned, now })) {
      comment.archivedAt = new Date(now).toISOString();
      archived++;
    }
  }

  if (archived || purged) await writeStore(wsId, store);
  return { archived, purged };
}

/**
 * Return an archived comment to live. `updatedAt` is refreshed as well as `archivedAt` cleared:
 * a comment archived for being orphaned and stale is still both the instant it returns, so
 * clearing the flag alone would let the next sweep archive it again and make the command look
 * broken. Resetting the clock is the reprieve the caller is asking for.
 */
export async function restoreComment(wsId, id) {
  const store = await readStore(wsId, null);
  const comment = store[id];
  if (!comment) return null;
  comment.archivedAt = null;
  comment.updatedAt = new Date().toISOString();
  await writeStore(wsId, store);
  return comment;
}

/** Delete archived records older than an explicit window. `olderThanDays: 0` empties the archive. */
export async function purgeArchived(wsId, { olderThanDays, now = Date.now() }) {
  const store = await readStore(wsId, null);
  const cutoff = now - olderThanDays * 86_400_000;
  let purged = 0;
  for (const [id, comment] of Object.entries(store)) {
    if (!comment.archivedAt) continue;
    if (Date.parse(comment.archivedAt) > cutoff) continue;
    delete store[id];
    purged++;
  }
  if (purged) await writeStore(wsId, store);
  return purged;
}

/** Test-only escape hatch for seeding aged records without waiting days. */
export async function __writeForTest(wsId, comments) {
  await writeStore(wsId, comments);
}
```

Add to the imports at the top of `server/comments.js`:

```js
import { isOrphaned, shouldArchive, shouldPurge } from "./comment-lifecycle.js";
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test test/comments.test.js`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add server/comments.js test/comments.test.js
```

```bash
git commit -m "feat(livediff): add the archive sweep, restore and explicit purge"
```

---

### Task 5: Wire the hub

**Files:**

- Modify: `server/index.js:9` (import), `:182-186` (comments GET), `:303-312` (rename `prune`), `:314-344` (poll)
- Modify: `server/migrations.js` if it imports `readComments`
- Test: `test/cli.test.js` (existing suites must pass again)

**Interfaces:**

- Consumes: `listComments`, `sweep` from `server/comments.js`; `changedPaths` from `server/git.js`.
- Produces: `GET /api/comments?ws=<id>&branch=<name|all>` filtered to the current branch by default.

- [ ] **Step 1: Update the imports**

In `server/index.js`, change line 8 and 9 to:

```js
import {
  getDiff,
  summary,
  worktreeSignature,
  isGitRepo,
  currentBranch,
  changedPaths,
} from "./git.js";
import { listComments, addComment, updateComment, deleteComment, sweep } from "./comments.js";
```

- [ ] **Step 2: Filter the comments GET by branch**

Replace the comments GET handler (currently lines 182-186) with:

```js
if (pathname === "/api/comments" && req.method === "GET") {
  const ws = await resolveWs(url);
  if (!ws) return send(res, 404, { error: "unknown workspace" });
  const requested = url.searchParams.get("branch");
  const branch = requested || (await currentBranch(ws.path).catch(() => "all"));
  return send(res, 200, { comments: await listComments(ws.id, ws.path, { branch }) });
}
```

- [ ] **Step 3: Rename the internal workspace prune**

`prune` is about to become a user-facing command that deletes comments, while this one drops
dead workspaces. Two different meanings under one name is a trap. In `server/index.js`, rename
the function at line 303 and its single call site at line 325:

```js
async function pruneWorkspaces(registered) {
```

```js
registered = await pruneWorkspaces(await readRegistry());
```

- [ ] **Step 4: Add the throttled sweep to the poll loop**

Add near the other module-level state at the top of `server/index.js`:

```js
/**
 * Sweeping needs one `changedPaths` spawn per workspace. The poll loop runs every second, and
 * the lifecycle thresholds are measured in days, so sweeping every tick would double git spawns
 * per second to enforce a five-day rule. Twice a day is ample; `livediff archive` forces it.
 */
const SWEEP_INTERVAL_MS = 12 * 60 * 60_000;
let lastSweep = 0;
```

Then append this to the end of the `poll()` function, after the `registered.forEach(...)` block:

```js
if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
lastSweep = Date.now();
const changed = await Promise.all(registered.map((w) => changedPaths(w.path).catch(() => null)));
await Promise.all(
  registered.map(async (w, i) => {
    if (changed[i] === null) return; // transient git state
    const { archived, purged } = await sweep(w.id, w.path, changed[i], {});
    if (archived || purged) broadcast("comments", { reason: "swept", ws: w.id });
  }),
);
```

- [ ] **Step 5: Fix any remaining `readComments` importers**

Run: `grep -rn "readComments" server test`
Expected: no output. If `server/migrations.js` or any other file still imports it, change the
import to `listComments` and pass `{ branch: "all" }`.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS. Every previously passing test must pass again.

- [ ] **Step 7: Commit**

```bash
git add server/index.js server/migrations.js
```

```bash
git commit -m "feat(livediff): scope the comments API to the current branch and sweep on a timer"
```

---

### Task 6: CLI reading — `--branch`, `--stale`, `--archived`, `restore`

**Files:**

- Modify: `server/cli-help.js` (`VALUE_FLAGS`, `comments` entry, new `restore` entry)
- Modify: `server/cli.js` (`cmdComments`, new `cmdRestore`, dispatch)
- Modify: `server/comment-format.js` (archived countdown)
- Test: `test/cli.test.js`

**Interfaces:**

- Consumes: `daysUntilPurge` from `server/comment-lifecycle.js`.
- Produces: `formatComments(comments, { now })` — now takes an options object.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test("comments are scoped to the branch they were left on", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "on main" }),
      });

      assert.match((await cli(["comments", repo])).stdout, /on main/);

      await exec("git", ["checkout", "-qb", "feat"], { cwd: repo });
      assert.doesNotMatch((await cli(["comments", repo])).stdout, /on main/);
      assert.match((await cli(["comments", repo, "--branch", "all"])).stdout, /on main/);
    } finally {
      await stopHub();
    }
  });
});

test("restore returns an archived comment and reports it", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const made = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "keep me" }),
      }).then((r) => r.json());

      await cli(["archive", repo, "--stale"]);
      assert.doesNotMatch((await cli(["comments", repo])).stdout, /keep me/);
      assert.match((await cli(["comments", repo, "--archived"])).stdout, /purges in \d+ days/);

      const res = await cli(["restore", made.id], { cwd: repo });
      assert.equal(res.code, 0);
      assert.match((await cli(["comments", repo])).stdout, /keep me/);
    } finally {
      await stopHub();
    }
  });
});

test("--stale and --archived together exit 2", async () => {
  await withTempXdg(async () => {
    const res = await cli(["comments", "--stale", "--archived"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--stale and --archived/);
    assert.equal(await readState(), null);
  });
});
```

Add this import at the top of `test/cli.test.js` if it is not already present:

```js
import { execFile } from "node:child_process";
const exec = promisify(execFile);
```

(`promisify` and `execFile` are already imported at the top of that file; reuse the existing
`exec` constant rather than declaring a second one.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — `--branch` is unknown, `restore` is an unknown command.

- [ ] **Step 3: Register the new flags and command**

In `server/cli-help.js`, extend `VALUE_FLAGS`:

```js
export const VALUE_FLAGS = new Set(["--timeout", "--status", "--branch", "--keep-days"]);
```

Replace the `comments` entry's `usage`, `flags` and `examples`:

```js
    usage: "livediff comments [path] [--status open|resolved|all] [--branch <name>] [--stale|--archived]",
```

```js
    flags: [
      ["--status <which>", "open (default), resolved, or all"],
      ["--branch <name>", "a branch name, or all (default: the current branch)"],
      ["--stale", "only comments whose file has left the diff"],
      ["--archived", "only archived comments, with days until they are purged"],
    ],
    examples: [
      ["livediff comments", "open comments on this worktree's current branch"],
      ["livediff comments --stale", "comments whose file is no longer in the diff"],
      ["livediff comments --archived", "what is archived and when it will be deleted"],
    ],
```

Add a `restore` entry to `COMMANDS`, immediately after the `reply` entry:

```js
  {
    id: "restore",
    name: "restore",
    usage: "livediff restore <id>",
    summary: "return an archived comment to the live view",
    details:
      "Clears the archive flag and resets the comment's age, so the next sweep does not\n" +
      "immediately archive it again. Resolves the workspace from the current directory.",
    flags: [],
    examples: [["livediff restore a1b2c3d4", "un-archive a comment"]],
  },
```

- [ ] **Step 4: Add the countdown to the formatter**

In `server/comment-format.js`, add the import and change `formatComments` to take options:

```js
import { daysUntilPurge } from "./comment-lifecycle.js";
```

```js
export function formatComments(comments, { now = Date.now() } = {}) {
  return comments
    .flatMap((c) => {
      const left = daysUntilPurge(c, now);
      const tag = left === null ? "" : `  (archived — purges in ${left} days)`;
      const lines = [`${c.id}  ${c.file}:${c.line}${tag}`];
      const quoted = anchor(c.lineContent);
      if (quoted) lines.push(`    | ${quoted}`);
      lines.push(`    ${c.body}`);
      const n = c.replies?.length ?? 0;
      if (n) lines.push(`    (${n} ${n === 1 ? "reply" : "replies"})`);
      return lines;
    })
    .join("\n");
}
```

- [ ] **Step 5: Apply the filters in the CLI**

In `server/cli.js`, replace `cmdComments` with:

```js
async function cmdComments(pathArg) {
  const status = values.get("--status") ?? "open";
  if (!COMMENT_STATUSES.includes(status)) {
    await die(`--status must be one of: ${COMMENT_STATUSES.join(", ")}`, EXIT_USAGE);
  }
  const wantStale = flags.has("--stale");
  const wantArchived = flags.has("--archived");
  if (wantStale && wantArchived) {
    await die("--stale and --archived cannot be combined", EXIT_USAGE);
  }

  const base = await ensureHub();
  const ws = await resolveWs(base, pathArg);
  const branch = values.get("--branch");
  const query = branch ? `&branch=${encodeURIComponent(branch)}` : "";
  const { comments } = await api(base, `/api/comments?ws=${ws.id}${query}`);
  const { stale } = await api(base, `/api/stale?ws=${ws.id}`);
  const staleIds = new Set(stale);

  const view = comments.filter((c) => {
    if (wantArchived) return Boolean(c.archivedAt);
    if (c.archivedAt) return false;
    return wantStale ? staleIds.has(c.id) : !staleIds.has(c.id);
  });

  const selected = filterByStatus(view, status);
  if (JSON_OUT) return out("", { workspace: ws.id, comments: selected });
  if (!selected.length) return console.log(emptyMessage(view, status));
  console.log(formatComments(selected));
}
```

Add `cmdRestore` next to `cmdReplyOrResolve`:

```js
async function cmdRestore(id) {
  if (!id) {
    await die(`usage: ${findCommand("restore").usage}`, EXIT_USAGE);
  }
  const base = await ensureHub();
  const ws = await resolveWs(base);
  const body = await api(base, `/api/comments/${id}/restore?ws=${ws.id}`, { method: "POST" });
  out(`restored ${body.id}`, body);
}
```

And add the dispatch case in `main`, after the `reply` case:

```js
    case "restore":
      return cmdRestore(rest[0]);
```

- [ ] **Step 6: Add the two supporting routes to the hub**

In `server/index.js`, add these before the `/api/reviews` routes:

```js
if (pathname === "/api/stale" && req.method === "GET") {
  const ws = await resolveWs(url);
  if (!ws) return send(res, 404, { error: "unknown workspace" });
  const changed = new Set(await changedPaths(ws.path).catch(() => []));
  const all = await listComments(ws.id, ws.path, { branch: "all" });
  return send(res, 200, { stale: all.filter((c) => !changed.has(c.file)).map((c) => c.id) });
}

const restoreMatch = pathname.match(/^\/api\/comments\/([\w-]+)\/restore$/);
if (restoreMatch && req.method === "POST") {
  const ws = await resolveWs(url);
  if (!ws) return send(res, 404, { error: "unknown workspace" });
  const comment = await restoreComment(ws.id, restoreMatch[1]);
  if (!comment) return send(res, 404, { error: "unknown comment" });
  broadcast("comments", { reason: "restored", ws: ws.id });
  return send(res, 200, comment);
}
```

Add `restoreComment` to the `./comments.js` import list in `server/index.js`.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/cli.js server/cli-help.js server/comment-format.js server/index.js test/cli.test.js
```

```bash
git commit -m "feat(livediff): add branch, stale and archived views plus restore"
```

---

### Task 7: `archive` and `prune` commands

**Files:**

- Modify: `server/cli-help.js` (two new `COMMANDS` entries)
- Modify: `server/cli.js` (`cmdArchive`, `cmdPrune`, dispatch)
- Modify: `server/index.js` (two routes)
- Test: `test/cli.test.js`

**Interfaces:**

- Consumes: `sweep`, `purgeArchived` from `server/comments.js`; `PURGE_DAYS` from `server/comment-lifecycle.js`.
- Produces: `POST /api/sweep`, `POST /api/purge`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test("archive defaults to every workspace and a path narrows it", async () => {
  await withTempXdg(async ({ root }) => {
    const a = await makeRepo(join(root, "a"));
    const b = await makeRepo(join(root, "b"));
    try {
      for (const repo of [a, b]) {
        const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
        const state = await readState();
        await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "note" }),
        });
      }

      await cli(["archive", a, "--stale"]);
      assert.match((await cli(["comments", a, "--archived"])).stdout, /note/);
      assert.doesNotMatch((await cli(["comments", b, "--archived"])).stdout, /note/);

      await cli(["archive", "--stale"]);
      assert.match((await cli(["comments", b, "--archived"])).stdout, /note/);
    } finally {
      await stopHub();
    }
  });
});

test("prune --dry-run reports without deleting and never prompts", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "note" }),
      });
      await cli(["archive", repo, "--stale"]);

      const dry = await cli(["prune", repo, "--all", "--dry-run"]);
      assert.equal(dry.code, 0);
      assert.match(dry.stdout, /would delete 1/);
      assert.match((await cli(["comments", repo, "--archived"])).stdout, /note/);
    } finally {
      await stopHub();
    }
  });
});

test("prune --all requires --yes when stdin is not a TTY", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["prune", repo, "--all"]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /--yes/);
    } finally {
      await stopHub();
    }
  });
});

test("prune --all --yes empties the archive", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "note" }),
      });
      await cli(["archive", repo, "--stale"]);

      const res = await cli(["prune", repo, "--all", "--yes"]);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /pruned 1/);
      assert.match((await cli(["comments", repo, "--archived"])).stdout, /no/);
    } finally {
      await stopHub();
    }
  });
});

test("prune rejects --keep-days together with --all", async () => {
  await withTempXdg(async () => {
    const res = await cli(["prune", "--keep-days", "10", "--all"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--keep-days and --all/);
    assert.equal(await readState(), null);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — `archive` and `prune` are unknown commands.

- [ ] **Step 3: Add the hub routes**

In `server/index.js`, add before the `/api/reviews` routes:

```js
if (pathname === "/api/sweep" && req.method === "POST") {
  const { path, force } = await readBody(req);
  const targets = await targetWorkspaces(path);
  let archived = 0;
  let purged = 0;
  for (const w of targets) {
    const changed = await changedPaths(w.path).catch(() => []);
    const result = await sweep(w.id, w.path, changed, { force: force ?? {} });
    archived += result.archived;
    purged += result.purged;
  }
  if (archived || purged) broadcast("comments", { reason: "swept" });
  return send(res, 200, { archived, purged, workspaces: targets.length });
}

if (pathname === "/api/purge" && req.method === "POST") {
  const { path, keepDays, dryRun } = await readBody(req);
  const targets = await targetWorkspaces(path);
  let count = 0;
  for (const w of targets) {
    if (dryRun) {
      const all = await listComments(w.id, w.path, { branch: "all" });
      const cutoff = Date.now() - keepDays * 86_400_000;
      count += all.filter((c) => c.archivedAt && Date.parse(c.archivedAt) <= cutoff).length;
    } else {
      count += await purgeArchived(w.id, { olderThanDays: keepDays });
    }
  }
  if (count && !dryRun) broadcast("comments", { reason: "pruned" });
  return send(res, 200, { count, workspaces: targets.length, dryRun: Boolean(dryRun) });
}
```

Add this helper next to `resolveWs` in `server/index.js`:

```js
/** No path means every registered workspace — these are maintenance routes, not review routes. */
async function targetWorkspaces(path) {
  const all = await readRegistry();
  if (!path) return all;
  const root = (await toplevel(path)) ?? path;
  return all.filter((w) => w.path === root);
}
```

Add `purgeArchived` to the `./comments.js` import list and `toplevel` to the `./git.js` import
list in `server/index.js`.

- [ ] **Step 4: Add the command table entries**

In `server/cli-help.js`, add these two entries to `COMMANDS`, after the `restore` entry:

```js
  {
    id: "archive",
    name: "archive",
    usage: "livediff archive [path] [--stale] [--resolved] [--dry-run]",
    summary: "archive comments that are no longer live",
    details:
      "Archives comments whose file has left the diff for more than 5 days, and resolved\n" +
      "comments untouched for more than 30. Archived comments are hidden but restorable\n" +
      "for 200 days.\n" +
      "\n" +
      "Defaults to EVERY registered workspace, unlike the review commands — pass a path\n" +
      "to narrow it. --stale and --resolved override only the age gates.",
    flags: [
      ["--stale", "archive every orphaned comment, whatever its age"],
      ["--resolved", "archive every resolved comment, whatever its age"],
      ["--dry-run", "report what would change without writing"],
    ],
    examples: [
      ["livediff archive", "archive what qualifies, everywhere"],
      ["livediff archive . --stale", "archive this worktree's orphaned comments now"],
    ],
  },
  {
    id: "prune",
    name: "prune",
    usage: "livediff prune [path] [--keep-days <n> | --all] [--dry-run] [--yes]",
    summary: "delete archived comments",
    details:
      "Deletes archived comments older than 200 days by default. Deleting sooner than that\n" +
      "asks for confirmation first, unless --yes is passed.\n" +
      "\n" +
      "Defaults to EVERY registered workspace, unlike the review commands — pass a path\n" +
      "to narrow it. This is the only command that destroys data; --dry-run shows what it\n" +
      "would remove.",
    flags: [
      ["--keep-days <n>", "delete archived comments older than n days"],
      ["--all", "delete every archived comment"],
      ["--dry-run", "report what would be deleted without deleting it"],
      ["--yes", "skip the confirmation prompt"],
    ],
    examples: [
      ["livediff prune --dry-run", "see what would be deleted"],
      ["livediff prune --keep-days 30 --yes", "keep only the last 30 days of archive"],
    ],
  },
```

- [ ] **Step 5: Implement the commands**

In `server/cli.js`, add these next to the other command functions:

```js
async function cmdArchive(pathArg) {
  const force = { stale: flags.has("--stale"), resolved: flags.has("--resolved") };
  const base = await ensureHub();
  const body = await api(base, "/api/sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: pathArg ? resolve(pathArg) : null, force }),
  });
  const where = `${body.workspaces} ${body.workspaces === 1 ? "workspace" : "workspaces"}`;
  out(`archived ${body.archived} comments across ${where}`, body);
}

/** stdin is not a TTY under an agent or a pipe, so a prompt there would hang forever. */
async function confirm(question) {
  if (!process.stdin.isTTY) {
    await die(`${question}\nRefusing to prompt without a terminal — pass --yes.`, EXIT_USAGE);
  }
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise((r) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => r(String(d).trim().toLowerCase()));
  });
  return answer === "y" || answer === "yes";
}

async function cmdPrune(pathArg) {
  const all = flags.has("--all");
  const keepRaw = values.get("--keep-days");
  if (all && keepRaw !== undefined) {
    await die("--keep-days and --all cannot be combined", EXIT_USAGE);
  }
  const keepDays = all ? 0 : keepRaw === undefined ? PURGE_DAYS : Number(keepRaw);
  if (!Number.isFinite(keepDays) || keepDays < 0) {
    await die("--keep-days must be a non-negative number", EXIT_USAGE);
  }

  const dryRun = flags.has("--dry-run");
  const base = await ensureHub();
  const path = pathArg ? resolve(pathArg) : null;

  if (!dryRun && keepDays < PURGE_DAYS && !flags.has("--yes")) {
    const preview = await api(base, "/api/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, keepDays, dryRun: true }),
    });
    if (!preview.count) return out("nothing to prune", { count: 0 });
    const ok = await confirm(`Delete ${preview.count} archived comments? This cannot be undone.`);
    if (!ok) return out("cancelled", { count: 0, cancelled: true });
  }

  const body = await api(base, "/api/purge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, keepDays, dryRun }),
  });
  const where = `${body.workspaces} ${body.workspaces === 1 ? "workspace" : "workspaces"}`;
  const verb = dryRun ? "would delete" : "pruned";
  out(`${verb} ${body.count} archived comments across ${where}`, body);
}
```

Add the dispatch cases in `main`, after the `restore` case:

```js
    case "archive":
      return cmdArchive(rest[0]);
    case "prune":
      return cmdPrune(rest[0]);
```

And add `PURGE_DAYS` to the `comment-lifecycle.js` import in `server/cli.js`:

```js
import { PURGE_DAYS } from "./comment-lifecycle.js";
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/cli.js server/cli-help.js server/index.js test/cli.test.js
```

```bash
git commit -m "feat(livediff): add the archive and prune maintenance commands"
```

---

### Task 8: doctor, the prune skill, docs and the wipe

**Files:**

- Modify: `server/doctor.js` (add `checkArchive`)
- Create: `skills/prune/SKILL.md`
- Modify: `package.json`, `.claude-plugin/plugin.json`, `README.md`, `DESIGN.md`
- Test: `test/doctor.test.js`

**Interfaces:**

- Consumes: `listComments` from `server/comments.js`; `daysUntilPurge` from `server/comment-lifecycle.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/doctor.test.js`:

```js
test("an empty archive reports ok without a suggestion", async () => {
  await withTempXdg(async () => {
    const finding = find(await diagnose("0.6.0"), "comment archive");
    assert.ok(finding, "expected a comment archive finding");
    assert.equal(finding.level, "ok");
    assert.equal(finding.fix, undefined);
  });
});

test("a populated archive suggests a prune command", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeJsonAtomic(registryPath(), {
      workspaces: [
        { id: idFor(repo), path: repo, label: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const { __writeForTest } = await import("../server/comments.js");
    await __writeForTest(idFor(repo), {
      aaaaaaaa: {
        id: "aaaaaaaa",
        file: "a.js",
        line: 1,
        body: "x",
        status: "resolved",
        replies: [],
        branch: "main",
        archivedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const finding = find(await diagnose("0.6.0"), "comment archive");
    assert.match(finding.detail, /1 archived comment/);
    assert.match(finding.fix, /livediff prune/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/doctor.test.js`
Expected: FAIL — no finding titled `comment archive`.

- [ ] **Step 3: Add the check**

In `server/doctor.js`, add the import:

```js
import { listComments } from "./comments.js";
```

Add this function next to the other checks:

```js
const WARN_BYTES = 5 * 1024 * 1024;

/**
 * Archive growth is the one thing doctor would otherwise only describe. Every other finding
 * carries a fix, so this one does too.
 */
async function checkArchive() {
  const workspaces = await readRegistry();
  let bytes = 0;
  let archived = 0;
  let oldest = null;

  for (const w of workspaces) {
    try {
      bytes += (await stat(join(configDir(), "comments", `${w.id}.json`))).size;
    } catch {
      continue; // no store for this workspace yet
    }
    for (const c of await listComments(w.id, null, { branch: "all" })) {
      if (!c.archivedAt) continue;
      archived++;
      if (!oldest || c.archivedAt < oldest) oldest = c.archivedAt;
    }
  }

  if (!archived) return ok("comment archive", `${(bytes / 1024).toFixed(1)} KB, nothing archived`);

  const days = Math.floor((Date.now() - Date.parse(oldest)) / 86_400_000);
  const noun = archived === 1 ? "archived comment" : "archived comments";
  const detail =
    `${workspaces.length} workspaces, ${archived} ${noun}, ${(bytes / 1024).toFixed(1)} KB\n` +
    `oldest archived ${days} days ago`;
  const fix = "livediff prune --dry-run";
  return bytes > WARN_BYTES
    ? warn("comment archive is large", detail, fix)
    : { level: "ok", title: "comment archive", detail, fix };
}
```

Add `checkArchive()` to the `checks` array in `diagnose`, after `checkLegacyDirs()`.

Add `configDir` to the `./registry.js` import in `server/doctor.js`; `stat` and `join` are
already imported.

- [ ] **Step 4: Create the prune skill**

Create `skills/prune/SKILL.md`:

````markdown
---
name: prune
description: Show what livediff would delete from its comment archive, then clean it up.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

!`livediff prune --dry-run`

Report exactly what would be deleted. If nothing would be, say so and stop.

Otherwise ask the user how much to keep before running anything. Never prune without
an answer — this is the only livediff command that destroys data.

Once they answer, run one of:

```bash
livediff prune --keep-days <n> --yes
livediff prune --all --yes
```
````

````

- [ ] **Step 5: Verify the skills still name no forbidden commands**

Run: `grep -rln "doctor\|livediff list\|livediff stop" skills/`
Expected: no output.

Run: `grep -rln "prune\|archive\|restore" skills/open skills/comments skills/link skills/review`
Expected: no output — maintenance commands must not appear in the review skills.

- [ ] **Step 6: Bump both versions**

In `package.json`, set `"version": "0.6.0"`. In `.claude-plugin/plugin.json`, set
`"version": "0.6.0"`.

- [ ] **Step 7: Back up and wipe the comment store**

```bash
cp -R "$HOME/.config/livediff/comments" "/private/tmp/claude-501/-Users-shanesteuteville-shane-dev-livediff/26e85cd3-8023-496a-8130-4f27296bd115/scratchpad/comments-backup-v05"
````

```bash
rm -rf "$HOME/.config/livediff/comments"
```

This is deliberately manual, not installer code: it must never run twice. All 15 existing
comments are `resolved`, so no pending work is lost.

- [ ] **Step 8: Update `README.md`**

Replace the `livediff comments [path]` line in the Use block with these lines:

```
livediff comments [path]       open comments on the current branch
                               (--status open|resolved|all, --branch, --stale, --archived)
livediff restore <id>          return an archived comment to the live view
livediff archive [path]        archive comments that are no longer live (all workspaces)
livediff prune [path]          delete archived comments (all workspaces)
```

Add this section after the Claude Code table:

````markdown
## Comment lifecycle

A comment records the branch it was left on and is only shown on that branch.

Once its file leaves the diff it is _orphaned_ — hidden from the browser and from
`livediff comments`, but visible with `--stale`. After 5 days orphaned, or 30 days
resolved, it is archived: still restorable, no longer in the way. Archived comments are
deleted after 200 days.

```
livediff comments --stale       what is hidden and heading for the archive
livediff comments --archived    what is archived, and when it will be deleted
livediff restore <id>           pull one back
livediff prune --dry-run        what would be deleted right now
```

Nothing is destroyed less than 205 days after a comment's last activity, and
`/livediff:prune` always previews before it deletes.
````

Add a `/livediff:prune` row to the Claude Code table:

```markdown
| `/livediff:prune` | previews what would be deleted from the archive, then asks |
```

- [ ] **Step 9: Update `DESIGN.md`**

Append:

```markdown
## Comment lifecycle

A comment used to store nothing tying it to the change it was about — no branch, no commit,
no base ref — while the diff it was left on is entirely ephemeral. Two failures followed:
comments rendered on branches they were never left on, and comments outlived the diff, so an
`open` comment on committed work was handed to an agent as live work forever.

Comments now record their branch and are only shown on it. Orphaning — the file no longer
being in the diff — is computed, never stored, so it heals itself the moment a file comes
back. Archiving is stored, because it is a decision rather than an observation.

Nothing is deleted for 205 days: 5 days orphaned (or 30 resolved) to archive, then 200 more
before purge, with `livediff restore` available throughout. An orphaned comment that is still
`open` is an unaddressed loose end, so it is archived rather than deleted.

The sweep runs in the poll loop, throttled to once every 12 hours. It needs one `changedPaths`
spawn per workspace and the loop ticks every second, so sweeping every tick would double git
spawns per second to enforce thresholds measured in days. `livediff archive` and `livediff
prune` do the same work on demand, since the loop only runs while a browser is attached.

The store is keyed by comment id. Secondary indexes were rejected: the file is rewritten
wholesale on every write, so an index is state that can desync, and the failure mode is
comments silently disappearing — a poor trade against a scan over dozens of records.
```

- [ ] **Step 10: Run the full suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 11: Reinstall and verify**

Run: `./install.sh`
Expected: reports `✓ livediff v0.6.0`, and `livediff doctor` shows a `comment archive` finding
with no error-level findings.

- [ ] **Step 12: Commit**

```bash
git add -A
```

```bash
git commit -m "feat(livediff): report the comment archive and release 0.6.0"
```

---

## Manual verification

1. `/plugin update livediff`, then restart Claude Code.
2. Leave a comment on an uncommitted file, then `livediff comments` — it appears.
3. `git checkout -b scratch` — `livediff comments` is empty; `--branch all` still shows it.
4. Return to the original branch, commit the file, then `livediff comments` — empty, and
   `livediff comments --stale` shows it.
5. `livediff archive . --stale`, then `livediff comments --archived` — shows a purge countdown.
6. `livediff restore <id>`, then `livediff comments --stale` — it is back and not archived.
7. `/livediff:prune` — previews without deleting, and asks before doing anything.
8. `livediff doctor` — the `comment archive` finding reports size and suggests a command.
