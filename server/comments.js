import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm, rmdir, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { configDir } from "./registry.js";
import { writeJsonAtomic } from "./atomic.js";
import { currentBranch } from "./git.js";
import { isOrphaned, shouldArchive, shouldPurge } from "./comment-lifecycle.js";

/**
 * Comments are stored centrally — keyed by workspace id, not inside the worktree — so livediff
 * never leaves files in a registered repo. Agents never touch this store directly; they go through
 * the `livediff` CLI / HTTP API, which is what makes the storage location free to change.
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

/**
 * Append `from`'s comments onto `into`'s and delete `from`'s store. Used when two registry
 * entries collapse to one workspace. Returns how many comments moved.
 */
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

/** mtime signature used by the hub to detect edits (including migration) for live reload. */
export async function commentsSignature(wsId) {
  try {
    const info = await stat(storePath(wsId));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}

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
