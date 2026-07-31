import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm, rmdir, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { configDir } from "./registry.js";

/**
 * Comments are stored centrally — keyed by workspace id, not inside the worktree — so livediff
 * never leaves files in a registered repo. Agents never touch this store directly; they go through
 * the `livediff` CLI / HTTP API, which is what makes the storage location free to change.
 * Location: $XDG_CONFIG_HOME/livediff/comments/<workspace-id>.json (defaults to ~/.config/livediff).
 * Shape of one comment:
 * {
 *   id, file, side: "old"|"new", line, lineContent, body,
 *   author: "user"|"claude", status: "open"|"resolved",
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

export async function readComments(wsId, repoPath) {
  await migrateLegacy(wsId, repoPath);
  try {
    const raw = await readFile(storePath(wsId), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.comments) ? data.comments : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeComments(wsId, comments) {
  const file = storePath(wsId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ comments }, null, 2) + "\n", "utf8");
}

export async function addComment(wsId, repoPath, input) {
  const comments = await readComments(wsId, repoPath);
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
    replies: [],
    createdAt: now,
    updatedAt: now,
  };
  comments.push(comment);
  await writeComments(wsId, comments);
  return comment;
}

export async function updateComment(wsId, repoPath, id, patch) {
  const comments = await readComments(wsId, repoPath);
  const comment = comments.find((c) => c.id === id);
  if (!comment) return null;
  if (typeof patch.body === "string") comment.body = patch.body;
  if (patch.status === "open" || patch.status === "resolved") comment.status = patch.status;
  if (patch.reply && patch.reply.body) {
    comment.replies.push({
      author: patch.reply.author === "user" ? "user" : "claude",
      body: String(patch.reply.body).trim(),
      ts: new Date().toISOString(),
    });
  }
  comment.updatedAt = new Date().toISOString();
  await writeComments(wsId, comments);
  return comment;
}

export async function deleteComment(wsId, repoPath, id) {
  const comments = await readComments(wsId, repoPath);
  const next = comments.filter((c) => c.id !== id);
  if (next.length === comments.length) return false;
  await writeComments(wsId, next);
  return true;
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
