#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureHub, hubVersion } from "./ensure-hub.js";
import { readState, shutdownHub } from "./hub-state.js";
import { findCommand, renderCommandHelp, renderMainHelp, suggest, VALUE_FLAGS } from "./cli-help.js";
import { openBrowser } from "./open-browser.js";
import { sseEvents } from "./sse.js";
import { diagnose } from "./doctor.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/**
 * One pass over argv, so "is this flag set" and "what is its value" can't disagree. A flag that
 * takes a value consumes the next token, keeping it out of positionals; everything else — including
 * comment text starting with `-`, like a diff line or a negative number — stays an argument.
 */
function parseArgv(tokens) {
  const flags = new Set();
  const values = new Map();
  const args = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      args.push(...tokens.slice(i + 1));
      break;
    }
    const isFlag = token.startsWith("--") || /^-[a-zA-Z]$/.test(token);
    if (!isFlag) {
      args.push(token);
      continue;
    }
    flags.add(token);
    if (VALUE_FLAGS.has(token)) values.set(token, tokens[++i] ?? null);
  }
  return { flags, values, args };
}

const { flags, values, args } = parseArgv(process.argv.slice(2));
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
 * A bare token is a path if it is written like one, or if it actually names a directory — so
 * `livediff feat-a` works while `livediff frobnicate` still reports an unknown command rather
 * than a confusing "not a git worktree".
 */
async function isPathArg(token) {
  if (/^(\/|~|\.\.?(\/|$))/.test(token)) return true;
  try {
    return (await stat(resolve(token))).isDirectory();
  } catch {
    return false;
  }
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

  const seconds = Number(values.get("--timeout") || 0);
  const timer = seconds > 0 ? setTimeout(() => ac.abort(), seconds * 1000) : null;

  if (!JSON_OUT) console.log('waiting for review… (click "Done reviewing" in the browser)');

  try {
    for await (const { event, data } of sseEvents(`${base}/api/events`, ac.signal)) {
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
  const plural = comments.length === 1 ? "comment" : "comments";
  out(`review complete ✓ — ${comments.length} ${plural} (${open} open)`, {
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
  const quiet = flags.has("--no-open");
  if (!quiet) openBrowser(url);
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
    const replies = c.replies?.length ?? 0;
    const thread = replies === 0 ? "" : `  (${replies} ${replies === 1 ? "reply" : "replies"})`;
    console.log(`${c.id}  ${c.status.padEnd(8)}  ${c.file}:${c.line}  ${c.body}${thread}`);
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
  const stopped = await shutdownHub(state);
  if (!stopped) await die("hub did not stop; it may be wedged");
  out("hub stopped", { running: false });
}

const MARK = { ok: "✓", warn: "!", error: "✗" };

async function cmdDoctor() {
  const findings = await diagnose(hubVersion());
  const failed = findings.some((f) => f.level === "error");
  if (JSON_OUT) {
    console.log(JSON.stringify({ version: hubVersion(), findings }, null, 2));
    return exit(failed ? EXIT_ERROR : EXIT_OK);
  }
  console.log(`livediff doctor — v${hubVersion()}\n`);
  for (const f of findings) {
    console.log(`${MARK[f.level]} ${f.title}`);
    for (const line of String(f.detail ?? "").split("\n").filter(Boolean)) {
      console.log(`    ${line}`);
    }
    if (f.fix) console.log(`    → ${f.fix}`);
  }
  const problems = findings.filter((f) => f.level !== "ok").length;
  const noun = problems === 1 ? "thing" : "things";
  console.log(problems === 0 ? "\nAll good." : `\n${problems} ${noun} to look at.`);
  if (failed) await exit(EXIT_ERROR);
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
    case "doctor":
      return cmdDoctor();
    default:
      if (await isPathArg(cmd)) return cmdOpen(cmd);
      return cmdHelp(cmd);
  }
}

try {
  await main();
  await exit(EXIT_OK);
} catch (err) {
  await die(String(err.message || err));
}
