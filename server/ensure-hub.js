import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readState, clearState, pidAlive, probeMeta, waitUntil, shutdownHub,
  acquireLock, releaseLock, logPath, stateDir,
} from "./hub-state.js";
import { APP_DIR_NAME, SPAWN_WAIT_TIMEOUT_MS } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "index.js");

let VERSION = "0.0.0";
try {
  VERSION = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")).version;
} catch {
  /* keep default */
}

export function hubVersion() {
  return VERSION;
}

let ensured = null;

/** Test seam: clears the per-process memo so a suite can exercise several hub lifecycles. */
export function resetEnsuredHub() {
  ensured = null;
}

const url = (port) => `http://127.0.0.1:${port}`;

async function waitForHub(timeoutMs) {
  let found = null;
  await waitUntil(async () => {
    const state = await readState();
    if (!state) return false;
    const meta = await probeMeta(state.port, 1000);
    if (!meta || meta.version !== VERSION) return false;
    found = url(state.port);
    return true;
  }, timeoutMs);
  return found;
}

async function spawnHub() {
  await mkdir(stateDir(), { recursive: true });
  const log = await open(logPath(), "a");
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  await log.close();
}

async function failure() {
  let tail = "";
  try {
    tail = (await readFile(logPath(), "utf8")).split("\n").slice(-20).join("\n");
  } catch {
    /* no log */
  }
  return new Error(`livediff hub failed to start${tail ? `\n\n${tail}` : ""}`);
}

/**
 * Return the base URL of a live hub running our version, starting or replacing one if needed.
 * Memoized: the first command in a process pays the cost, the rest connect directly.
 */
export async function ensureHub() {
  if (ensured) return ensured;

  const state = await readState();
  if (state) {
    const meta = await probeMeta(state.port, 1000);
    const isOurs = meta?.name === APP_DIR_NAME;
    if (isOurs && meta.version === VERSION) return (ensured = url(state.port));
    if (isOurs || pidAlive(state.pid)) await shutdownHub(state);
    else await clearState();
  }

  // Whoever takes the lock spawns; everyone else waits for the same hub to appear.
  const spawner = await acquireLock();
  try {
    if (spawner) await spawnHub();
    const found = await waitForHub(SPAWN_WAIT_TIMEOUT_MS);
    if (!found) throw await failure();
    return (ensured = found);
  } finally {
    if (spawner) await releaseLock();
  }
}
