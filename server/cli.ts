#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { renderCompletion } from "./cli-completion.js";
import { ensureHub, hubVersion } from "./ensure-hub.js";
import { probeMeta, readState, shutdownHub } from "./hub-state.js";
import {
  arity,
  describeCli,
  describeCommand,
  findCommand,
  findCompletionCommand,
  findConfigCommand,
  GLOBAL_OPTION_NAMES,
  optionNames,
  renderCommandHelp,
  renderCompletionCommandHelp,
  renderConfigCommandHelp,
  renderMainHelp,
  suggest,
  VALUE_FLAGS,
  type CommandHelp,
} from "./cli-help.js";
import {
  completionInstallPath,
  completionStatus,
  installCompletion,
  resolveCompletionShell,
  uninstallCompletion,
} from "./completion-state.js";
import { openBrowser } from "./open-browser.js";
import {
  configPath,
  configValueSource,
  createConfigDraft,
  applyConfigDraft,
  ensureSchema,
  initConfig,
  loadConfig,
  schemaPath,
  setConfigValue,
  unsetConfigValue,
  updateSchema,
} from "./config.js";
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

const TIMEOUT_REASON = "livediff:review-timeout";

// undici reports a dropped body as a bare "terminated"; the reason it was dropped is only on `cause`.
function exceptionMessage(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  const cause = value.cause;
  return cause instanceof Error ? `${value.message} (${cause.message})` : value.message;
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

async function validateInvocation(
  command: string | undefined,
  rest: readonly string[],
): Promise<void> {
  const nested = command === "config" || command === "completion";
  const resolved =
    command === undefined
      ? findCommand("hub")
      : command === "config"
        ? findConfigCommand(rest[0] ?? "")
        : command === "completion"
          ? findCompletionCommand(rest[0] ?? "")
          : (await isPathArg(command))
            ? findCommand("open")
            : findCommand(command);
  // An unrecognized command is not an options problem. Let dispatch name it and suggest a
  // correction instead of blaming whichever flag happens to follow it. Nested actions still
  // validate here, so `config --badflag` stays strict.
  if (resolved === null && !nested) return;
  const allowed = new Set([
    ...GLOBAL_OPTION_NAMES,
    ...(resolved === null ? [] : optionNames(resolved)),
  ]);
  for (const flag of flags) {
    if (allowed.has(flag)) continue;
    await die(`unknown option '${flag}'${command ? ` for 'livediff ${command}'` : ""}`, EXIT_USAGE);
  }
  for (const [flag, value] of values) {
    if (value === null) await die(`${flag} requires a value`, EXIT_USAGE);
  }
  if (resolved === null) return;
  const positionalArgs = nested ? rest.slice(1) : rest;
  const label = command === undefined ? "hub" : nested ? rest.slice(0, 1).join(" ") : command;
  const helpTarget = nested ? command + " " : "";
  /** The shape of the invocation is wrong, so show the shape it should have had. */
  const shape = `\n\nusage: ${resolved.usage}\n  try: livediff help ${helpTarget}${label}`;
  const positionals = arity(resolved.args);
  if (positionalArgs.length < positionals.min) {
    await die(`missing required argument for 'livediff ${label}'${shape}`, EXIT_USAGE);
  }
  if (positionals.max !== null && positionalArgs.length > positionals.max) {
    const unexpected = positionalArgs[positionals.max];
    await die(
      `unexpected argument${unexpected === undefined ? "" : ` '${unexpected}'`} for 'livediff ${label}'${shape}`,
      EXIT_USAGE,
    );
  }
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
    void fetch(`${base}/api/reviews/${review.reviewId}`, { method: "DELETE" })
      .catch(() => undefined)
      .finally(() => {
        ac.abort();
        process.exit(EXIT_ERROR);
      });
  };
  process.once("SIGINT", cancel);

  const seconds = Number(values.get("--timeout") || 0);
  const timer = seconds > 0 ? setTimeout(() => ac.abort(TIMEOUT_REASON), seconds * 1000) : null;

  if (!JSON_OUT) console.log('waiting for review… (click "Done reviewing" in the browser)');

  try {
    for await (const { event, data } of sseEvents(`${base}/api/events`, ac.signal)) {
      if (event !== "review") continue;
      if (!isRecord(data) || data["reviewId"] !== review.reviewId) continue;
      if (data["state"] === "done") return true;
      if (data["state"] === "cancelled") return false;
    }
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (ac.signal.reason === TIMEOUT_REASON) {
      await die(`timed out after ${seconds}s waiting for review`);
    }
    await die(`lost the hub connection while waiting for review: ${exceptionMessage(err)}`);
  }
  if (timer) clearTimeout(timer);
  // The loop ending without a verdict means the stream died, which is not a human clicking cancel.
  return await die("lost the hub connection while waiting for review: the event stream ended");
}

async function cmdOpen(
  pathArg: string | undefined,
  behavior: { open?: boolean | undefined; wait?: boolean | undefined } = {},
): Promise<void> {
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
  const quiet = behavior.open === false || flags.has("--no-open");
  const opened = quiet ? false : await openBrowser(url);
  const name = scope ? `${ws.label}/${dir}` : ws.label;
  const human = quiet
    ? `registered ${name} → ${url}`
    : opened
      ? `opened ${name} → ${url}`
      : `registered ${name} → ${url} (could not open a browser)`;
  out(human, { ...ws, url, opened, dir: scope ? dir : null });

  if (behavior.wait !== true && !flags.has("--wait")) return;

  const completed = await waitForReview(base, ws);
  if (!completed) await die("review cancelled");
  const { comments } = await api(base, `/api/comments?ws=${ws.id}`, parseComments);
  const open = comments.filter((c) => c.status === "open").length;
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
    console.log(`${w.id}  ${w.label.padEnd(20)}  ${w.path}`);
  }
}

async function resolveWs(base: string, pathArg?: string): Promise<Workspace> {
  return api(
    base,
    `/api/resolve?path=${encodeURIComponent(resolve(pathArg || process.cwd()))}`,
    parseWorkspace,
  );
}

/**
 * Dynamic shell completion shells out to the CLI on every keystroke, so it must never start a
 * hub, prompt, or throw — silence and a fast exit are the only acceptable failure mode.
 */
async function runningHubBase(): Promise<string | null> {
  const state = await readState();
  if (!state) return null;
  const meta = await probeMeta(state.port, 300);
  return meta ? `http://127.0.0.1:${state.port}` : null;
}

/**
 * Liveness is a loopback round trip, but the data routes shell out to git, so they get a longer
 * budget — a cold or large repo would otherwise make Tab intermittently return nothing.
 */
async function tryFetch<T>(
  base: string,
  path: string,
  parse: (body: unknown) => T,
): Promise<T | null> {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    return null;
  }
}

/** Hidden: candidate workspace paths for shell completion. Prints `path<TAB>label` per line. */
async function cmdCompleteWorkspaces(): Promise<void> {
  const base = await runningHubBase();
  if (!base) return;
  const found = await tryFetch(base, "/api/workspaces", parseWorkspaces);
  for (const w of found?.workspaces ?? []) console.log(`${w.path}\t${w.label}`);
}

/** Hidden: candidate comment ids for shell completion. Prints `id<TAB>preview` per line. */
async function cmdCompleteComments(status: string | undefined): Promise<void> {
  const base = await runningHubBase();
  if (!base) return;
  const ws = await tryFetch(
    base,
    `/api/resolve?path=${encodeURIComponent(process.cwd())}`,
    parseWorkspace,
  );
  if (!ws) return;
  const found = await tryFetch(base, `/api/comments?ws=${ws.id}`, parseComments);
  const wantArchived = status === "archived";
  for (const c of found?.comments ?? []) {
    if (Boolean(c.archivedAt) !== wantArchived) continue;
    if (!wantArchived && c.status !== "open") continue;
    console.log(`${c.id}\t${c.body.slice(0, 40).replace(/\s+/g, " ")}`);
  }
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

async function cmdRestart(): Promise<void> {
  const state = await readState();
  if (state) {
    const stopped = await shutdownHub(state);
    if (!stopped) await die("hub did not stop; it may be wedged");
  }
  const base = await ensureHub();
  out(`hub restarted → ${base}`, { running: true, url: base });
}

async function cmdStatus(): Promise<void> {
  const state = await readState();
  const meta = state === null ? null : await probeMeta(state.port);
  const status = state === null ? "stopped" : meta === null ? "stale" : "running";
  const url = state === null ? null : `http://localhost:${state.port}`;
  out([`hub: ${status}${url === null ? "" : ` (${url})`}`, `config: ${configPath()}`].join("\n"), {
    hub:
      state === null
        ? { status }
        : {
            status,
            port: state.port,
            version: state.version,
            startedAt: state.startedAt,
            clients: meta?.clients ?? null,
            polling: meta?.polling ?? null,
          },
    configPath: configPath(),
  });
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
    for (const line of (f.detail ?? "").split("\n").filter(Boolean)) {
      console.log(`    ${line}`);
    }
    if (f.fix) console.log(`    → ${f.fix}`);
  }
  const problems = findings.filter((f) => f.level !== "ok").length;
  const noun = problems === 1 ? "thing" : "things";
  console.log(problems === 0 ? "\nAll good." : `\n${problems} ${noun} to look at.`);
  if (failed) await exit(EXIT_ERROR);
}

function configValue(key: string): unknown {
  const config = loadConfig();
  switch (key) {
    case "browser.opener":
      return config.browser.opener;
    case "tools.editor":
      return config.tools.editor;
    case "hub.port":
      return config.hub.port;
    case "hub.pollIntervalMs":
      return config.hub.pollIntervalMs;
    case "retention.orphanArchiveAfterDays":
      return config.retention.orphanArchiveAfterDays;
    case "retention.resolvedArchiveAfterDays":
      return config.retention.resolvedArchiveAfterDays;
    case "retention.purgeAfterDays":
      return config.retention.purgeAfterDays;
    case "retention.archiveWarningBytes":
      return config.retention.archiveWarningBytes;
    case "ui.defaultRenderer":
      return config.ui.defaultRenderer;
    default:
      throw new Error(`unknown configuration setting: ${key}`);
  }
}

function parseConfigValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseHumanValue(key: string, value: string): unknown {
  const byteMatch = /^([0-9]+)\s*(b|kb|kib|mb|mib|gb|gib)$/i.exec(value);
  if (key === "retention.archiveWarningBytes" && byteMatch) {
    const amount = Number(byteMatch[1]);
    const unit = byteMatch[2]?.toLowerCase();
    const multipliers: Readonly<Record<string, number>> = {
      b: 1,
      kb: 1_000,
      kib: 1_024,
      mb: 1_000_000,
      mib: 1_048_576,
      gb: 1_000_000_000,
      gib: 1_073_741_824,
    };
    return amount * (unit === undefined ? 1 : (multipliers[unit] ?? 1));
  }
  const durationMatch = /^([0-9]+)\s*(ms|s|m|h|d)$/i.exec(value);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    if (key === "hub.pollIntervalMs") {
      const multipliers: Readonly<Record<string, number>> = {
        ms: 1,
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
      };
      return amount * (unit === undefined ? 1 : (multipliers[unit] ?? 1));
    }
    if (key.startsWith("retention.") && unit === "d") return amount;
  }
  return parseConfigValue(value);
}

function requiresHubRestart(key: string): boolean {
  return (
    key.startsWith("hub.") ||
    key === "retention.orphanArchiveAfterDays" ||
    key === "retention.resolvedArchiveAfterDays" ||
    key === "retention.purgeAfterDays" ||
    key === "ui.defaultRenderer"
  );
}

async function cmdCompletion(completionArgs: readonly string[]): Promise<void> {
  const [action, requestedShell] = completionArgs;
  if (action === undefined) return cmdHelp(["completion"]);
  if (action === "bash" || action === "zsh" || action === "fish") {
    return out(renderCompletion(action), { shell: action });
  }
  try {
    const shell = resolveCompletionShell(requestedShell);
    switch (action) {
      case "install": {
        const status = await installCompletion(
          shell,
          renderCompletion(shell),
          flags.has("--activate"),
        );
        return out(
          "installed " +
            shell +
            " completion at " +
            status.path +
            (status.activated
              ? "\nactivated in " + status.activationPath
              : "\nrun livediff completion install " + shell + " --activate to activate it"),
          status,
        );
      }
      case "path":
        return out(completionInstallPath(shell), { shell, path: completionInstallPath(shell) });
      case "status": {
        const status = await completionStatus(shell);
        return out(
          [
            "shell: " + shell,
            "installed: " + (status.installed ? "yes" : "no"),
            "activated: " + (status.activated ? "yes" : "no") + " (" + status.activationPath + ")",
            "path: " + status.path,
          ].join("\n"),
          status,
        );
      }
      case "uninstall": {
        const status = await uninstallCompletion(shell, flags.has("--deactivate"));
        return out(
          "removed " +
            shell +
            " completion" +
            (flags.has("--deactivate") ? " and its activation block" : "") +
            "\npath: " +
            status.path,
          status,
        );
      }
      default:
        await die(
          "unknown completion action '" +
            action +
            "'; choose bash, zsh, fish, install, path, status, or uninstall",
          EXIT_USAGE,
        );
    }
  } catch (error) {
    await die(error instanceof Error ? error.message : String(error), EXIT_USAGE);
  }
}

function configSetValue(key: string, inputValues: readonly string[]): unknown {
  if (key === "browser.opener" || key === "tools.editor") {
    if (inputValues.length === 0)
      throw new Error(`usage: livediff config set ${key} <command> [args...]`);
    if (inputValues.length === 1 && inputValues[0]?.trim().startsWith("["))
      return parseConfigValue(inputValues[0]);
    const first = inputValues[0];
    if (inputValues.length === 1 && first !== undefined)
      return first.trim().split(/\s+/).filter(Boolean);
    return [...inputValues];
  }
  if (inputValues.length !== 1) throw new Error(`configuration setting ${key} accepts one value`);
  const value = inputValues[0];
  if (value === undefined) throw new Error(`configuration setting ${key} requires a value`);
  return parseHumanValue(key, value);
}

function editorCommand(): readonly string[] {
  const override = values.get("--editor");
  if (override !== undefined && override !== null) {
    const command = override.trim().split(/\s+/).filter(Boolean);
    if (command.length === 0) throw new Error("--editor must name an executable");
    return command;
  }
  const configured = loadConfig().tools.editor;
  if (configured !== null) return configured;
  const fallback = process.env["VISUAL"] ?? process.env["EDITOR"];
  if (fallback === undefined) return ["vim"];
  const command = fallback.trim().split(/\s+/).filter(Boolean);
  if (command.length === 0) throw new Error("VISUAL or EDITOR must name an executable");
  return command;
}

async function runEditor(command: readonly string[], path: string): Promise<void> {
  const executable = command[0];
  if (executable === undefined) throw new Error("editor command must name an executable");
  await new Promise<void>((resolveEditor, rejectEditor) => {
    const child = spawn(executable, [...command.slice(1), path], { stdio: "inherit" });
    child.once("error", rejectEditor);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolveEditor();
      rejectEditor(
        new Error(`editor exited ${signal ? `from ${signal}` : `with code ${code ?? 1}`}`),
      );
    });
  });
}

async function cmdConfig(rest: readonly string[]): Promise<void> {
  const [action = "list", key, ...configValues] = rest;
  switch (action) {
    case "edit": {
      const draft = await createConfigDraft();
      const command = editorCommand();
      await runEditor(command, draft.draftPath);
      try {
        await applyConfigDraft(draft.draftPath);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n\n` +
            `Your current config was not changed. Draft preserved at ${draft.draftPath}.`,
          { cause: error },
        );
      }
      return out(`updated ${draft.path}`, { path: draft.path, updated: true });
    }
    case "path":
      return out(configPath(), { path: configPath() });
    case "schema":
      if (flags.has("--update")) {
        const path = await updateSchema();
        return out(`updated ${path}`, { path, updated: true });
      }
      if (key !== undefined) return die("usage: livediff config schema [--update]", EXIT_USAGE);
      await ensureSchema();
      return out(schemaPath(), { schema: schemaPath() });
    case "init": {
      const path = await initConfig();
      return out(`created ${path}`, { path });
    }
    case "validate": {
      const config = loadConfig();
      return out("configuration is valid", { config });
    }
    case "list": {
      const config = loadConfig();
      return out(JSON.stringify(config, null, 2), { config });
    }
    case "get":
      if (!key) return die("usage: livediff config get <key>", EXIT_USAGE);
      return out(String(configValue(key)), { key, value: configValue(key) });
    case "set":
      if (!key || configValues.length === 0)
        return die("usage: livediff config set <key> <value>", EXIT_USAGE);
      await setConfigValue(key, configSetValue(key, configValues));
      const restartRequired = requiresHubRestart(key);
      return out(`set ${key}${restartRequired ? " — restart the hub to apply it" : ""}`, {
        key,
        value: configValue(key),
        restartRequired,
      });
    case "unset": {
      if (!key) return die("usage: livediff config unset <key>", EXIT_USAGE);
      const removed = await unsetConfigValue(key);
      const needsRestart = requiresHubRestart(key);
      return out(
        removed
          ? `unset ${key}${needsRestart ? " — run livediff restart to apply it" : ""}`
          : `${key} already uses the next lower-precedence value`,
        { key, value: configValue(key), removed, restartRequired: needsRestart },
      );
    }
    case "explain": {
      if (!key) return die("usage: livediff config explain <key>", EXIT_USAGE);
      const value = configValue(key);
      const source = configValueSource(key);
      const needsRestart = requiresHubRestart(key);
      return out(
        `${key}\n  value: ${JSON.stringify(value)}\n  source: ${source}\n  ${needsRestart ? "restart required" : "applies without a hub restart"}`,
        { key, value, source, restartRequired: needsRestart },
      );
    }
    default:
      return die(
        `unknown config command: ${action}\n\nRun \`livediff config --help\` to see available commands.`,
        EXIT_USAGE,
      );
  }
}

function resolveHelpCommand(
  tokens: readonly string[],
): { command: CommandHelp; path: readonly string[] } | null {
  const [token, subcommand] = tokens;
  if (!token) return null;
  if (token === "config" && subcommand) {
    const command = findConfigCommand(subcommand);
    return command ? { command, path: ["config", command.name] } : null;
  }
  if (token === "completion" && subcommand) {
    const command = findCompletionCommand(subcommand);
    return command ? { command, path: ["completion", command.name] } : null;
  }
  const cmd = findCommand(token);
  return cmd ? { command: cmd, path: [token] } : null;
}

function helpFor(tokens: readonly string[]): string | null {
  const [token] = tokens;
  if (!token) return renderMainHelp(hubVersion());
  const resolved = resolveHelpCommand(tokens);
  if (resolved === null) return null;
  // Only a resolved nested action renders with its parent prefix; bare `help config` is the
  // top-level command and must not become "config config".
  if (resolved.path.length === 2) {
    return resolved.path[0] === "config"
      ? renderConfigCommandHelp(resolved.command)
      : renderCompletionCommandHelp(resolved.command);
  }
  return renderCommandHelp(resolved.command);
}

async function cmdHelp(tokens: readonly string[] = []): Promise<void> {
  const text = helpFor(tokens);
  const resolved = tokens.length === 0 ? null : resolveHelpCommand(tokens);
  if (text === null) {
    const token = tokens.join(" ");
    const hint = suggest(tokens[0] ?? "");
    await die(
      `unknown command: ${token}${hint ? `\n\nDid you mean \`livediff ${hint}\`?` : ""}\n\nRun \`livediff --help\` to see available commands.`,
      EXIT_USAGE,
    );
  }
  const helpText = text ?? "";
  if (JSON_OUT && tokens.length === 0) {
    console.log(JSON.stringify(describeCli(hubVersion()), null, 2));
    return;
  }
  if (JSON_OUT && resolved) {
    console.log(
      JSON.stringify(
        { ...describeCommand(resolved.command, resolved.path), help: helpText },
        null,
        2,
      ),
    );
    return;
  }
  out(helpText, { help: helpText });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = args;

  if (WANTS_VERSION) return out(hubVersion(), { version: hubVersion() });
  if (WANTS_HELP) return cmdHelp(cmd === undefined ? [] : [cmd, ...rest]);
  await validateInvocation(cmd, rest);

  switch (cmd) {
    case undefined:
      return cmdHubUi();
    case "hub":
      return cmdHubUi();
    case "open":
      return cmdOpen(rest[0]);
    case "review":
      return cmdOpen(rest[0], { wait: true });
    case "link":
      return cmdOpen(rest[0], { open: false });
    case "help":
      return cmdHelp(rest);
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
    case "restart":
      return cmdRestart();
    case "status":
      return cmdStatus();
    case "stop":
      return cmdStop();
    case "doctor":
      return cmdDoctor();
    case "completion":
      return cmdCompletion(rest);
    case "config":
      return cmdConfig(rest);
    case "__complete-workspaces":
      return cmdCompleteWorkspaces();
    case "__complete-comments":
      return cmdCompleteComments(rest[0]);
    default:
      if (await isPathArg(cmd)) return cmdOpen(cmd);
      return cmdHelp([cmd]);
  }
}

try {
  await main();
  await exit(EXIT_OK);
} catch (err) {
  await die(exceptionMessage(err));
}
