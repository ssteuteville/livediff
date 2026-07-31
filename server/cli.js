#!/usr/bin/env node
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { addWorkspace, removeWorkspace, readRegistry, idFor, resolveWorkspace } from "./registry.js";
import { readComments, updateComment } from "./comments.js";

const PORT = Number(process.env.LIVEDIFF_PORT || 4180);
// Use the IPv4 loopback explicitly: the hub binds 127.0.0.1 and Node's fetch does not
// fall back from ::1 the way browsers do.
const HUB = `http://127.0.0.1:${PORT}`;

async function hubRunning() {
  try {
    const res = await fetch(`${HUB}/api/meta`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

const isId = (s) => /^[0-9a-f]{8}$/.test(s);

async function cmdAdd(arg) {
  const path = resolve(arg || process.cwd());
  if (await hubRunning()) {
    const res = await fetch(`${HUB}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      console.error(`add failed: ${(await res.json()).error || res.statusText}`);
      process.exit(1);
    }
    const ws = await res.json();
    console.log(`registered ${ws.label} (${ws.id}) → ${HUB}`);
  } else {
    const ws = await addWorkspace(path);
    console.log(`registered ${ws.label} (${ws.id}). Start the hub with \`livediff\`.`);
  }
}

async function cmdOpen(arg) {
  const path = resolve(arg || process.cwd());
  if (!(await hubRunning())) {
    console.error("hub isn't running — start it with `livediff` (or `LIVEDIFF_OPEN=1 livediff`) first.");
    process.exit(1);
  }
  const res = await fetch(`${HUB}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    console.error(`open failed: ${(await res.json()).error || res.statusText}`);
    process.exit(1);
  }
  const ws = await res.json();
  const url = `http://localhost:${PORT}/?ws=${ws.id}&focus=1`;
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
  console.log(`opened focused view of ${ws.label} → ${url}`);
}

async function cmdRemove(arg) {
  const target = arg || process.cwd();
  const id = isId(target) ? target : idFor(resolve(target));
  if (await hubRunning()) {
    const res = await fetch(`${HUB}/api/workspaces/${id}`, { method: "DELETE" });
    console.log((await res.json()).ok ? `removed ${id}` : `not registered: ${id}`);
  } else {
    console.log((await removeWorkspace(target)) ? `removed ${id}` : `not registered: ${id}`);
  }
}

async function requireWorkspace(pathArg) {
  const ws = await resolveWorkspace({ path: pathArg || process.cwd() });
  if (!ws) {
    console.error("no workspace registered for this path — run `livediff add .` first");
    process.exit(1);
  }
  return ws;
}

async function cmdComments(pathArg) {
  const ws = await requireWorkspace(pathArg);
  let comments;
  if (await hubRunning()) {
    comments = (await (await fetch(`${HUB}/api/comments?ws=${ws.id}`)).json()).comments;
  } else {
    comments = await readComments(ws.id, ws.path);
  }
  console.log(JSON.stringify({ workspace: ws.id, comments }, null, 2));
}

async function applyPatch(ws, id, patch) {
  if (await hubRunning()) {
    const res = await fetch(`${HUB}/api/comments/${id}?ws=${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error(`failed: ${(await res.json()).error || res.statusText}`);
      process.exit(1);
    }
    return res.json();
  }
  const updated = await updateComment(ws.id, ws.path, id, patch);
  if (!updated) {
    console.error(`comment not found: ${id}`);
    process.exit(1);
  }
  return updated;
}

// `livediff resolve <id> [reply text…]`  — mark resolved, optionally with a reply.
// `livediff reply   <id> <reply text…>`  — reply without resolving.
async function cmdReplyOrResolve([id, ...rest], resolveIt) {
  if (!id) {
    console.error(`usage: livediff ${resolveIt ? "resolve" : "reply"} <comment-id> ${resolveIt ? "[text…]" : "<text…>"}`);
    process.exit(1);
  }
  const text = rest.join(" ").trim();
  const patch = {};
  if (resolveIt) patch.status = "resolved";
  if (text) patch.reply = { author: "claude", body: text };
  if (!resolveIt && !text) {
    console.error("reply text required");
    process.exit(1);
  }
  const ws = await requireWorkspace();
  const updated = await applyPatch(ws, id, patch);
  console.log(`${resolveIt ? "resolved" : "replied to"} ${updated.id}`);
}

async function cmdList() {
  const workspaces = await readRegistry();
  if (!workspaces.length) {
    console.log("no workspaces registered — `livediff add <path>` to add one");
    return;
  }
  for (const w of workspaces) console.log(`${w.id}  ${w.label.padEnd(20)}  ${w.path}`);
}

function usage() {
  console.log(`livediff — live worktree diff hub

usage:
  livediff                 start the hub (http://localhost:${PORT})
  livediff add [path]      register a worktree/repo (default: cwd)
  livediff open [path]     register (if needed) and open a focused single-workspace view
  livediff rm  [path|id]   unregister
  livediff list            list registered workspaces
  livediff comments [path] print the review comments for a worktree (default: cwd) as JSON
  livediff resolve <id> [text…]   reply (optional) and mark a comment resolved
  livediff reply   <id> <text…>   reply to a comment without resolving

env: LIVEDIFF_PORT, LIVEDIFF_OPEN=1 (open browser), LIVEDIFF_POLL_MS`);
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "serve":
  case "hub":
    await import("./index.js");
    break;
  case "add":
    await cmdAdd(arg);
    break;
  case "open":
    await cmdOpen(arg);
    break;
  case "rm":
  case "remove":
    await cmdRemove(arg);
    break;
  case "list":
  case "ls":
    await cmdList();
    break;
  case "comments":
    await cmdComments(arg);
    break;
  case "resolve":
    await cmdReplyOrResolve(process.argv.slice(3), true);
    break;
  case "reply":
    await cmdReplyOrResolve(process.argv.slice(3), false);
    break;
  case "-h":
  case "--help":
  case "help":
    usage();
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    usage();
    process.exit(1);
}
