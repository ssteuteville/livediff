import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../registry.js";

/**
 * Serializes setup runs. Deliberately separate from the hub lock: setup holds it across npm
 * installs that can take minutes, so ownership is decided by whether the owning process is
 * alive, never by the lock's age.
 */

const SETUP_LOCK_FILENAME = "setup.lock";

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
}

export class SetupLockedError extends Error {
  readonly owner: { pid: number; startedAt: string };

  constructor(owner: { pid: number; startedAt: string }) {
    super(
      `another livediff setup is already running (pid ${owner.pid}, started ${owner.startedAt}). ` +
        "Wait for it to finish, or stop that process and run setup again.",
    );
    this.name = "SetupLockedError";
    this.owner = owner;
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
 * Take the setup lock, reclaiming it only from an owner on this host that is no longer running.
 * A live owner — or one on another host sharing this config directory — is never displaced.
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
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createExclusive(path, owner)) return ownedLock(path, owner.token);
    const existing = await readOwner(path);
    if (existing === null) continue;
    if (existing.host !== owner.host || alive(existing.pid)) throw new SetupLockedError(existing);
    await removeIfToken(path, existing.token);
  }
  const existing = await readOwner(path);
  if (existing !== null) throw new SetupLockedError(existing);
  throw new Error(
    `the setup lock at ${path} is unreadable. If no livediff setup is running, delete it and retry.`,
  );
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
  return { token, owned: false, release: async () => undefined };
}

async function createExclusive(path: string, owner: LockOwner): Promise<boolean> {
  try {
    await writeFile(path, JSON.stringify(owner) + "\n", { flag: "wx" });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
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

function ownedLock(path: string, token: string): SetupLock {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await removeIfToken(path, token);
  };
  return { token, owned: true, release };
}
