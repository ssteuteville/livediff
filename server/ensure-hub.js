import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readState, clearState, pidAlive, probeMeta,
  acquireLock, releaseLock, logPath, stateDir,
} from "./hub-state.js";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub(deadline) {
  while (Date.now() < deadline) {
    const state = await readState();
    if (state) {
      const meta = await probeMeta(state.port, 1000);
      if (meta && meta.version === VERSION) return url(state.port);
    }
    await sleep(50);
  }
  return null;
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

async function shutdown(state) {
  await fetch(`${url(state.port)}/api/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await probeMeta(state.port, 200))) await sleep(50);
  await clearState();
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
    if (meta && meta.name === "livediff") {
      if (meta.version === VERSION) return (ensured = url(state.port));
      await shutdown(state);
    } else if (!pidAlive(state.pid)) {
      await clearState();
    } else {
      await shutdown(state);
    }
  }

  const deadline = Date.now() + 10_000;
  if (await acquireLock()) {
    try {
      await spawnHub();
      const found = await waitForHub(deadline);
      if (!found) throw await failure();
      return (ensured = found);
    } finally {
      await releaseLock();
    }
  }

  const found = await waitForHub(deadline);
  if (!found) throw await failure();
  return (ensured = found);
}
