import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, basename, sep } from "node:path";
import { writeJsonAtomic } from "./atomic.js";

/**
 * The registry is the on-disk source of truth for which workspaces the hub shows.
 * Global (shared across every repo you launch the hub from) at
 * $XDG_CONFIG_HOME/livediff/workspaces.json (defaults to ~/.config/livediff).
 * Shape: { workspaces: [ { id, path, label, addedAt } ] }
 */

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "livediff");
}

export function registryPath() {
  return join(configDir(), "workspaces.json");
}

/** Stable, idempotent id derived from the absolute path. */
export function idFor(path) {
  return createHash("sha1").update(resolve(path)).digest("hex").slice(0, 8);
}

const isId = (s) => /^[0-9a-f]{8}$/.test(s);

export async function readRegistry() {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.workspaces) ? data.workspaces : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeRegistry(workspaces) {
  await writeJsonAtomic(registryPath(), { workspaces });
}

/** Add (or update the label of) a workspace. Idempotent by path. */
export async function addWorkspace(path, label) {
  const abs = resolve(path);
  const id = idFor(abs);
  const workspaces = await readRegistry();
  const existing = workspaces.find((w) => w.id === id);
  if (existing) {
    if (label && label !== existing.label) {
      existing.label = label;
      await writeRegistry(workspaces);
    }
    return existing;
  }
  const ws = { id, path: abs, label: label || basename(abs), addedAt: new Date().toISOString() };
  workspaces.push(ws);
  await writeRegistry(workspaces);
  return ws;
}

/** Remove by id or by path. Returns true if something was removed. */
export async function removeWorkspace(idOrPath) {
  const workspaces = await readRegistry();
  const targetId = isId(idOrPath) ? idOrPath : idFor(idOrPath);
  const next = workspaces.filter((w) => w.id !== targetId);
  if (next.length !== workspaces.length) {
    await writeRegistry(next);
    return true;
  }
  return false;
}

/**
 * Resolve a workspace from either an explicit id or a filesystem path. A path resolves to the
 * registered workspace that contains it (exact match, else nearest ancestor), so a caller can pass
 * its current working directory even from a subdirectory of the worktree. Returns null if none.
 */
export async function resolveWorkspace({ ws, path } = {}) {
  const workspaces = await readRegistry();
  if (ws) return workspaces.find((w) => w.id === ws) || null;
  if (path) {
    const abs = resolve(path);
    const exact = workspaces.find((w) => w.id === idFor(abs));
    if (exact) return exact;
    return (
      workspaces
        .filter((w) => abs === w.path || abs.startsWith(w.path + sep))
        .sort((a, b) => b.path.length - a.path.length)[0] || null
    );
  }
  return null;
}

/** mtime signature used by the hub to detect external edits to the registry. */
export async function registrySignature() {
  try {
    const info = await stat(registryPath());
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}
