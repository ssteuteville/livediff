/**
 * Inspects a packed npm tarball (or, with no argument, packs one from the current tree) and
 * asserts the properties that matter for a clean consumer install: required runtime files are
 * present, developer-only files are absent, no consumer lifecycle script can run, the bin target
 * is executable, and every place a version string is declared agrees.
 *
 * Run via `pnpm package:check [tarball]`. Exits non-zero with a readable problem list.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./release-version.js";

const exec = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

/** Files that must ship for the CLI/hub to run without the source tree. */
const REQUIRED_PATTERNS = [
  /^package\/dist-server\/server\/cli\.js$/,
  /^package\/dist-server\/server\/index\.js$/,
  /^package\/dist\/index\.html$/,
  /^package\/schemas\/config-v1\.json$/,
  /^package\/package\.json$/,
];

/** Developer-only files that must never ship in the published tarball. */
const FORBIDDEN_PATTERNS = [
  /^package\/dist-server\/scripts\//,
  /\.tsbuildinfo$/,
  /^package\/test\//,
  /^package\/e2e\//,
  /^package\/bench\//,
  /^package\/\.github\//,
];

/** Lifecycle scripts npm would run on a consumer's plain `npm install`/`npm install -g`. */
const CONSUMER_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

interface PackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
}

interface Problem {
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePackageJson(raw: string, source: string): PackageJson {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error(`${source}: expected a JSON object`);

  const result: PackageJson = {};
  if (typeof parsed["name"] === "string") result.name = parsed["name"];
  if (typeof parsed["version"] === "string") result.version = parsed["version"];

  const bin = parsed["bin"];
  if (typeof bin === "string") {
    result.bin = bin;
  } else if (isRecord(bin)) {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(bin))
      if (typeof value === "string") entries[key] = value;
    result.bin = entries;
  }

  const scripts = parsed["scripts"];
  if (isRecord(scripts)) {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(scripts))
      if (typeof value === "string") entries[key] = value;
    result.scripts = entries;
  }

  return result;
}

async function packDryRunJson(
  cwd: string,
): Promise<{ filename: string; files: { path: string }[] }> {
  // --ignore-scripts: this inspects the already-built tree; it must not trigger a rebuild via
  // `prepack`, and `pnpm build`'s own stdout would otherwise corrupt the JSON we parse here.
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack --dry-run --json returned no entries");
  }
  const entry = parsed[0];
  if (!isRecord(entry)) throw new Error("unexpected npm pack output");
  const filename = entry["filename"];
  const files = entry["files"];
  if (typeof filename !== "string" || !Array.isArray(files)) {
    throw new Error("unexpected npm pack --dry-run --json shape");
  }
  const paths = files.map((f) => {
    if (!isRecord(f)) throw new Error("unexpected file entry in npm pack output");
    const path = f["path"];
    if (typeof path !== "string") throw new Error("unexpected file entry path in npm pack output");
    return { path: `package/${path}` };
  });
  return { filename, files: paths };
}

async function tarballContents(tarballPath: string): Promise<string[]> {
  const { stdout } = await exec("tar", ["-tzf", tarballPath], { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

async function extractPackageJsonFromTarball(tarballPath: string): Promise<PackageJson> {
  const { stdout } = await exec("tar", ["-xzOf", tarballPath, "package/package.json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePackageJson(stdout, `${tarballPath}:package/package.json`);
}

async function checkBinShebang(tarballPath: string, binPath: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const entry = `package/${binPath}`;
  try {
    const { stdout } = await exec("tar", ["-xzOf", tarballPath, entry], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!stdout.startsWith("#!")) {
      problems.push({ message: `bin target ${binPath} has no shebang line` });
    }
  } catch {
    problems.push({ message: `bin target ${binPath} could not be read from the tarball` });
  }
  return problems;
}

export interface CheckPackageOptions {
  /** Path to an existing tarball. When omitted, contents come from `npm pack --dry-run --json`. */
  tarballPath?: string;
  projectRoot?: string;
}

export interface CheckPackageResult {
  problems: string[];
  packageJson: PackageJson;
}

/**
 * Runs every check against either a real tarball on disk or (when omitted) a dry-run pack of
 * `projectRoot`. Exported so a focused test can build a tiny fake tarball and assert rejections
 * without shelling out to a real `npm pack`.
 */
export async function checkPackage(options: CheckPackageOptions = {}): Promise<CheckPackageResult> {
  const root = options.projectRoot ?? projectRoot;
  const problems: string[] = [];

  let entries: string[];
  let packageJson: PackageJson;
  if (options.tarballPath) {
    entries = await tarballContents(options.tarballPath);
    packageJson = await extractPackageJsonFromTarball(options.tarballPath);
  } else {
    const dryRun = await packDryRunJson(root);
    entries = dryRun.files.map((f) => f.path);
    const packageJsonPath = join(root, "package.json");
    packageJson = parsePackageJson(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  }

  for (const pattern of REQUIRED_PATTERNS) {
    if (!entries.some((entry) => pattern.test(entry))) {
      problems.push(`missing required file matching ${pattern}`);
    }
  }

  for (const entry of entries) {
    if (matchesAny(entry, FORBIDDEN_PATTERNS)) {
      problems.push(`forbidden developer file present: ${entry}`);
    }
  }

  const scripts = packageJson.scripts ?? {};
  for (const name of CONSUMER_LIFECYCLE_SCRIPTS) {
    if (scripts[name]) {
      problems.push(`consumer lifecycle script "${name}" must not be defined: ${scripts[name]}`);
    }
  }

  const bin = packageJson.bin;
  const binPaths = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  if (binPaths.length === 0) {
    problems.push("package.json declares no bin entry");
  } else if (options.tarballPath) {
    for (const binPath of binPaths) {
      const binProblems = await checkBinShebang(options.tarballPath, binPath);
      problems.push(...binProblems.map((p) => p.message));
    }
  }

  // Delegates to release-version's --check logic: package.json, both plugin manifests, and
  // release.json must all declare the same version. That module is the single source of truth
  // for what "the release version" means; duplicating the comparison here would let them drift.
  try {
    const versionCheck = await checkVersions();
    if (!versionCheck.ok) {
      const detail = versionCheck.versions.map((v) => `${v.path}=${String(v.version)}`).join(", ");
      problems.push(`release version metadata disagrees: ${detail}`);
    }
  } catch (error) {
    problems.push(
      `release version check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { problems, packageJson };
}

async function main() {
  const tarballArg = process.argv[2];
  const result = await checkPackage(tarballArg ? { tarballPath: tarballArg } : {});
  if (result.problems.length === 0) {
    console.log(`package check passed (version ${result.packageJson.version ?? "unknown"})`);
    return;
  }
  console.error(`package check failed with ${result.problems.length} problem(s):`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
