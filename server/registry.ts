import { createHash } from "node:crypto";
import { APP_DIR_NAME, ENV, ID_LENGTH, ID_PATTERN, REGISTRY_FILENAME } from "./constants.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, basename, sep } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { toplevel } from "./git.js";

export interface Workspace {
  id: string;
  path: string;
  label: string;
  addedAt: string;
  /**
   * The ref this worktree is reviewed against, or null for "the last commit". Durable because the
   * CLI and the background sweep both have to answer "is this file still in the diff?" long after
   * the browser tab that chose it has gone.
   */
  base: string | null;
}

function isWorkspaceRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const workspace = value;
  return (
    typeof workspace["id"] === "string" &&
    typeof workspace["path"] === "string" &&
    typeof workspace["label"] === "string" &&
    typeof workspace["addedAt"] === "string"
  );
}

/**
 * The one definition of what a base ref is: a non-empty string, or null for "the last commit".
 *
 * It crosses four boundaries — a JSON registry file, a request body, a query string, and a CLI
 * flag — and every one of them can present "no base" as absent, null, or "". Spelling the rule out
 * once means a change to it cannot be applied to five places and missed at the sixth.
 */
export function normalizeBase(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Migration is read-time: a registry written before `base` existed simply has no opinion about it,
 * and null is exactly the old behaviour. No rewrite is triggered on its own account — though a
 * registry rewritten for other reasons will serialize the field, which round-trips identically.
 */
function toWorkspace(value: Record<string, unknown>): Workspace {
  return {
    id: String(value["id"]),
    path: String(value["path"]),
    label: String(value["label"]),
    addedAt: String(value["addedAt"]),
    base: normalizeBase(value["base"]),
  };
}

function storedWorkspaces(value: unknown): Record<string, unknown>[] | null {
  if (!isRecord(value)) return null;
  const workspaces = value["workspaces"];
  if (!Array.isArray(workspaces) || !workspaces.every(isWorkspaceRecord)) return null;
  return workspaces;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The registry is the on-disk source of truth for which workspaces the hub shows.
 * Global (shared across every repo you launch the hub from) at
 * $XDG_CONFIG_HOME/livediff/workspaces.json (defaults to ~/.config/livediff).
 * Shape: { workspaces: [ { id, path, label, addedAt } ] }
 */

export function configDir() {
  const base = process.env[ENV.XDG_CONFIG_HOME] || join(homedir(), ".config");
  return join(base, APP_DIR_NAME);
}

export function registryPath() {
  return join(configDir(), REGISTRY_FILENAME);
}

/** Stable, idempotent id derived from the absolute path. */
export function idFor(path: string): string {
  return createHash("sha1").update(resolve(path)).digest("hex").slice(0, ID_LENGTH);
}

const isId = (value: string): boolean => ID_PATTERN.test(value);

/**
 * Registered paths come from `git rev-parse --show-toplevel`, which resolves symlinks — on macOS
 * /var and /tmp are symlinks, so a logical cwd would never match a stored physical path. Compare
 * canonical forms on both sides.
 */
async function canonical(path: string): Promise<string> {
  const abs = resolve(path);
  try {
    return await realpath(abs);
  } catch {
    return abs; // path no longer exists — fall back to the lexical form
  }
}

export async function readRegistry(): Promise<Workspace[]> {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const data: unknown = JSON.parse(raw);
    return (storedWorkspaces(data) ?? []).map(toWorkspace);
  } catch (err) {
    if (isNodeError(err, "ENOENT")) return [];
    throw err;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function writeRegistry(workspaces: Workspace[]): Promise<void> {
  await writeJsonAtomic(registryPath(), { workspaces });
}

/** Add (or update the label or base of) a workspace. Idempotent by worktree root. */
export async function addWorkspace(
  path: string,
  label?: string,
  base?: string | null,
): Promise<Workspace> {
  const root = await toplevel(resolve(path));
  if (!root) throw new Error(`not a git worktree: ${resolve(path)}`);
  const id = idFor(root);
  const workspaces = await readRegistry();
  const existing = workspaces.find((w) => w.id === id);
  if (existing) {
    // undefined means "no opinion" — re-registering must not silently clear a base someone set.
    const nextBase = base === undefined ? existing.base : normalizeBase(base);
    const changed = (label && label !== existing.label) || nextBase !== existing.base;
    if (label) existing.label = label;
    existing.base = nextBase;
    if (changed) await writeRegistry(workspaces);
    return existing;
  }
  const ws = {
    id,
    path: root,
    label: label || basename(root),
    addedAt: new Date().toISOString(),
    base: normalizeBase(base),
  };
  workspaces.push(ws);
  await writeRegistry(workspaces);
  return ws;
}

/** Set the ref a workspace is reviewed against. Returns the updated record, or null if unknown. */
export async function setWorkspaceBase(id: string, base: string | null): Promise<Workspace | null> {
  const workspaces = await readRegistry();
  const existing = workspaces.find((w) => w.id === id);
  if (!existing) return null;
  const next = normalizeBase(base);
  if (next === existing.base) return existing;
  existing.base = next;
  await writeRegistry(workspaces);
  return existing;
}

/** Remove by id or by path. Returns true if something was removed. */
export async function removeWorkspace(idOrPath: string): Promise<boolean> {
  const workspaces = await readRegistry();
  const targetId = isId(idOrPath) ? idOrPath : idFor(await canonical(idOrPath));
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
export async function resolveWorkspace({
  ws,
  path,
}: { ws?: string; path?: string } = {}): Promise<Workspace | null> {
  const workspaces = await readRegistry();
  if (ws) return workspaces.find((w) => w.id === ws) || null;
  if (path) {
    const abs = await canonical(path);
    const exact = workspaces.find((w) => w.id === idFor(abs));
    if (exact) return exact;
    return (
      workspaces
        .filter((w) => abs === w.path || abs.startsWith(w.path + sep))
        .toSorted((a, b) => b.path.length - a.path.length)[0] || null
    );
  }
  return null;
}

/** mtime signature used by the hub to detect external edits to the registry. */
export async function registrySignature(): Promise<string> {
  try {
    const info = await stat(registryPath());
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}
