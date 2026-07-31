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
