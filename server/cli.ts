#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { ensureHub, hubVersion } from "./ensure-hub.js";
import { readState, shutdownHub } from "./hub-state.js";
import {
  findCommand,
  renderCommandHelp,
  renderMainHelp,
  suggest,
  VALUE_FLAGS,
} from "./cli-help.js";
import { openBrowser } from "./open-browser.js";
import { sseEvents } from "./sse.js";
import { diagnose } from "./doctor.js";
import {
  COMMENT_STATUSES,
  filterByStatus,
  formatComments,
  emptyMessage,
} from "./comment-format.js";
import type { CommentStatus, LifecycleComment } from "./comment-lifecycle.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, ID_PATTERN, PURGE_DAYS } from "./constants.js";

type JsonRecord = Record<string, unknown>;

interface Workspace extends JsonRecord {
  id: string;
  path: string;
  label: string;
}

interface Comment extends LifecycleComment, JsonRecord {
  id: string;
  body: string;
  line: number;
  lineContent?: string | null;
  replies?: readonly unknown[];
}

interface Review {
  reviewId: string;
}

interface ParsedArgv {
  flags: Set<string>;
  values: Map<string, string | null>;
  args: string[];
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`invalid API response: expected ${key}`);
  return field;
}

function numberField(value: JsonRecord, key: string): number {
  const field = value[key];
  if (typeof field !== "number") throw new Error(`invalid API response: expected ${key}`);
  return field;
}

function parseWorkspace(value: unknown): Workspace {
  if (!isRecord(value)) throw new Error("invalid API response: expected workspace");
  return {
    ...value,
    id: stringField(value, "id"),
    path: stringField(value, "path"),
    label: stringField(value, "label"),
  };
}

function parseComment(value: unknown): Comment {
  if (!isRecord(value)) throw new Error("invalid API response: expected comment");
  const status = stringField(value, "status");
  if (status !== "open" && status !== "resolved")
    throw new Error("invalid API response: expected comment status");
  const commentStatus: CommentStatus = status;
  const archivedAt = value["archivedAt"];
  if (archivedAt !== null && typeof archivedAt !== "string") {
    throw new Error("invalid API response: expected archivedAt");
  }
  const lineContent = value["lineContent"];
  if (lineContent !== undefined && lineContent !== null && typeof lineContent !== "string") {
    throw new Error("invalid API response: expected lineContent");
  }
  const replies = value["replies"];
  if (replies !== undefined && !Array.isArray(replies)) {
    throw new Error("invalid API response: expected replies");
  }
  return {
    ...value,
    id: stringField(value, "id"),
    body: stringField(value, "body"),
    file: stringField(value, "file"),
    line: numberField(value, "line"),
    status: commentStatus,
    archivedAt,
    updatedAt: stringField(value, "updatedAt"),
    ...(lineContent === undefined ? {} : { lineContent }),
    ...(replies === undefined ? {} : { replies }),
  };
}

function parseRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("invalid API response: expected object");
  return value;
}

function parseWorkspaces(value: unknown): { workspaces: Workspace[] } {
  const body = parseRecord(value);
  if (!Array.isArray(body["workspaces"]))
    throw new Error("invalid API response: expected workspaces");
  return { workspaces: body["workspaces"].map(parseWorkspace) };
}

function parseComments(value: unknown): { comments: Comment[] } {
  const body = parseRecord(value);
  if (!Array.isArray(body["comments"])) throw new Error("invalid API response: expected comments");
  return { comments: body["comments"].map(parseComment) };
}

function parseStale(value: unknown): string[] {
  const body = parseRecord(value);
  const stale = body["stale"];
  if (!Array.isArray(stale) || !stale.every((entry) => typeof entry === "string")) {
    throw new Error("invalid API response: expected stale comment ids");
  }
  return stale;
}

function parseReview(value: unknown): Review {
  const body = parseRecord(value);
  return { reviewId: stringField(body, "reviewId") };
}

function errorMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value["error"] === "string" ? value["error"] : fallback;
}

/**
 * One pass over argv, so "is this flag set" and "what is its value" can't disagree. A flag that
 * takes a value consumes the next token, keeping it out of positionals; everything else — including
 * comment text starting with `-`, like a diff line or a negative number — stays an argument.
 */
function parseArgv(tokens: readonly string[]): ParsedArgv {
  const flags = new Set<string>();
  const values = new Map<string, string | null>();
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
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
async function exit(code: number): Promise<never> {
  await new Promise<void>((resolveOutput, rejectOutput) =>
    process.stdout.write("", (error) => (error ? rejectOutput(error) : resolveOutput())),
  );
  process.exit(code);
}

function out(human: string, data: unknown): void {
  console.log(JSON_OUT ? JSON.stringify(data, null, 2) : human);
}

async function die(message: string, code = EXIT_ERROR): Promise<never> {
  console.error(message);
  return exit(code);
}

async function api<T>(
  base: string,
  path: string,
  parse: (body: unknown) => T,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) await die(errorMessage(body, `${res.status} ${res.statusText}`));
  return parse(body);
}

const isId = (value: string): boolean => ID_PATTERN.test(value);

/**
 * A bare token is a path if it is written like one, or if it actually names a directory — so
 * `livediff feat-a` works while `livediff frobnicate` still reports an unknown command rather
 * than a confusing "not a git worktree".
 */
async function isPathArg(token: string): Promise<boolean> {
  if (/^(\/|~|\.\.?(\/|$))/.test(token)) return true;
  try {
    return (await stat(resolve(token))).isDirectory();
  } catch {
    return false;
  }
}

async function waitForReview(base: string, ws: Workspace): Promise<boolean> {
  const review = await api(base, "/api/reviews", parseReview, {
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
      if (!isRecord(data) || data["reviewId"] !== review.reviewId) continue;
      if (data["state"] === "done") return true;
      if (data["state"] === "cancelled") return false;
    }
  } catch {
    if (timer) clearTimeout(timer);
    await die(`timed out after ${seconds}s waiting for review`);
  }
  if (timer) clearTimeout(timer);
  return false;
}

async function cmdOpen(pathArg: string): Promise<void> {
  const base = await ensureHub();
  const path = resolve(pathArg || process.cwd());
  const ws = await api(base, "/api/workspaces", parseWorkspace, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  // Registering resolves to the worktree root, so a subdirectory argument would otherwise be
  // silently widened to the whole repo. Carry it as a view filter instead of a second workspace.
  const dir = relative(ws.path, path);
  const scope = dir && !dir.startsWith("..") ? `&dir=${encodeURIComponent(dir)}` : "";
  const url = `http://localhost:${new URL(base).port}/?ws=${ws.id}&focus=1${scope}`;
  const quiet = flags.has("--no-open");
  const opened = quiet ? false : await openBrowser(url);
  const name = scope ? `${ws.label}/${dir}` : ws.label;
  const human = quiet
    ? `registered ${name} → ${url}`
    : opened
      ? `opened ${name} → ${url}`
      : `registered ${name} → ${url} (could not open a browser)`;
  out(human, { ...ws, url, opened, dir: scope ? dir : null });

  if (!flags.has("--wait")) return;

  const completed = await waitForReview(base, ws);
  const { comments } = await api(base, `/api/comments?ws=${ws.id}`, parseComments);
  const open = comments.filter((c) => c.status === "open").length;
  if (!completed) await die("review cancelled");
  out(`review complete ✓ — ${plural(comments.length, "comment")} (${open} open)`, {
    ...ws,
    url,
    opened,
    review: "done",
    comments: comments.length,
    openComments: open,
  });
}

async function cmdHubUi(): Promise<void> {
  const base = await ensureHub();
  const url = `http://localhost:${new URL(base).port}/`;
  const quiet = flags.has("--no-open");
  const opened = quiet ? false : await openBrowser(url);
  const note = !quiet && !opened ? " (could not open a browser)" : "";
  out(`livediff → ${url}${note}`, { url, opened });
}

async function cmdList(): Promise<void> {
  const base = await ensureHub();
  const { workspaces } = await api(base, "/api/workspaces", parseWorkspaces);
  if (JSON_OUT) return out("", { workspaces });
  if (!workspaces.length) return out("no workspaces registered — `livediff .` to add one", {});
  for (const w of workspaces) {
    console.log(`${w.id}  ${String(w.label).padEnd(20)}  ${w.path}`);
  }
}

async function resolveWs(base: string, pathArg?: string): Promise<Workspace> {
  return api(
    base,
    `/api/resolve?path=${encodeURIComponent(resolve(pathArg || process.cwd()))}`,
    parseWorkspace,
  );
}

async function cmdRemove(target?: string): Promise<void> {
  const base = await ensureHub();
  const arg = target || process.cwd();
  const id = isId(arg) ? arg : (await resolveWs(base, arg)).id;
  const body = await api(base, `/api/workspaces/${id}`, parseRecord, { method: "DELETE" });
  out(body["ok"] === true ? `removed ${id}` : `not registered: ${id}`, { id, ...body });
}

async function cmdComments(pathArg?: string): Promise<void> {
  const statusInput = values.get("--status") ?? "open";
  const selectedStatus = COMMENT_STATUSES.find((candidate) => candidate === statusInput);
  const status =
    selectedStatus ??
    (await die(`--status must be one of: ${COMMENT_STATUSES.join(", ")}`, EXIT_USAGE));
  const wantStale = flags.has("--stale");
  const wantArchived = flags.has("--archived");
  if (wantStale && wantArchived) {
    await die("--stale and --archived cannot be combined", EXIT_USAGE);
  }

  const base = await ensureHub();
  const ws = await resolveWs(base, pathArg);
  const branch = values.get("--branch");
  const query = branch ? `&branch=${encodeURIComponent(branch)}` : "";
  const { comments } = await api(base, `/api/comments?ws=${ws.id}${query}`, parseComments);
  const staleIds = new Set(await api(base, `/api/stale?ws=${ws.id}`, parseStale));

  const view = comments.filter((c) => {
    if (wantArchived) return Boolean(c.archivedAt);
    if (c.archivedAt) return false;
    return wantStale ? staleIds.has(c.id) : !staleIds.has(c.id);
  });

  const selected = filterByStatus(view, status);
  if (JSON_OUT) return out("", { workspace: ws.id, comments: selected });
  if (!selected.length) return console.log(emptyMessage(view, status));
  console.log(formatComments(selected));
}

async function cmdRestore(id?: string): Promise<void> {
  const command = findCommand("restore");
  if (!id || !command) await die("usage: livediff restore <comment-id>", EXIT_USAGE);
  const base = await ensureHub();
  const ws = await resolveWs(base);
  const body = await api(base, `/api/comments/${id}/restore?ws=${ws.id}`, parseRecord, {
    method: "POST",
  });
  out(`restored ${stringField(body, "id")}`, body);
}

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`;

async function cmdArchive(pathArg?: string): Promise<void> {
  const force = { stale: flags.has("--stale"), resolved: flags.has("--resolved") };
  const base = await ensureHub();
  const body = await api(base, "/api/sweep", parseRecord, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: pathArg ? resolve(pathArg) : null, force }),
  });
  out(
    `archived ${plural(numberField(body, "archived"), "comment")} across ${plural(numberField(body, "workspaces"), "workspace")}`,
    body,
  );
}

/** stdin is not a TTY under an agent or a pipe, so a prompt there would hang forever. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    await die(`${question}\nRefusing to prompt without a terminal — pass --yes.`, EXIT_USAGE);
  }
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolveAnswer) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => resolveAnswer(String(data).trim().toLowerCase()));
  });
  return answer === "y" || answer === "yes";
}

async function cmdPrune(pathArg?: string): Promise<void> {
  const all = flags.has("--all");
  const keepRaw = values.get("--keep-days");
  if (all && keepRaw !== undefined) {
    await die("--keep-days and --all cannot be combined", EXIT_USAGE);
  }
  const keepDays = all ? 0 : keepRaw === undefined ? PURGE_DAYS : Number(keepRaw);
  if (!Number.isFinite(keepDays) || keepDays < 0) {
    await die("--keep-days must be a non-negative number", EXIT_USAGE);
  }

  const dryRun = flags.has("--dry-run");
  const base = await ensureHub();
  const path = pathArg ? resolve(pathArg) : null;
  const post = (body: JsonRecord): Promise<JsonRecord> =>
    api(base, "/api/purge", parseRecord, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  if (!dryRun && keepDays < PURGE_DAYS && !flags.has("--yes")) {
    const preview = await post({ path, keepDays, dryRun: true });
    if (numberField(preview, "count") === 0) return out("nothing to prune", { count: 0 });
    const ok = await confirm(
      `Delete ${plural(numberField(preview, "count"), "archived comment")}? This cannot be undone.`,
    );
    if (!ok) return out("cancelled", { count: 0, cancelled: true });
  }

  const body = await post({ path, keepDays, dryRun });
  const verb = dryRun ? "would delete" : "pruned";
  out(
    `${verb} ${plural(numberField(body, "count"), "archived comment")} across ${plural(numberField(body, "workspaces"), "workspace")}`,
    body,
  );
}

async function cmdReplyOrResolve(rest: readonly string[], resolveIt: boolean): Promise<void> {
  const [id, ...text] = rest;
  const name = resolveIt ? "resolve" : "reply";
  const command = findCommand(name);
  if (!id || !command) {
    await die(
      `usage: ${command?.usage ?? `livediff ${name} <id>`}\n\nRun \`livediff help ${name}\` for details.`,
      EXIT_USAGE,
    );
  }
  const body = text.join(" ").trim();
  if (!resolveIt && !body) await die("reply text required", EXIT_USAGE);

  const base = await ensureHub();
  const ws = await resolveWs(base);
  const patch: JsonRecord = {};
  if (resolveIt) patch["status"] = "resolved";
  if (body) patch["reply"] = { author: "claude", body };
  const updated = await api(base, `/api/comments/${id}?ws=${ws.id}`, parseRecord, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  out(`${resolveIt ? "resolved" : "replied to"} ${stringField(updated, "id")}`, updated);
}

/** Lifecycle, not data — the one command that talks to the state file instead of HTTP. */
async function cmdStop(): Promise<void> {
  const state = await readState();
  if (!state) return out("hub is not running", { running: false });
  const stopped = await shutdownHub(state);
  if (!stopped) await die("hub did not stop; it may be wedged");
  out("hub stopped", { running: false });
}

const MARK: Record<"ok" | "warn" | "error", string> = { ok: "✓", warn: "!", error: "✗" };

async function cmdDoctor(): Promise<void> {
  const findings = await diagnose(hubVersion());
  const failed = findings.some((f) => f.level === "error");
  if (JSON_OUT) {
    console.log(JSON.stringify({ version: hubVersion(), findings }, null, 2));
    return exit(failed ? EXIT_ERROR : EXIT_OK);
  }
  console.log(`livediff doctor — v${hubVersion()}\n`);
  for (const f of findings) {
    console.log(`${MARK[f.level]} ${f.title}`);
    for (const line of String(f.detail ?? "")
      .split("\n")
      .filter(Boolean)) {
      console.log(`    ${line}`);
    }
    if (f.fix) console.log(`    → ${f.fix}`);
  }
  const problems = findings.filter((f) => f.level !== "ok").length;
  const noun = problems === 1 ? "thing" : "things";
  console.log(problems === 0 ? "\nAll good." : `\n${problems} ${noun} to look at.`);
  if (failed) await exit(EXIT_ERROR);
}

function helpFor(token?: string): string | null {
  if (!token) return renderMainHelp(hubVersion());
  const cmd = findCommand(token);
  if (cmd) return renderCommandHelp(cmd);
  return null;
}

async function cmdHelp(token?: string): Promise<void> {
  const text = helpFor(token);
  if (text === null) {
    const hint = suggest(token ?? "");
    await die(
      `unknown command: ${token}${hint ? `\n\nDid you mean \`livediff ${hint}\`?` : ""}\n\nRun \`livediff --help\` to see available commands.`,
      EXIT_USAGE,
    );
  }
  console.log(text);
}

async function main(): Promise<void> {
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
    case "restore":
      return cmdRestore(rest[0]);
    case "archive":
      return cmdArchive(rest[0]);
    case "prune":
      return cmdPrune(rest[0]);
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
  await die(err instanceof Error ? err.message : String(err));
}
