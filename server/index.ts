import { createServer } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, resolve as resolvePath } from "node:path";
import { openBrowser } from "./open-browser.js";

import {
  getDiff,
  summary,
  worktreeSignature,
  isGitRepo,
  currentBranch,
  changedPaths,
  toplevel,
  branches,
} from "./git.js";
import {
  listComments,
  addComment,
  updateComment,
  deleteComment,
  sweep,
  restoreComment,
  purgeArchived,
} from "./comments.js";
import {
  readRegistry,
  addWorkspace,
  removeWorkspace,
  registrySignature,
  resolveWorkspace,
  configDir,
} from "./registry.js";
import type { Workspace } from "./registry.js";
import { writeState, clearState, probeMeta, isBlockedPort } from "./hub-state.js";
import { loadConfig } from "./config.js";
import {
  APP_DIR_NAME,
  COMMENTS_DIR_NAME,
  DAY_MS,
  ENV,
  ID_LENGTH,
  LOOPBACK_HOST,
  PORT_FALLBACK_ATTEMPTS,
  REGISTRY_FILENAME,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  SWEEP_INTERVAL_MS,
} from "./constants.js";
import { migrateRegistry } from "./migrations.js";
import { openReview, reviewFor, closeReview } from "./reviews.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = import.meta.url.endsWith(".ts")
  ? join(__dirname, "..")
  : join(__dirname, "..", "..");
const DIST = join(projectRoot, "dist");

const CONFIG = loadConfig();
const PREFERRED_PORT = CONFIG.hub.port;
let BOUND_PORT = PREFERRED_PORT;
const POLL_MS = CONFIG.hub.pollIntervalMs;

let VERSION = "0.0.0";
try {
  const packageData: unknown = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  if (isRecord(packageData) && typeof packageData["version"] === "string")
    VERSION = packageData["version"];
} catch {
  /* keep default */
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const sseClients = new Set<ServerResponse>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function broadcast(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return {};
  }
}

/** Resolve the target workspace from ?ws=<id> or ?path=<dir> on the request. */
function resolveWs(url: URL): Promise<Workspace | null> {
  const ws = url.searchParams.get("ws");
  const path = url.searchParams.get("path");
  return resolveWorkspace({ ...(ws === null ? {} : { ws }), ...(path === null ? {} : { path }) });
}

/** No path means every registered workspace — these are maintenance routes, not review routes. */
async function targetWorkspaces(path: string | undefined): Promise<Workspace[]> {
  const all = await readRegistry();
  if (!path) return all;
  const root = (await toplevel(path)) ?? path;
  return all.filter((w) => w.path === root);
}

/** Registered workspaces enriched with live git + comment info for the rail. */
async function workspacesView() {
  const registered = await readRegistry();
  return Promise.all(
    registered.map(async (w) => {
      let info: Awaited<ReturnType<typeof summary>> = {
        valid: false,
        branch: null,
        head: null,
        changedFiles: 0,
      };
      try {
        info = await summary(w.path);
      } catch {
        /* leave invalid */
      }
      let openComments = 0;
      try {
        // Scoped to the branch summary() already reported, so the rail count can never
        // contradict what the diff view shows.
        const scoped = await listComments(w.id, w.path, { branch: info.branch ?? "all" });
        openComments = scoped.filter((c) => c.status === "open" && !c.archivedAt).length;
      } catch {
        /* none */
      }
      return { ...w, ...info, openComments };
    }),
  );
}

async function serveStatic(res: ServerResponse, url: URL): Promise<void> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = join(DIST, pathname);
  if (!filePath.startsWith(DIST)) return send(res, 403, { error: "forbidden" });
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("dir");
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    try {
      const html = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(html);
    } catch {
      send(res, 404, { error: "not found — did you run `pnpm build`?" });
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? LOOPBACK_HOST}`);
  const { pathname } = url;

  try {
    if (pathname === "/api/meta") {
      return send(res, 200, {
        name: APP_DIR_NAME,
        port: BOUND_PORT,
        version: VERSION,
        clients: sseClients.size,
        polling: pollTimer !== null,
        defaultRenderer: CONFIG.ui.defaultRenderer,
      });
    }

    if (pathname === "/api/config") {
      return send(res, 200, { defaultRenderer: CONFIG.ui.defaultRenderer });
    }

    if (pathname === "/api/shutdown" && req.method === "POST") {
      send(res, 200, { ok: true });
      setTimeout(() => {
        void clearState()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      }, 50);
      return;
    }

    if (pathname === "/api/resolve") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "no workspace registered for that path" });
      return send(res, 200, ws);
    }

    if (pathname === "/api/workspaces" && req.method === "GET") {
      return send(res, 200, { workspaces: await workspacesView() });
    }

    if (pathname === "/api/workspaces" && req.method === "POST") {
      const body = await readBody(req);
      const path = isRecord(body) ? stringValue(body["path"]) : undefined;
      const label = isRecord(body) ? stringValue(body["label"]) : undefined;
      if (!path) return send(res, 400, { error: "path required" });
      let ws: Workspace;
      try {
        ws = await addWorkspace(resolvePath(path), label);
      } catch (err) {
        return send(res, 400, { error: errorMessage(err) });
      }
      broadcast("workspaces", { reason: "added", ws: ws.id });
      return send(res, 201, ws);
    }

    const wsMatch = pathname.match(/^\/api\/workspaces\/([\w-]+)$/);
    if (wsMatch && req.method === "DELETE") {
      const id = wsMatch[1];
      if (!id) return send(res, 400, { error: "workspace id required" });
      const ok = await removeWorkspace(id);
      broadcast("workspaces", { reason: "removed", ws: id });
      return send(res, ok ? 200 : 404, { ok });
    }

    if (pathname === "/api/diff") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const base = url.searchParams.get("base") || null;
      return send(res, 200, await getDiff(ws.path, base));
    }

    if (pathname === "/api/refs") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      return send(res, 200, {
        branches: await branches(ws.path),
        current: await currentBranch(ws.path),
      });
    }

    if (pathname === "/api/comments" && req.method === "GET") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const requested = url.searchParams.get("branch");
      const branch = requested || (await currentBranch(ws.path).catch(() => "all"));
      return send(res, 200, { comments: await listComments(ws.id, ws.path, { branch }) });
    }

    if (pathname === "/api/stale" && req.method === "GET") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const changed = new Set(await changedPaths(ws.path).catch(() => []));
      const all = await listComments(ws.id, ws.path, { branch: "all" });
      return send(res, 200, { stale: all.filter((c) => !changed.has(c.file)).map((c) => c.id) });
    }

    const restoreMatch = pathname.match(/^\/api\/comments\/([\w-]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const id = restoreMatch[1];
      if (!id) return send(res, 400, { error: "comment id required" });
      const comment = await restoreComment(ws.id, id);
      if (!comment) return send(res, 404, { error: "unknown comment" });
      broadcast("comments", { reason: "restored", ws: ws.id });
      return send(res, 200, comment);
    }

    if (pathname === "/api/sweep" && req.method === "POST") {
      const body = await readBody(req);
      const path = isRecord(body) ? stringValue(body["path"]) : undefined;
      const bodyForce = isRecord(body) ? body["force"] : undefined;
      const force = isRecord(bodyForce)
        ? { stale: bodyForce["stale"] === true, resolved: bodyForce["resolved"] === true }
        : {};
      const targets = await targetWorkspaces(path);
      let archived = 0;
      let purged = 0;
      for (const w of targets) {
        const changed = await changedPaths(w.path).catch(() => []);
        const result = await sweep(w.id, w.path, changed, {
          force: force ?? {},
          policy: CONFIG.retention,
        });
        archived += result.archived;
        purged += result.purged;
      }
      if (archived || purged) broadcast("comments", { reason: "swept" });
      return send(res, 200, { archived, purged, workspaces: targets.length });
    }

    if (pathname === "/api/purge" && req.method === "POST") {
      const body = await readBody(req);
      const path = isRecord(body) ? stringValue(body["path"]) : undefined;
      const keepDays = isRecord(body) ? numberValue(body["keepDays"]) : undefined;
      const dryRun = isRecord(body) && body["dryRun"] === true;
      if (keepDays === undefined)
        return send(res, 400, { error: "keepDays must be a finite number" });
      const targets = await targetWorkspaces(path);
      const cutoff = Date.now() - keepDays * DAY_MS;
      let count = 0;
      for (const w of targets) {
        if (dryRun) {
          const all = await listComments(w.id, w.path, { branch: "all" });
          count += all.filter((c) => c.archivedAt && Date.parse(c.archivedAt) <= cutoff).length;
        } else {
          count += await purgeArchived(w.id, { olderThanDays: keepDays });
        }
      }
      if (count && !dryRun) broadcast("comments", { reason: "pruned" });
      return send(res, 200, { count, workspaces: targets.length, dryRun });
    }

    if (pathname === "/api/comments" && req.method === "POST") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const comment = await addComment(ws.id, ws.path, await readBody(req));
      broadcast("comments", { reason: "added", ws: ws.id });
      return send(res, 201, comment);
    }

    const commentMatch = pathname.match(/^\/api\/comments\/([\w-]+)$/);
    if (commentMatch) {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const id = commentMatch[1];
      if (!id) return send(res, 400, { error: "comment id required" });
      if (req.method === "PATCH") {
        const updated = await updateComment(ws.id, ws.path, id, await readBody(req));
        if (!updated) return send(res, 404, { error: `no comment with id ${id} in ${ws.label}` });
        broadcast("comments", { reason: "updated", ws: ws.id });
        return send(res, 200, updated);
      }
      if (req.method === "DELETE") {
        const ok = await deleteComment(ws.id, ws.path, id);
        broadcast("comments", { reason: "deleted", ws: ws.id });
        return send(res, ok ? 200 : 404, { ok });
      }
    }

    if (pathname === "/api/reviews" && req.method === "GET") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      return send(res, 200, { review: reviewFor(ws.id) });
    }

    if (pathname === "/api/reviews" && req.method === "POST") {
      const body = await readBody(req);
      const bodyWs = isRecord(body) ? stringValue(body["ws"]) : undefined;
      const bodyPath = isRecord(body) ? stringValue(body["path"]) : undefined;
      const ws = await resolveWorkspace({
        ...(bodyWs === undefined ? {} : { ws: bodyWs }),
        ...(bodyPath === undefined ? {} : { path: bodyPath }),
      });
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const review = openReview(ws.id);
      broadcast("review", { ws: ws.id, reviewId: review.reviewId, state: "open" });
      return send(res, 201, review);
    }

    const reviewDone = pathname.match(/^\/api\/reviews\/([\w-]+)\/done$/);
    if (reviewDone && req.method === "POST") {
      const reviewId = reviewDone[1];
      if (!reviewId) return send(res, 400, { error: "review id required" });
      const review = closeReview(reviewId);
      if (!review) return send(res, 404, { error: "no such review" });
      broadcast("review", { ws: review.ws, reviewId: review.reviewId, state: "done" });
      return send(res, 200, review);
    }

    const reviewCancel = pathname.match(/^\/api\/reviews\/([\w-]+)$/);
    if (reviewCancel && req.method === "DELETE") {
      const reviewId = reviewCancel[1];
      if (!reviewId) return send(res, 400, { error: "review id required" });
      const review = closeReview(reviewId);
      if (!review) return send(res, 404, { error: "no such review" });
      broadcast("review", { ws: review.ws, reviewId: review.reviewId, state: "cancelled" });
      return send(res, 200, { ok: true });
    }

    if (pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`retry: ${SSE_RETRY_MS}\n\n`);
      sseClients.add(res);
      startPolling();
      const heartbeat = setInterval(() => {
        // Writing to an already-destroyed response emits an unhandled `error` and takes the hub down.
        if (res.writableEnded || res.destroyed) return;
        res.write(":\n\n");
      }, SSE_HEARTBEAT_MS);
      // A connection dropped before this handler ran already emitted `close`, so no listener fires.
      if (res.destroyed) clearInterval(heartbeat);
      res.on("close", () => clearInterval(heartbeat));
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        if (sseClients.size === 0) stopPolling();
      });
      return;
    }

    return serveStatic(res, url);
  } catch (err) {
    return send(res, 500, { error: errorMessage(err) });
  }
});

/**
 * Bind `preferred`, or the next free port after it. An occupied port whose occupant is an
 * equivalent livediff hub means this process is redundant — signalled by returning null.
 */
async function listenWithFallback(
  srv: Server,
  preferred: number,
  tries = PORT_FALLBACK_ATTEMPTS,
): Promise<number | null> {
  for (let port = preferred; port < preferred + tries; port++) {
    if (isBlockedPort(port)) continue;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        srv.once("error", onError);
        srv.listen(port, LOOPBACK_HOST, () => {
          srv.removeListener("error", onError);
          resolve();
        });
      });
      return port;
    } catch (err) {
      const code =
        err instanceof Error && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined;
      if (code !== "EADDRINUSE") throw err;
    }
    // Only now is a probe worth its cost. The timeout is generous because this is the first
    // fetch in a cold process, which pays undici's one-time initialization.
    const meta = await probeMeta(port, 2000);
    if (meta && meta.name === "livediff" && meta.version === VERSION) return null;
  }
  throw new Error(`no free port in ${preferred}..${preferred + tries - 1}`);
}

const diffSigs = new Map<string, string>();
let registrySig: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;

/**
 * Sweeping needs one `changedPaths` spawn per workspace. The poll loop runs every second, and
 * the lifecycle thresholds are measured in days, so sweeping every tick would double git spawns
 * per second to enforce a five-day rule. Twice a day is ample; `livediff archive` forces it.
 */

let lastSweep = 0;

/**
 * Drop workspaces whose worktree is gone. Keeps the rail honest without the user having to
 * `livediff rm` every deleted agent worktree.
 */
async function pruneWorkspaces(registered: Workspace[]): Promise<Workspace[]> {
  const alive = await Promise.all(registered.map((w) => isGitRepo(w.path)));
  const kept = registered.filter((_, i) => alive[i]);
  for (const [i, w] of registered.entries()) {
    if (alive[i]) continue;
    await removeWorkspace(w.id);
    broadcast("workspaces", { reason: "pruned", ws: w.id });
  }
  return kept;
}

async function poll() {
  try {
    const sig = await registrySignature();
    if (registrySig !== null && sig !== registrySig)
      broadcast("workspaces", { reason: "registry" });
    registrySig = sig;
  } catch {
    /* ignore */
  }

  let registered: Workspace[] = [];
  try {
    registered = await pruneWorkspaces(await readRegistry());
  } catch {
    return;
  }
  const liveIds = new Set(registered.map((w) => w.id));
  for (const id of diffSigs.keys()) if (!liveIds.has(id)) diffSigs.delete(id);

  // One git spawn per workspace, run concurrently: sequential awaits made a tick cost
  // N × spawn-latency, every second, for as long as a browser was attached.
  const signatures = await Promise.all(
    registered.map((w) => worktreeSignature(w.path, null).catch(() => null)),
  );
  registered.forEach((w, i) => {
    const sig = signatures[i];
    if (sig === null || sig === undefined) return; // transient git state
    const prev = diffSigs.get(w.id);
    if (prev !== undefined && sig !== prev) broadcast("diff", { reason: "worktree", ws: w.id });
    diffSigs.set(w.id, sig);
  });

  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  const changed = await Promise.all(registered.map((w) => changedPaths(w.path).catch(() => null)));
  await Promise.all(
    registered.map(async (w, i) => {
      const workspaceChanged = changed[i];
      if (workspaceChanged === null || workspaceChanged === undefined) return; // transient git state
      const { archived, purged } = await sweep(w.id, w.path, workspaceChanged, {
        policy: CONFIG.retention,
      });
      if (archived || purged) broadcast("comments", { reason: "swept", ws: w.id });
    }),
  );
}

/**
 * Watching a worktree costs a `git status` per tick per workspace. With nobody looking at the
 * UI that is pure waste, so the loop runs only while an SSE client is attached — which is what
 * makes a hub that never exits affordable.
 */
function startPolling() {
  if (pollTimer) return;
  void poll();
  pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * The hub is the only writer to the registry and comment stores, so every mutation it performs
 * already broadcasts in-process — no watching required for the normal path. This exists purely
 * so a hand-edited JSON file still shows up live. Degrades to nothing if fs.watch is unsupported.
 */
function watchConfigDir(): void {
  const dir = configDir();
  const fire = debounce((file: string) => {
    if (file === REGISTRY_FILENAME) return broadcast("workspaces", { reason: "file" });
    const match = new RegExp(`^([0-9a-f]{${ID_LENGTH}})\\.json$`).exec(file ?? "");
    if (match) broadcast("comments", { reason: "file", ws: match[1] });
  }, 50);

  const attach = (target: string, mapName: (name: string | Buffer | null) => string | null) => {
    try {
      const watcher = watch(target, (_event, name) => fire(mapName(name)));
      watcher.on("error", () => {});
      return true;
    } catch {
      return false;
    }
  };

  mkdirSync(join(dir, COMMENTS_DIR_NAME), { recursive: true });
  attach(dir, (name) => (typeof name === "string" ? name : (name?.toString() ?? null)));
  attach(join(dir, COMMENTS_DIR_NAME), (name) =>
    typeof name === "string" ? name : (name?.toString() ?? null),
  );
}

function debounce(fn: (key: string) => void, ms: number): (key: string | null) => void {
  const pending = new Map<string, NodeJS.Timeout>();
  return (key) => {
    if (key === null) return;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        fn(key);
      }, ms),
    );
  };
}

async function main() {
  await migrateRegistry();
  watchConfigDir();

  const port = await listenWithFallback(server, PREFERRED_PORT);
  if (port === null) {
    console.log(`livediff hub already running on ${PREFERRED_PORT} — exiting`);
    process.exit(0);
  }
  BOUND_PORT = port;
  await writeState({
    pid: process.pid,
    port,
    version: VERSION,
    startedAt: new Date().toISOString(),
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void clearState()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  }

  const link = `http://localhost:${port}`;
  console.log(`livediff hub → ${link}  (v${VERSION})`);
  if (process.env[ENV.OPEN] === "1") void openBrowser(link);
}

void main();
