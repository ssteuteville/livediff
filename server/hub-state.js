import { readFile, unlink, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import {
  APP_DIR_NAME,
  ENV,
  LOCK_FILENAME,
  LOCK_STALE_MS,
  LOG_FILENAME,
  LOOPBACK_HOST,
  PROBE_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  STATE_FILENAME,
} from "./constants.js";

/**
 * Hub runtime state lives under XDG_STATE_HOME, not XDG_CONFIG_HOME: it describes a running
 * process, is meaningless after a reboot, and must not be mistaken for user configuration.
 */
export function stateDir() {
  const base = process.env[ENV.XDG_STATE_HOME] || join(homedir(), ".local", "state");
  return join(base, APP_DIR_NAME);
}

export const statePath = () => join(stateDir(), STATE_FILENAME);
export const lockPath = () => join(stateDir(), LOCK_FILENAME);
export const logPath = () => join(stateDir(), LOG_FILENAME);

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

/**
 * Ports the WHATWG Fetch spec refuses to connect to. Node's fetch enforces this, so the hub must
 * never bind one: it could listen fine while every CLI call failed with an opaque "bad port".
 * https://fetch.spec.whatwg.org/#port-blocking
 */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

export function isBlockedPort(port) {
  return BLOCKED_PORTS.has(port);
}

export async function probeMeta(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/api/meta`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Resolve true once `predicate` holds, false at the deadline. */
export async function waitUntil(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Ask a hub to exit, falling back to SIGTERM, and wait until its port stops answering. Shared by
 * `livediff stop` and by ensureHub replacing a mismatched version — they had drifted apart.
 */
export async function shutdownHub(state) {
  await fetch(`http://${LOOPBACK_HOST}:${state.port}/api/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  });
  const stopped = await waitUntil(
    async () => !(await probeMeta(state.port, 200)),
    SHUTDOWN_TIMEOUT_MS,
  );
  await clearState();
  return stopped;
}
