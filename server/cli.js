#!/usr/bin/env node
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { ensureHub, hubVersion } from "./ensure-hub.js";
import { readState, clearState, pidAlive } from "./hub-state.js";
import { findCommand, renderCommandHelp, renderMainHelp, suggest } from "./cli-help.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const args = argv.filter((a) => !a.startsWith("-"));
const JSON_OUT = flags.has("--json");
const WANTS_HELP = flags.has("-h") || flags.has("--help");
const WANTS_VERSION = flags.has("-v") || flags.has("--version");

/** stdout writes to a pipe are queued; exiting without draining them truncates output. */
async function exit(code) {
  await new Promise((r) => process.stdout.write("", r));
  process.exit(code);
}

function out(human, data) {
  console.log(JSON_OUT ? JSON.stringify(data, null, 2) : human);
}

async function die(message, code = EXIT_ERROR) {
  console.error(message);
  await exit(code);
}

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) await die(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const isId = (s) => /^[0-9a-f]{8}$/.test(s);

/**
 * Only unambiguous path shapes are treated as paths, so a mistyped subcommand reports itself
 * instead of silently trying to register a directory that does not exist.
 */
const looksLikePath = (s) =>
  s === "." ||
  s === ".." ||
  s.startsWith("/") ||
  s.startsWith("./") ||
  s.startsWith("../") ||
  s.startsWith("~");

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}

/**
 * Consume an SSE stream, yielding `{event, data}`. Node has no EventSource, and pulling in a
 * polyfill for one long-lived connection is not worth a dependency.
 */
async function* sseEvents(base, signal) {
  const res = await fetch(`${base}/api/events`, { signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !raw) continue;
      try {
        yield { event, data: JSON.parse(raw) };
      } catch {
        /* keepalive or malformed frame */
      }
    }
  }
}

function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

async function waitForReview(base, ws) {
  const review = await api(base, "/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ws: ws.id }),
  });

  const ac = new AbortController();
  const cancel = () => {
    fetch(`${base}/api/reviews/${review.reviewId}`, { method: "DELETE" }).finally(() => {
      ac.abort();
      process.exit(EXIT_ERROR);
    });
  };
  process.once("SIGINT", cancel);

  const seconds = Number(flagValue("--timeout") || 0);
  const timer = seconds > 0 ? setTimeout(() => ac.abort(), seconds * 1000) : null;

  if (!JSON_OUT) console.log('waiting for review… (click "Done reviewing" in the browser)');

  try {
    for await (const { event, data } of sseEvents(base, ac.signal)) {
      if (event !== "review") continue;
      if (data.reviewId !== review.reviewId) continue;
      if (data.state === "done") return true;
      if (data.state === "cancelled") return false;
    }
  } catch {
    if (timer) clearTimeout(timer);
    await die(`timed out after ${seconds}s waiting for review`);
  }
  if (timer) clearTimeout(timer);
  return false;
}

async function cmdOpen(pathArg) {
  const base = await ensureHub();
  const path = resolve(pathArg || process.cwd());
  const ws = await api(base, "/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const url = `http://localhost:${new URL(base).port}/?ws=${ws.id}&focus=1`;
  const quiet = flags.has("--no-open");
  if (!quiet) openBrowser(url);
  out(`${quiet ? "registered" : "opened"} ${ws.label} → ${url}`, { ...ws, url });

  if (!flags.has("--wait")) return;

  const completed = await waitForReview(base, ws);
  const { comments } = await api(base, `/api/comments?ws=${ws.id}`);
  const open = comments.filter((c) => c.status === "open").length;
  if (!completed) await die("review cancelled");
  out(`review complete ✓ — ${comments.length} comments (${open} open)`, {
    ...ws,
    url,
    review: "done",
    comments: comments.length,
    openComments: open,
  });
}

async function cmdHubUi() {
  const base = await ensureHub();
  const url = `http://localhost:${new URL(base).port}/`;
  openBrowser(url);
  out(`livediff → ${url}`, { url });
}

async function cmdList() {
  const base = await ensureHub();
  const { workspaces } = await api(base, "/api/workspaces");
  if (JSON_OUT) return out("", { workspaces });
  if (!workspaces.length) return out("no workspaces registered — `livediff .` to add one", {});
  for (const w of workspaces) {
    console.log(`${w.id}  ${String(w.label).padEnd(20)}  ${w.path}`);
  }
}

async function resolveWs(base, pathArg) {
  return api(base, `/api/resolve?path=${encodeURIComponent(resolve(pathArg || process.cwd()))}`);
}

async function cmdRemove(target) {
  const base = await ensureHub();
  const arg = target || process.cwd();
  const id = isId(arg) ? arg : (await resolveWs(base, arg)).id;
  const body = await api(base, `/api/workspaces/${id}`, { method: "DELETE" });
  out(body.ok ? `removed ${id}` : `not registered: ${id}`, { id, ...body });
}

async function cmdComments(pathArg) {
  const base = await ensureHub();
  const ws = await resolveWs(base, pathArg);
  const { comments } = await api(base, `/api/comments?ws=${ws.id}`);
  if (JSON_OUT) return out("", { workspace: ws.id, comments });
  if (!comments.length) return console.log("no comments");
  for (const c of comments) {
    console.log(`${c.id}  ${c.status.padEnd(8)}  ${c.file}:${c.line}  ${c.body}`);
  }
}

async function cmdReplyOrResolve(rest, resolveIt) {
  const [id, ...text] = rest;
  const name = resolveIt ? "resolve" : "reply";
  if (!id) {
    await die(`usage: ${findCommand(name).usage}\n\nRun \`livediff help ${name}\` for details.`, EXIT_USAGE);
  }
  const body = text.join(" ").trim();
  if (!resolveIt && !body) await die("reply text required", EXIT_USAGE);

  const base = await ensureHub();
  const ws = await resolveWs(base);
  const patch = {};
  if (resolveIt) patch.status = "resolved";
  if (body) patch.reply = { author: "claude", body };
  const updated = await api(base, `/api/comments/${id}?ws=${ws.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  out(`${resolveIt ? "resolved" : "replied to"} ${updated.id}`, updated);
}

/** Lifecycle, not data — the one command that talks to the state file instead of HTTP. */
async function cmdStop() {
  const state = await readState();
  if (!state) return out("hub is not running", { running: false });
  await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    if (pidAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(state.pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await clearState();
  out("hub stopped", { running: false });
}

function helpFor(token) {
  if (!token) return renderMainHelp(hubVersion());
  const cmd = findCommand(token);
  if (cmd) return renderCommandHelp(cmd);
  return null;
}

async function cmdHelp(token) {
  const text = helpFor(token);
  if (text === null) {
    const hint = suggest(token);
    await die(
      `unknown command: ${token}${hint ? `\n\nDid you mean \`livediff ${hint}\`?` : ""}\n\nRun \`livediff --help\` to see available commands.`,
      EXIT_USAGE
    );
  }
  console.log(text);
}

async function main() {
  const [cmd, ...rest] = args;

  if (WANTS_VERSION) return out(hubVersion(), { version: hubVersion() });
  if (WANTS_HELP) return cmdHelp(cmd);

  switch (cmd) {
    case undefined:
      return cmdHubUi();
    case "help":
      return cmdHelp(rest[0]);
    case "list":
    case "ls":
      return cmdList();
    case "rm":
    case "remove":
      return cmdRemove(rest[0]);
    case "comments":
      return cmdComments(rest[0]);
    case "resolve":
      return cmdReplyOrResolve(rest, true);
    case "reply":
      return cmdReplyOrResolve(rest, false);
    case "stop":
      return cmdStop();
    default:
      if (looksLikePath(cmd)) return cmdOpen(cmd);
      return cmdHelp(cmd);
  }
}

try {
  await main();
  await exit(EXIT_OK);
} catch (err) {
  await die(String(err.message || err));
}
