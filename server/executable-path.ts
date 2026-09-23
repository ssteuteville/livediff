import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * PATH inspection without a shell. Setup uses it to answer "what does `livediff` mean in the
 * user's own terminal", which is not what it means inside `npx`: npm exec prepends its temporary
 * package cache and every ancestor's `node_modules/.bin` to PATH for the duration of the command.
 */

const NPX_CACHE_BIN = /[\\/]_npx[\\/][0-9a-f]+[\\/]node_modules[\\/]\.bin[\\/]?$/i;
const NODE_GYP_BIN = /[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin[\\/]?$/;

/** Whether this process is running inside an `npm exec`/`npx`/`npm run` environment. */
export function inNpmExecContext(env: NodeJS.ProcessEnv): boolean {
  return env["npm_command"] !== undefined || env["npm_lifecycle_event"] !== undefined;
}

/**
 * The PATH the user's shell would have had, with only the entries npm exec is known to prepend
 * removed: its `_npx/<hash>/node_modules/.bin`, the `node_modules/.bin` of the invocation
 * directory and each ancestor, and run-script's `node-gyp-bin`. They form one leading block that
 * ends at `node-gyp-bin`; nothing after it is touched, so a project `.bin` the user put on PATH
 * themselves survives.
 */
export function userPath(env: NodeJS.ProcessEnv): string {
  const entries = (env["PATH"] ?? "").split(delimiter);
  const ancestors = npmAncestorBins(env);
  let start = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (NODE_GYP_BIN.test(entry) && inNpmExecContext(env)) {
      start = i + 1;
      break;
    }
    if (!NPX_CACHE_BIN.test(entry) && !ancestors.has(stripTrailingSep(entry))) break;
    start = i + 1;
  }
  return entries.slice(start).join(delimiter);
}

function npmAncestorBins(env: NodeJS.ProcessEnv): Set<string> {
  const bins = new Set<string>();
  const base = env["npm_config_local_prefix"] ?? env["INIT_CWD"];
  if (!inNpmExecContext(env) || base === undefined || !isAbsolute(base)) return bins;
  let dir = resolve(base);
  for (;;) {
    bins.add(join(dir, "node_modules", ".bin"));
    const parent = dirname(dir);
    if (parent === dir) return bins;
    dir = parent;
  }
}

function stripTrailingSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** Every executable named `name` on `pathValue`, in resolution order. Relative entries are ignored. */
export async function findExecutables(name: string, pathValue: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutableFile(candidate)) found.push(candidate);
  }
  return found;
}

/** The executable a shell would run for `name`, or null. */
export async function findExecutable(name: string, pathValue: string): Promise<string | null> {
  const [first] = await findExecutables(name, pathValue);
  return first ?? null;
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `realpath`, or null when the path does not exist. */
export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Whether `child` is `parent` or lies beneath it. Both should already be real paths. */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
