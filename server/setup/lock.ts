import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../registry.js";

const SETUP_LOCK_FILENAME = "setup.lock";
const ATTEMPTS = 5;
const UNREADABLE_RETRY_MS = 50;

/** Carries lock ownership from a `--update` parent to the freshly installed CLI it hands off to. */
export const SETUP_CONTINUATION_ENV = "LIVEDIFF_SETUP_CONTINUATION";

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  startedAt: string;
}

export interface SetupLock {
  token: string;
  /** Whether this process created the lock (and must release it) or adopted a parent's. */
  owned: boolean;
  release(): Promise<void>;
  /** For signal handlers, which cannot wait on a promise before the process exits. */
  releaseSync(): void;
}

export class SetupLockedError extends Error {
  readonly owner: { pid: number; startedAt: string };
  readonly path: string;

  constructor(owner: { pid: number; startedAt: string }, path: string) {
    super(
      `another livediff setup is already running (pid ${owner.pid}, started ${owner.startedAt}). ` +
        `Wait for it to finish, or stop that process and run setup again. If no setup is ` +
        `running, delete ${path} and retry.`,
    );
    this.name = "SetupLockedError";
    this.owner = owner;
    this.path = path;
  }
}

export function setupLockPath(): string {
  return join(configDir(), SETUP_LOCK_FILENAME);
}

export type ProcessAlive = (pid: number) => boolean;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else — still alive.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Take the setup lock, which serializes setup runs. It is deliberately separate from the hub
 * lock: setup holds it across npm installs that can take minutes, so ownership is decided by
 * whether the owning process is alive, never by the lock's age. A lock is reclaimed only from an
 * owner on this host that is no longer running; a live owner — or one on another host sharing
 * this config directory — is never displaced.
 */
export async function acquireSetupLock(
  path = setupLockPath(),
  alive: ProcessAlive = processAlive,
): Promise<SetupLock> {
  await mkdir(dirname(path), { recursive: true });
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (await createExclusive(path, owner)) return ownedLock(path, owner.token);
    const existing = await readOwner(path);
    if (existing === null) {
      // Possibly a lock being written right now; give its owner a moment to finish.
      await delay(UNREADABLE_RETRY_MS);
      continue;
    }
    if (existing.host !== owner.host || alive(existing.pid)) {
      throw new SetupLockedError(existing, path);
    }
    if ((await reclaimDead(path, existing.token)) === "busy") {
      const current = await readOwner(path);
      throw new SetupLockedError(current ?? existing, path);
    }
  }
  const existing = await readOwner(path);
  if (existing !== null) throw new SetupLockedError(existing, path);
  throw new Error(
    `the setup lock at ${path} is unreadable. If no livediff setup is running, delete it and retry.`,
  );
}

/**
 * Move a dead owner's lock aside before deleting it, so that two runs reclaiming at once cannot
 * each delete the lock the other just created: whoever renames the file reads back exactly what
 * it took. Taking a live lock by mistake puts it back.
 */
async function reclaimDead(path: string, deadToken: string): Promise<"reclaimed" | "busy"> {
  const aside = `${path}.${process.pid}.${randomUUID()}.reclaim`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (isCode(error, "ENOENT")) return "reclaimed";
    throw error;
  }
  const moved = await readOwner(aside);
  if (moved?.token === deadToken) {
    await rm(aside, { force: true });
    return "reclaimed";
  }
  try {
    await link(aside, path);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  await rm(aside, { force: true });
  return "busy";
}

/**
 * Adopt the lock a `--update` parent is holding for us. Only valid when the token matches the
 * current lock and that lock belongs to our parent process, so a leaked or replayed
 * continuation value cannot bypass serialization.
 */
export async function adoptSetupLock(
  token: string,
  path = setupLockPath(),
  parentPid = process.ppid,
): Promise<SetupLock | null> {
  const existing = await readOwner(path);
  if (existing === null || existing.token !== token || existing.pid !== parentPid) return null;
  return {
    token,
    owned: false,
    release: async () => undefined,
    releaseSync: () => undefined,
  };
}

async function createExclusive(path: string, owner: LockOwner): Promise<boolean> {
  try {
    await writeFile(path, JSON.stringify(owner) + "\n", { flag: "wx" });
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    return parseOwner(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function parseOwner(text: string): LockOwner | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const pid = "pid" in raw ? raw.pid : undefined;
  const host = "host" in raw ? raw.host : undefined;
  const token = "token" in raw ? raw.token : undefined;
  const startedAt = "startedAt" in raw ? raw.startedAt : undefined;
  if (typeof pid !== "number" || typeof host !== "string" || typeof token !== "string") {
    return null;
  }
  return { pid, host, token, startedAt: typeof startedAt === "string" ? startedAt : "unknown" };
}

/** Re-read right before removing, so a lock another run just took is left alone. */
async function removeIfToken(path: string, token: string): Promise<void> {
  const current = await readOwner(path);
  if (current?.token === token) await rm(path, { force: true });
}

function removeIfTokenSync(path: string, token: string): void {
  try {
    if (parseOwner(readFileSync(path, "utf8"))?.token === token) rmSync(path, { force: true });
  } catch {
    // Already gone, or unreadable — either way it is not ours to remove.
  }
}

function ownedLock(path: string, token: string): SetupLock {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await removeIfToken(path, token);
  };
  const releaseSync = (): void => {
    if (released) return;
    released = true;
    removeIfTokenSync(path, token);
  };
  return { token, owned: true, release, releaseSync };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
