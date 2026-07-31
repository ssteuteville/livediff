import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";

import { getDiff, summary, worktreeSignature, isGitRepo } from "./git.js";
import { readComments, addComment, updateComment, deleteComment } from "./comments.js";
import {
  readRegistry,
  addWorkspace,
  removeWorkspace,
  registrySignature,
  resolveWorkspace,
  configDir,
} from "./registry.js";
import { writeState, clearState, probeMeta, isBlockedPort } from "./hub-state.js";
import { migrateRegistry } from "./migrations.js";
import { openReview, reviewFor, completeReview, cancelReview } from "./reviews.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

const PREFERRED_PORT = Number(process.env.LIVEDIFF_PORT || 4180);
let BOUND_PORT = PREFERRED_PORT;
const POLL_MS = Number(process.env.LIVEDIFF_POLL_MS || 1000);

let VERSION = "0.0.0";
try {
  VERSION = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")).version;
} catch {
  /* keep default */
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const sseClients = new Set();

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Resolve the target workspace from ?ws=<id> or ?path=<dir> on the request. */
function resolveWs(url) {
  return resolveWorkspace({
    ws: url.searchParams.get("ws"),
    path: url.searchParams.get("path"),
  });
}

/** Registered workspaces enriched with live git + comment info for the rail. */
async function workspacesView() {
  const registered = await readRegistry();
  return Promise.all(
    registered.map(async (w) => {
      let info = { valid: false, branch: null, head: null, changedFiles: 0 };
      try {
        info = await summary(w.path);
      } catch {
        /* leave invalid */
      }
      let openComments = 0;
      try {
        openComments = (await readComments(w.id, w.path)).filter((c) => c.status === "open").length;
      } catch {
        /* none */
      }
      return { ...w, ...info, openComments };
    })
  );
}

async function serveStatic(req, res, url) {
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (pathname === "/api/meta") {
      return send(res, 200, {
        name: "livediff",
        port: BOUND_PORT,
        version: VERSION,
        clients: sseClients.size,
        polling: pollTimer !== null,
      });
    }

    if (pathname === "/api/shutdown" && req.method === "POST") {
      send(res, 200, { ok: true });
      setTimeout(() => {
        clearState().finally(() => process.exit(0));
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
      if (!body.path) return send(res, 400, { error: "path required" });
      let ws;
      try {
        ws = await addWorkspace(resolvePath(body.path), body.label);
      } catch (err) {
        return send(res, 400, { error: String(err.message || err) });
      }
      broadcast("workspaces", { reason: "added", ws: ws.id });
      return send(res, 201, ws);
    }

    const wsMatch = pathname.match(/^\/api\/workspaces\/([\w-]+)$/);
    if (wsMatch && req.method === "DELETE") {
      const ok = await removeWorkspace(wsMatch[1]);
      broadcast("workspaces", { reason: "removed", ws: wsMatch[1] });
      return send(res, ok ? 200 : 404, { ok });
    }

    if (pathname === "/api/diff") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const base = url.searchParams.get("base") || null;
      return send(res, 200, await getDiff(ws.path, base));
    }

    if (pathname === "/api/comments" && req.method === "GET") {
      const ws = await resolveWs(url);
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      return send(res, 200, { comments: await readComments(ws.id, ws.path) });
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
      if (req.method === "PATCH") {
        const updated = await updateComment(ws.id, ws.path, id, await readBody(req));
        if (!updated) return send(res, 404, { error: "not found" });
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
      const ws = await resolveWorkspace({ ws: body.ws, path: body.path });
      if (!ws) return send(res, 404, { error: "unknown workspace" });
      const review = openReview(ws.id);
      broadcast("review", { ws: ws.id, reviewId: review.reviewId, state: "open" });
      return send(res, 201, review);
    }

    const reviewDone = pathname.match(/^\/api\/reviews\/([\w-]+)\/done$/);
    if (reviewDone && req.method === "POST") {
      const review = completeReview(reviewDone[1]);
      if (!review) return send(res, 404, { error: "no such review" });
      broadcast("review", { ws: review.ws, reviewId: review.reviewId, state: "done" });
      return send(res, 200, review);
    }

    const reviewCancel = pathname.match(/^\/api\/reviews\/([\w-]+)$/);
    if (reviewCancel && req.method === "DELETE") {
      const review = cancelReview(reviewCancel[1]);
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
      res.write("retry: 2000\n\n");
      sseClients.add(res);
      startPolling();
      req.on("close", () => {
        sseClients.delete(res);
        if (sseClients.size === 0) stopPolling();
      });
      return;
    }

    return serveStatic(req, res, url);
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
});

/**
 * Bind `preferred`, or the next free port after it. An occupied port whose occupant is an
 * equivalent livediff hub means this process is redundant — signalled by returning null.
 */
async function listenWithFallback(srv, preferred, tries = 20) {
  for (let port = preferred; port < preferred + tries; port++) {
    if (isBlockedPort(port)) continue;
    try {
      await new Promise((res, rej) => {
        const onError = (err) => rej(err);
        srv.once("error", onError);
        srv.listen(port, "127.0.0.1", () => {
          srv.removeListener("error", onError);
          res();
        });
      });
      return port;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
    // Only now is a probe worth its cost. The timeout is generous because this is the first
    // fetch in a cold process, which pays undici's one-time initialization.
    const meta = await probeMeta(port, 2000);
    if (meta && meta.name === "livediff" && meta.version === VERSION) return null;
  }
  throw new Error(`no free port in ${preferred}..${preferred + tries - 1}`);
}

const diffSigs = new Map();
let registrySig = null;
let pollTimer = null;

/**
 * Drop workspaces whose worktree is gone. Keeps the rail honest without the user having to
 * `livediff rm` every deleted agent worktree.
 */
async function prune(registered) {
  const kept = [];
  for (const w of registered) {
    if (await isGitRepo(w.path)) {
      kept.push(w);
      continue;
    }
    await removeWorkspace(w.id);
    broadcast("workspaces", { reason: "pruned", ws: w.id });
  }
  return kept;
}

async function poll() {
  try {
    const sig = await registrySignature();
    if (registrySig !== null && sig !== registrySig) broadcast("workspaces", { reason: "registry" });
    registrySig = sig;
  } catch {
    /* ignore */
  }

  let registered = [];
  try {
    registered = await prune(await readRegistry());
  } catch {
    return;
  }
  const liveIds = new Set(registered.map((w) => w.id));
  for (const id of diffSigs.keys()) if (!liveIds.has(id)) diffSigs.delete(id);

  for (const w of registered) {
    try {
      const sig = await worktreeSignature(w.path, null);
      const prev = diffSigs.get(w.id);
      if (prev !== undefined && sig !== prev) broadcast("diff", { reason: "worktree", ws: w.id });
      diffSigs.set(w.id, sig);
    } catch {
      /* transient git state */
    }
  }
}

/**
 * Watching a worktree costs a `git status` per tick per workspace. With nobody looking at the
 * UI that is pure waste, so the loop runs only while an SSE client is attached — which is what
 * makes a hub that never exits affordable.
 */
function startPolling() {
  if (pollTimer) return;
  poll();
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
function watchConfigDir() {
  const dir = configDir();
  const fire = debounce((file) => {
    if (file === "workspaces.json") return broadcast("workspaces", { reason: "file" });
    const match = /^([0-9a-f]{8})\.json$/.exec(file ?? "");
    if (match) broadcast("comments", { reason: "file", ws: match[1] });
  }, 50);

  const attach = (target, mapName) => {
    try {
      const watcher = watch(target, (_event, name) => fire(mapName(name)));
      watcher.on("error", () => {});
      return true;
    } catch {
      return false;
    }
  };

  mkdirSync(join(dir, "comments"), { recursive: true });
  attach(dir, (name) => name);
  attach(join(dir, "comments"), (name) => name);
}

function debounce(fn, ms) {
  const pending = new Map();
  return (key) => {
    if (key === null || key === undefined) return;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        fn(key);
      }, ms)
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
      clearState().finally(() => process.exit(0));
    });
  }

  const link = `http://localhost:${port}`;
  console.log(`livediff hub → ${link}  (v${VERSION})`);
  if (process.env.LIVEDIFF_OPEN === "1") {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    execFile(opener, [link], () => {});
  }
}

main();
