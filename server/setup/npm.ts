import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ERROR } from "../constants.js";
import {
  findExecutable,
  findExecutables,
  isExecutableFile,
  isWithin,
  realpathOrNull,
  userPath,
} from "../executable-path.js";
import { SETUP_CONTINUATION_ENV } from "./lock.js";
import type { ComponentOutcome, PersistentCli, RunResult, SetupContext } from "./types.js";

/** A tarball path or other npm spec to install instead of the registry release, for pre-publication testing. */
export const SETUP_PACKAGE_ENV = "LIVEDIFF_SETUP_PACKAGE";

const EACCES_HELP =
  "https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally";
const NPX_CACHE_PACKAGE = /[\\/]_npx[\\/][0-9a-f]+[\\/]node_modules[\\/]/i;
const VERSION_TIMEOUT_MS = 30_000;

/** The package that is executing this code, read from its own package.json. */
export interface PackageIdentity {
  name: string;
  version: string;
  /** Real path of the package directory. */
  root: string;
  /** The `engines.node` range, when declared. */
  enginesNode: string | null;
  /** The executable npm links for it. */
  binName: string;
}

/**
 * How setup was started. `global` is npm's own global install; `npx` is npm exec's temporary
 * cache; `local` is anything else — a project dependency, a source checkout, another package
 * manager's global. Only `global` counts as the persistent CLI.
 */
export type Invocation = "global" | "npx" | "local";

export interface PersistentCliOptions {
  update: boolean;
  /** This process is the freshly installed CLI a `--update` parent handed the run to. */
  continuation: boolean;
}

export interface PersistentCliResult {
  outcome: ComponentOutcome;
  persistent: PersistentCli | null;
  /**
   * `--update` installed a different version than the one executing, so the rest of the run
   * belongs to the new CLI (see `handOffSetup`).
   */
  handoff: boolean;
}

/** Walk up from this module to the package.json that owns it. Never hardcodes the package name. */
export async function readPackageIdentity(
  from = fileURLToPath(import.meta.url),
): Promise<PackageIdentity> {
  let dir = dirname(from);
  for (;;) {
    const found = await readPackageJson(join(dir, "package.json"));
    if (found !== null) {
      const root = (await realpathOrNull(dir)) ?? dir;
      return { ...found, root };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json with a name and version above ${from}`);
    dir = parent;
  }
}

async function readPackageJson(path: string): Promise<Omit<PackageIdentity, "root"> | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { name, version, engines, bin } = raw;
  if (typeof name !== "string" || typeof version !== "string") return null;
  const enginesNode =
    isRecord(engines) && typeof engines["node"] === "string" ? engines["node"] : null;
  return { name, version, enginesNode, binName: binNameOf(name, bin) };
}

function binNameOf(name: string, bin: unknown): string {
  const unscoped = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  if (!isRecord(bin)) return unscoped;
  const keys = Object.keys(bin);
  if (keys.includes("livediff")) return "livediff";
  return keys[0] ?? unscoped;
}

/** Whether a package root lives in npm exec's temporary `_npx` cache. */
export function isNpxCachePath(path: string): boolean {
  return NPX_CACHE_PACKAGE.test(path);
}

/** The command that reruns setup the same way the user started it. */
export function setupRetryCommand(self: PackageIdentity, invocation?: Invocation): string {
  const temporary = invocation === undefined ? isNpxCachePath(self.root) : invocation !== "global";
  return temporary ? `npx ${self.name}@latest setup` : "livediff setup";
}

interface NpmGlobal {
  prefix: string;
  root: string;
  binDir: string;
}

type Failure = { ok: false; detail: string };

/**
 * Install or reuse the persistent npm CLI, then prove the user's own shell runs it — resolved
 * on the PATH they had before npx prepended its temporary directories.
 */
export async function ensurePersistentCli(
  ctx: SetupContext,
  options: PersistentCliOptions,
  self?: PackageIdentity,
): Promise<PersistentCliResult> {
  const identity = self ?? (await readPackageIdentity());
  const env = { ...ctx.env, PATH: userPath(ctx.env) };
  const fail = (detail: string, invocation?: Invocation): PersistentCliResult => ({
    outcome: {
      id: "cli",
      label: "LiveDiff CLI",
      status: "failed",
      detail,
      retry: setupRetryCommand(identity, invocation),
      required: true,
    },
    persistent: null,
    handoff: false,
  });

  ctx.progress.step("Checking npm's global installation…");
  const npm = await npmGlobal(ctx, env);
  if (!npm.ok) return fail(npm.detail);
  const packageDir = join(npm.root, identity.name);
  const invocation = await classify(identity, packageDir);

  if (options.continuation) {
    const verified = await verify(ctx, env, npm, identity, identity.version);
    if (!verified.ok) return fail(verified.detail, invocation);
    return succeed(verified.persistent, "updated", false);
  }

  let target = identity.version;
  let changed = false;
  const override = ctx.env[SETUP_PACKAGE_ENV];
  const hasOverride = override !== undefined && override !== "";
  const before = await readInstalled(packageDir);

  if (options.update) {
    if (!hasOverride) {
      ctx.progress.step(`Checking the latest ${identity.name} release…`);
      const latest = await latestVersion(ctx, env, identity.name);
      if (!latest.ok) return fail(latest.detail, invocation);
      target = latest.version;
    }
    if (hasOverride || !matches(before, identity.name, target)) {
      const spec = hasOverride ? override : `${identity.name}@${target}`;
      const installed = await install(ctx, env, npm, spec, identity.name);
      if (!installed.ok) return fail(installed.detail, invocation);
      target = installed.version;
      changed = before?.version !== installed.version;
    }
  } else if (invocation !== "global" && !matches(before, identity.name, target)) {
    const spec = hasOverride ? override : `${identity.name}@${target}`;
    const installed = await install(ctx, env, npm, spec, identity.name);
    if (!installed.ok) return fail(installed.detail, invocation);
    if (installed.version !== target) {
      return fail(
        `${spec} installed ${identity.name} ${installed.version}, but this setup is ${target}. ` +
          "Setup installs exactly the version that is running.",
        invocation,
      );
    }
    changed = true;
  }

  const verified = await verify(ctx, env, npm, identity, target);
  if (!verified.ok) return fail(verified.detail, invocation);
  const status = statusFor(options.update, changed, before);
  if (changed && before !== null && before.version !== target) {
    ctx.progress.ok(`LiveDiff CLI ${before.version} → ${target}`);
  }
  return succeed(verified.persistent, status, options.update && target !== identity.version);
}

function statusFor(
  update: boolean,
  changed: boolean,
  before: InstalledPackage | null,
): ComponentOutcome["status"] {
  if (!changed) return "unchanged";
  if (update && before !== null) return "updated";
  return "installed";
}

function succeed(
  persistent: PersistentCli,
  status: ComponentOutcome["status"],
  handoff: boolean,
): PersistentCliResult {
  return {
    outcome: {
      id: "cli",
      label: "LiveDiff CLI",
      status,
      version: persistent.version,
      detail: persistent.bin,
    },
    persistent,
    handoff,
  };
}

/**
 * Run the rest of a `--update` in the newly installed CLI, so its adapters match the release
 * that was just installed. The child adopts this process's setup lock through the continuation
 * token and gets the choices already made as explicit flags, so it neither asks again nor
 * updates again. Returns the child's exit code.
 */
export async function handOffSetup(
  ctx: SetupContext,
  persistent: PersistentCli,
  args: readonly string[],
  token: string,
): Promise<number> {
  ctx.progress.step(`Continuing setup with LiveDiff ${persistent.version}…`);
  const env = { ...ctx.env, PATH: userPath(ctx.env), [SETUP_CONTINUATION_ENV]: token };
  const result = await ctx.run(persistent.node, [persistent.bin, "setup", ...args], {
    env,
    inherit: true,
  });
  if (result.code === -1) {
    ctx.progress.fail(`could not start ${persistent.bin}: ${lastLine(result.stderr)}`);
    return EXIT_ERROR;
  }
  return result.code;
}

async function classify(self: PackageIdentity, packageDir: string): Promise<Invocation> {
  const globalReal = await realpathOrNull(packageDir);
  if (globalReal !== null && globalReal === self.root) return "global";
  return isNpxCachePath(self.root) ? "npx" : "local";
}

async function npmGlobal(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
): Promise<({ ok: true } & NpmGlobal) | Failure> {
  const prefix = await ctx.run("npm", ["prefix", "--global"], { env });
  if (prefix.code === -1) {
    return {
      ok: false,
      detail: "npm was not found on PATH. Install Node.js with npm, then retry.",
    };
  }
  const prefixPath = prefix.stdout.trim();
  if (prefix.code !== 0 || prefixPath === "") {
    return { ok: false, detail: `npm prefix --global failed: ${lastLine(prefix.stderr)}` };
  }
  const root = await ctx.run("npm", ["root", "--global"], { env });
  const rootPath = root.stdout.trim();
  if (root.code !== 0 || rootPath === "") {
    return { ok: false, detail: `npm root --global failed: ${lastLine(root.stderr)}` };
  }
  return { ok: true, prefix: prefixPath, root: rootPath, binDir: join(prefixPath, "bin") };
}

async function latestVersion(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
  name: string,
): Promise<{ ok: true; version: string } | Failure> {
  const result = await ctx.run("npm", ["view", `${name}@latest`, "version"], { env });
  const version = result.stdout.trim();
  if (result.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
    return {
      ok: false,
      detail: `could not look up the latest ${name} release: ${lastLine(result.stderr)}`,
    };
  }
  return { ok: true, version };
}

async function install(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
  npm: NpmGlobal,
  spec: string,
  name: string,
): Promise<{ ok: true; version: string } | Failure> {
  ctx.progress.step(`Installing ${spec} with npm…`);
  const result = await ctx.run("npm", ["install", "--global", "--no-fund", "--no-audit", spec], {
    env,
  });
  if (result.code !== 0) return { ok: false, detail: installFailure(result, npm, spec) };
  const installed = await readInstalled(join(npm.root, name));
  if (installed === null || installed.name !== name) {
    return {
      ok: false,
      detail: `npm install --global ${spec} succeeded, but ${name} is not in ${npm.root}`,
    };
  }
  return { ok: true, version: installed.version };
}

function installFailure(result: RunResult, npm: NpmGlobal, spec: string): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/\bEACCES\b|\bEPERM\b/.test(output)) {
    return (
      `npm could not write to its global directory ${npm.prefix} (permission denied). ` +
      `Fix npm's permissions (${EACCES_HELP}) or use a Node version manager such as nvm or ` +
      "fnm, then retry. Setup never uses sudo or changes npm's prefix."
    );
  }
  return `npm install --global ${spec} failed: ${npmErrorSummary(output)}`;
}

/** npm ends every failure with a pointer to its log file; the cause is in the first error lines. */
function npmErrorSummary(output: string): string {
  const errors = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^npm (error|ERR!)/.test(line) && !/complete log of this run/i.test(line))
    .map((line) => line.replace(/^npm (error|ERR!)\s*/, ""))
    .filter((line) => line !== "");
  return errors.length === 0 ? lastLine(output) : errors.slice(0, 2).join("; ");
}

interface InstalledPackage {
  name: string;
  version: string;
}

async function readInstalled(packageDir: string): Promise<InstalledPackage | null> {
  const found = await readPackageJson(join(packageDir, "package.json"));
  return found === null ? null : { name: found.name, version: found.version };
}

function matches(installed: InstalledPackage | null, name: string, version: string): boolean {
  return installed !== null && installed.name === name && installed.version === version;
}

/**
 * The checks a successful `npx` run does not prove: npm's copy is the expected package and
 * version, `livediff` on the user's PATH resolves into it (not into npx's cache, a pnpm global,
 * or an old link), and running it reports the expected version.
 */
async function verify(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
  npm: NpmGlobal,
  self: PackageIdentity,
  version: string,
): Promise<{ ok: true; persistent: PersistentCli } | Failure> {
  ctx.progress.step("Verifying the livediff command on your PATH…");
  const packageDir = join(npm.root, self.name);
  const installed = await readInstalled(packageDir);
  if (!matches(installed, self.name, version)) {
    const found = installed === null ? "nothing" : `${installed.name} ${installed.version}`;
    return { ok: false, detail: `npm's global ${packageDir} holds ${found}, not ${version}` };
  }
  const packageReal = (await realpathOrNull(packageDir)) ?? packageDir;
  const expectedBin = join(npm.binDir, self.binName);
  const path = env["PATH"] ?? "";

  const [first] = await findExecutables(self.binName, path);
  if (first === undefined) {
    if (!(await isExecutableFile(expectedBin))) {
      return { ok: false, detail: `npm installed ${self.name} but did not link ${expectedBin}` };
    }
    return { ok: false, detail: notOnPath(npm.binDir, ctx.env) };
  }
  const firstReal = (await realpathOrNull(first)) ?? first;
  if (!isWithin(firstReal, packageReal)) {
    return { ok: false, detail: shadowed(self.binName, first, firstReal, expectedBin, npm.binDir) };
  }

  const reported = await ctx.run(first, ["--version"], { env, timeoutMs: VERSION_TIMEOUT_MS });
  const printed = reported.stdout.trim();
  if (reported.code !== 0 || printed !== version) {
    return {
      ok: false,
      detail: `${first} --version printed '${printed || lastLine(reported.stderr)}', expected ${version}`,
    };
  }

  const bin = (await isExecutableFile(expectedBin)) ? expectedBin : first;
  return {
    ok: true,
    persistent: {
      packageName: self.name,
      version,
      bin,
      packageRoot: packageDir,
      node: await persistentNode(npm.prefix, path),
    },
  };
}

/**
 * The Node that will run the installed bin. npm's global prefix is the Node installation prefix
 * for nvm, fnm, Homebrew, and system installs, so `<prefix>/bin/node` is the executable the
 * bin's `#!/usr/bin/env node` finds — and, unlike the PATH entry a shell sees, it survives: fnm
 * puts a per-shell temporary symlink directory on PATH, and Homebrew's Cellar path changes on
 * every upgrade while its `bin/node` link does not. Otherwise, the real path of the `node` on
 * the user's PATH; this process's own executable only as a last resort (it is the same user
 * Node under npx, never something inside npx's cache).
 */
async function persistentNode(prefix: string, path: string): Promise<string> {
  const beside = join(prefix, "bin", "node");
  if (await isExecutableFile(beside)) return beside;
  const onPath = await findExecutable("node", path);
  if (onPath !== null) return (await realpathOrNull(onPath)) ?? onPath;
  return process.execPath;
}

function notOnPath(binDir: string, env: NodeJS.ProcessEnv): string {
  const shell = basename(env["SHELL"] ?? "");
  const line =
    shell === "fish"
      ? `fish_add_path '${binDir}'`
      : `export PATH="${binDir}:$PATH"  (in ~/.${shell === "bash" ? "bashrc" : "zshrc"})`;
  return (
    `npm's global bin directory ${binDir} is not on your PATH, so \`livediff\` is not ` +
    `available in a new terminal. Add it — ${line} — open a new terminal, and retry.`
  );
}

function shadowed(
  binName: string,
  first: string,
  firstReal: string,
  expectedBin: string,
  binDir: string,
): string {
  const target = firstReal === first ? first : `${first} → ${firstReal}`;
  const hint = /[\\/]pnpm[\\/]/i.test(firstReal)
    ? ` It looks like a pnpm global install (\`pnpm remove --global ${binName}\` removes it).`
    : "";
  return (
    `\`${binName}\` in your shell runs ${target}, not npm's ${expectedBin}.${hint} Remove the ` +
    `other installation or put ${binDir} earlier on PATH, then retry; setup does not ` +
    "uninstall anything."
  );
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "no output";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
