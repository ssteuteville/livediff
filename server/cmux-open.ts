/**
 * livediff's `browser.opener`, for people running inside cmux.
 *
 * `cmux browser open` picks its target workspace from the caller's $CMUX_WORKSPACE_ID, which is
 * wrong for livediff twice over: the hub is a daemon that outlives the workspace that spawned it,
 * so its copy goes stale and every diff it opens lands in whatever project happened to start it;
 * and even a live agent's value can name a different workspace than the one its human is reading.
 * Opening a diff is a "show the user something" action, so the selected workspace wins over the
 * inherited id. --focus is passed because cmux defaults it to false and a background tab in the
 * right workspace still looks like nothing happened. See scripts/livediff-cmux-open, which this
 * file replaces (the shell script now just execs the compiled version of this module).
 *
 * The planning logic (`planCmuxOpen`) is pure so tests can exercise workspace-selection precedence
 * without spawning cmux. `main` performs the actual subprocess work and only runs when this file
 * is the program node was asked to run, not merely imported for its exports.
 */

import { execFile, spawn } from "node:child_process";
import { access, constants as fsConstants, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExistsExecutable = (path: string) => Promise<boolean>;

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the `cmux` executable. The hub is a long-lived daemon, often started from a shell whose
 * PATH is thinner than an interactive terminal's, so a manual PATH scan is not redundant with
 * `cmux browser open` failing outright — and it lets setup's prerequisite check reuse the exact
 * same lookup the opener itself uses, rather than trusting `which` (a shell built-in that a
 * daemon's minimal PATH may not even expose consistently across shells).
 */
export async function findCmux(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: ExistsExecutable = defaultExists,
): Promise<string | null> {
  const pathValue = env["PATH"] ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "cmux");
    if (await exists(candidate)) return candidate;
  }
  if (platform !== "darwin") return null;
  const candidates = [
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
    ...(env["HOME"]
      ? [join(env["HOME"], "Applications/cmux.app/Contents/Resources/bin/cmux")]
      : []),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * The subset of `cmux workspace list --json` this helper reads: the first entry with a truthy
 * `selected`. Matching the old shell script exactly, that entry's `ref` wins only if it's a
 * non-empty string — a selected entry with no usable ref falls back to `CMUX_WORKSPACE_ID`
 * rather than the search continuing to a later entry.
 */
function selectedWorkspaceRef(listingJson: string | null): string | null {
  if (listingJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listingJson);
  } catch {
    // An unreadable listing is not worth failing an open over.
    return null;
  }
  if (!isRecord(parsed)) return null;
  const workspaces = parsed["workspaces"];
  if (!Array.isArray(workspaces)) return null;
  for (const entry of workspaces) {
    if (!isRecord(entry)) continue;
    if (entry["selected"]) {
      const ref = entry["ref"];
      return nonEmptyString(ref) ? ref : null;
    }
  }
  return null;
}

/**
 * Build the `cmux browser open` argv: selected workspace wins, then the inherited
 * `CMUX_WORKSPACE_ID` (an empty value there means no workspace either), then no `--workspace`
 * flag at all (cmux's own default targeting). Pure so it is testable without a real `cmux` on
 * PATH.
 */
export function planCmuxOpen(
  listingJson: string | null,
  env: NodeJS.ProcessEnv,
  url: string,
): string[] {
  const selected = selectedWorkspaceRef(listingJson);
  const inherited = env["CMUX_WORKSPACE_ID"];
  const workspace = nonEmptyString(selected)
    ? selected
    : nonEmptyString(inherited)
      ? inherited
      : null;
  const args = ["browser", "open"];
  if (workspace !== null) args.push("--workspace", workspace);
  args.push("--focus", "true", url);
  return args;
}

/** `cmux workspace list --json`, or null on any failure — malformed/missing output falls back. */
async function listWorkspaces(cmux: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmux, ["workspace", "list", "--json"]);
    return stdout;
  } catch {
    return null;
  }
}

function exitCodeForClose(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null) return 1;
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function runCmux(cmux: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmux, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", () => resolve(127));
    child.once("close", (code, signal) => resolve(exitCodeForClose(code, signal)));
  });
}

export interface RunCmuxOpenOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stderr: (message: string) => void;
  /** Injectable seams so this can be unit-tested without a subprocess or a real cmux install. */
  find?: typeof findCmux;
  list?: (cmux: string) => Promise<string | null>;
  run?: (cmux: string, args: readonly string[]) => Promise<number>;
}

/**
 * The whole helper, minus process-global side effects: takes its argv/env/platform as arguments
 * and returns an exit code. `main()` is a thin wrapper so tests can exercise every branch
 * (including "cmux not found") deterministically, without depending on what happens to be
 * installed on the machine running the tests.
 */
export async function runCmuxOpen(options: RunCmuxOpenOptions): Promise<number> {
  const find = options.find ?? findCmux;
  const list = options.list ?? listWorkspaces;
  const run = options.run ?? runCmux;
  const url = options.argv[0];
  if (url === undefined || url === "") {
    options.stderr(`usage: cmux-open.js <url>\n`);
    return 64;
  }
  const cmux = await find(options.env, options.platform);
  if (cmux === null) {
    options.stderr(
      "cmux could not be found on PATH or in /Applications — run `livediff config unset " +
        "browser.opener` or `livediff setup --browser system` to fall back to the OS opener\n",
    );
    return 127;
  }
  const listing = await list(cmux);
  const args = planCmuxOpen(listing, options.env, url);
  return run(cmux, args);
}

async function main(): Promise<void> {
  process.exitCode = await runCmuxOpen({
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
    stderr: (message) => process.stderr.write(message),
  });
}

/**
 * True only when this module is the file node was told to run, not merely imported. Resolving
 * both `import.meta.url` and `process.argv[1]` through `realpath` — rather than comparing them
 * directly, which `server/cli-args.ts` documents as breaking under a symlink — keeps this correct
 * even if a symlink ever sits between `browser.opener`'s stored path and this file.
 */
async function isMainModule(): Promise<boolean> {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    const [self, invoked] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(argv1),
    ]);
    return self === invoked;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  await main();
}
