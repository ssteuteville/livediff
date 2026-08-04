import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm, rmdir, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { configDir } from "./registry.js";
import {
  COMMENTS_DIR_NAME,
  COMMENT_STORE_VERSION,
  ID_LENGTH,
  LEGACY_COMMENT_DIR,
} from "./constants.js";
import { writeJsonAtomic } from "./atomic.js";
import { currentBranch } from "./git.js";
import {
  isOrphaned,
  shouldArchive,
  shouldPurge,
  type CommentStatus,
  type LifecycleComment,
} from "./comment-lifecycle.js";

type CommentSide = "old" | "new";
type CommentAuthor = "user" | "claude";

interface CommentReply {
  author: CommentAuthor;
  body: string;
  ts: string;
}

export interface Comment extends LifecycleComment {
  id: string;
  side: CommentSide;
  line: number;
  lineContent: string;
  body: string;
  author: CommentAuthor;
  branch: string | null;
  replies: CommentReply[];
  createdAt: string;
}

type CommentStore = Record<string, Comment>;

interface ListCommentsOptions {
  branch?: string;
}

interface SweepOptions {
  now?: number;
  force?: {
    stale?: boolean;
    resolved?: boolean;
  };
}

interface PurgeArchivedOptions {
  olderThanDays: number;
  now?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function commentStatus(value: unknown): CommentStatus {
  return value === "resolved" ? "resolved" : "open";
}

function commentSide(value: unknown): CommentSide {
  return value === "old" ? "old" : "new";
}

function commentAuthor(value: unknown): CommentAuthor {
  return value === "claude" ? "claude" : "user";
}

function parseReply(value: unknown): CommentReply | null {
  if (!isRecord(value) || typeof value["body"] !== "string") return null;
  return {
    author: commentAuthor(value["author"]),
    body: value["body"],
    ts: stringValue(value["ts"]),
  };
}

function parseComment(value: unknown, key?: string): Comment | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value["id"], key);
  const file = stringValue(value["file"]);
  if (!id) return null;
  const line =
    typeof value["line"] === "number" && Number.isFinite(value["line"]) ? value["line"] : 0;
  const replies = Array.isArray(value["replies"])
    ? value["replies"].flatMap((reply) => {
        const parsed = parseReply(reply);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    id,
    file,
    side: commentSide(value["side"]),
    line,
    lineContent: stringValue(value["lineContent"]),
    body: stringValue(value["body"]),
    author: commentAuthor(value["author"]),
    status: commentStatus(value["status"]),
    branch: typeof value["branch"] === "string" ? value["branch"] : null,
    archivedAt: typeof value["archivedAt"] === "string" ? value["archivedAt"] : null,
    replies,
    createdAt: stringValue(value["createdAt"]),
    updatedAt: stringValue(value["updatedAt"]),
  };
}

function toCommentStore(value: unknown): CommentStore {
  if (!isRecord(value)) return {};
  const comments: CommentStore = {};
  for (const [id, comment] of Object.entries(value)) {
    const parsed = parseComment(comment, id);
    if (parsed) comments[parsed.id] = parsed;
  }
  return comments;
}

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

function storePath(wsId: string): string {
  return join(configDir(), COMMENTS_DIR_NAME, `${wsId}.json`);
}

// Pre-v0.3 versions wrote comments into <worktree>/.diff-review/comments.json. Migrate that file
// into the central store the first time this workspace's comments are touched, then remove it so
// the worktree stops showing an untracked file.
async function migrateLegacy(wsId: string, repoPath: string | null): Promise<void> {
  if (!repoPath) return;
  const dest = storePath(wsId);
  try {
    await stat(dest);
    return; // already migrated (or never had legacy data)
  } catch {
    /* no central file yet — check for a legacy one */
  }
  const legacyDir = join(repoPath, LEGACY_COMMENT_DIR);
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
function normalize(data: unknown): CommentStore {
  if (!isRecord(data)) return {};
  const raw = data["comments"];
  if (Array.isArray(raw)) {
    const comments: CommentStore = {};
    for (const value of raw) {
      const parsed = parseComment(value);
      if (parsed) comments[parsed.id] = parsed;
    }
    return comments;
  }
  return toCommentStore(raw);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

async function readStore(wsId: string, repoPath: string | null): Promise<CommentStore> {
  await migrateLegacy(wsId, repoPath);
  try {
    return normalize(JSON.parse(await readFile(storePath(wsId), "utf8")));
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return {};
    throw err;
  }
}

async function writeStore(wsId: string, comments: CommentStore): Promise<void> {
  await writeJsonAtomic(storePath(wsId), { version: COMMENT_STORE_VERSION, comments });
}

/**
 * Comments for a workspace, optionally narrowed to one branch. A record with no branch matches
 * every branch — nothing will have one after the 0.6 wipe, but it costs one `||` and removes any
 * path where a record silently vanishes.
 */
export async function listComments(
  wsId: string,
  repoPath: string | null,
  { branch = "all" }: ListCommentsOptions = {},
): Promise<Comment[]> {
  const store = await readStore(wsId, repoPath);
  const all = Object.values(store);
  if (branch === "all") return all;
  return all.filter((c) => !c.branch || c.branch === branch);
}

/** O(1) — the reason the store is keyed. */
export async function getComment(wsId: string, id: string): Promise<Comment | null> {
  return (await readStore(wsId, null))[id] ?? null;
}

export async function addComment(
  wsId: string,
  repoPath: string | null,
  input: unknown,
): Promise<Comment> {
  if (
    !isRecord(input) ||
    typeof input["file"] !== "string" ||
    typeof input["line"] !== "number" ||
    !Number.isFinite(input["line"])
  ) {
    throw new TypeError("A comment requires a string file and finite numeric line");
  }
  const store = await readStore(wsId, repoPath);
  const now = new Date().toISOString();
  const comment: Comment = {
    id: randomUUID().slice(0, ID_LENGTH),
    file: input["file"],
    side: input["side"] === "old" ? "old" : "new",
    line: input["line"],
    lineContent: stringValue(input["lineContent"]),
    body: stringValue(input["body"]).trim(),
    author: input["author"] === "claude" ? "claude" : "user",
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

export async function updateComment(
  wsId: string,
  repoPath: string | null,
  id: string,
  patch: unknown,
): Promise<Comment | null> {
  const store = await readStore(wsId, repoPath);
  const comment = store[id];
  if (!comment) return null;
  if (!isRecord(patch)) return comment;
  if (typeof patch["body"] === "string") comment.body = patch["body"];
  if (patch["status"] === "open" || patch["status"] === "resolved")
    comment.status = patch["status"];
  if ("branch" in patch && (typeof patch["branch"] === "string" || patch["branch"] === null)) {
    comment.branch = patch["branch"];
  }
  if (
    isRecord(patch["reply"]) &&
    typeof patch["reply"]["body"] === "string" &&
    patch["reply"]["body"]
  ) {
    comment.replies.push({
      author: patch["reply"]["author"] === "user" ? "user" : "claude",
      body: patch["reply"]["body"].trim(),
      ts: new Date().toISOString(),
    });
  }
  comment.updatedAt = new Date().toISOString();
  await writeStore(wsId, store);
  return comment;
}

export async function deleteComment(
  wsId: string,
  repoPath: string | null,
  id: string,
): Promise<boolean> {
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
export async function mergeInto(fromWsId: string, intoWsId: string): Promise<number> {
  if (fromWsId === intoWsId) return 0;
  let incoming: CommentStore = {};
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
export async function commentsSignature(wsId: string): Promise<string> {
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
export async function sweep(
  wsId: string,
  repoPath: string | null,
  changed: readonly string[],
  { now = Date.now(), force = {} }: SweepOptions = {},
): Promise<{ archived: number; purged: number }> {
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
export async function restoreComment(wsId: string, id: string): Promise<Comment | null> {
  const store = await readStore(wsId, null);
  const comment = store[id];
  if (!comment) return null;
  comment.archivedAt = null;
  comment.updatedAt = new Date().toISOString();
  await writeStore(wsId, store);
  return comment;
}

/** Delete archived records older than an explicit window. `olderThanDays: 0` empties the archive. */
export async function purgeArchived(
  wsId: string,
  { olderThanDays, now = Date.now() }: PurgeArchivedOptions,
): Promise<number> {
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
export async function __writeForTest(wsId: string, comments: CommentStore): Promise<void> {
  await writeStore(wsId, comments);
}
