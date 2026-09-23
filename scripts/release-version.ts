/**
 * Single source of truth for "what version is this release": writes (or checks) the same version
 * string into every place that declares one — package.json, both native plugin manifests,
 * release.json, and any portable-skill frontmatter that carries `metadata.version`. Nothing else
 * in the repo should hardcode a release version — `check-package` and `release` both call
 * `checkVersions()` in `--check` mode to catch drift before it reaches a tarball.
 *
 * Add a new version-bearing file by adding one entry to `TARGETS` below — nowhere else.
 *
 * Usage:
 *   node dist-server/scripts/release-version.js <version>   # write
 *   node dist-server/scripts/release-version.js --check     # verify agreement, no writes
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export interface VersionTarget {
  path: string;
  getVersion: (text: string) => string;
  setVersion: (text: string, version: string) => string;
}

export function jsonTarget(
  relPath: string,
  onWrite?: (json: Record<string, unknown>, version: string) => void,
  root: string = projectRoot,
): VersionTarget {
  const path = join(root, relPath);
  return {
    path,
    getVersion: (text) => {
      const json = parseJsonObject(text, relPath);
      const version = json["version"];
      if (typeof version !== "string") throw new Error(`${relPath}: missing string "version"`);
      return version;
    },
    setVersion: (text, version) => {
      const json = parseJsonObject(text, relPath);
      json["version"] = version;
      onWrite?.(json, version);
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, relPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${relPath}: expected a JSON object`);
  }
  return parsed;
}

/** Matches a `version: "x.y.z"` (or unquoted) line inside a YAML frontmatter block. */
const FRONTMATTER_VERSION_LINE = /^(\s*)version:\s*"?([^"\n]*?)"?\s*$/m;

function frontmatterBlock(
  text: string,
  relPath: string,
): { block: string; start: number; end: number } {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match || match.index !== 0) throw new Error(`${relPath}: no YAML frontmatter block found`);
  const block = match[1] ?? "";
  return { block, start: 0, end: match[0].length };
}

/**
 * Targets a `version:` line nested under a `metadata:` key in a Markdown file's YAML frontmatter
 * (the shape SKILL.md uses: `metadata: { version: "x.y.z" }` or block form). Deliberately does
 * not parse YAML — a narrow line match keeps this dependency-free and fails loudly, rather than
 * silently, when the shape it expects isn't there.
 */
export function frontmatterTarget(relPath: string, root: string = projectRoot): VersionTarget {
  const path = join(root, relPath);
  return {
    path,
    getVersion: (text) => {
      const { block } = frontmatterBlock(text, relPath);
      const match = FRONTMATTER_VERSION_LINE.exec(block);
      if (!match)
        throw new Error(`${relPath}: no "version:" line found under frontmatter metadata`);
      return (match[2] ?? "").trim();
    },
    setVersion: (text, version) => {
      const { block, start, end } = frontmatterBlock(text, relPath);
      const match = FRONTMATTER_VERSION_LINE.exec(block);
      if (!match)
        throw new Error(`${relPath}: no "version:" line found under frontmatter metadata`);
      const indent = match[1] ?? "";
      const newBlock = block.replace(FRONTMATTER_VERSION_LINE, `${indent}version: "${version}"`);
      const updated = `---\n${newBlock}\n---`;
      return text.slice(start, start) + updated + text.slice(end);
    },
  };
}

/** Builds the real project's target list. Exported so tests can build an equivalent list rooted
 * at a temp fixture directory instead of touching the actual repo files. */
export function defaultTargets(root: string = projectRoot): VersionTarget[] {
  return [
    jsonTarget("package.json", undefined, root),
    jsonTarget("plugins/livediff/.claude-plugin/plugin.json", undefined, root),
    jsonTarget("plugins/livediff/.codex-plugin/plugin.json", undefined, root),
    jsonTarget(
      "release.json",
      (json, version) => {
        json["cliRange"] = `>=${version}`;
      },
      root,
    ),
    // The portable livediff skill: not in the npm `files` allowlist (the pinned skills installer
    // fetches it straight from git), but its frontmatter still carries `metadata.version`, and
    // `release --promote` separately confirms this file exists at the tag before pushing `stable`.
    frontmatterTarget("skills/livediff/SKILL.md", root),
  ];
}

async function readTarget(
  target: VersionTarget,
): Promise<{ target: VersionTarget; text: string; version: string }> {
  const text = await readFile(target.path, "utf8");
  return { target, text, version: target.getVersion(text) };
}

export interface CheckResult {
  ok: boolean;
  versions: { path: string; version: unknown }[];
}

/** Reads every target's declared version without writing anything. */
export async function checkVersions(
  targets: VersionTarget[] = defaultTargets(),
): Promise<CheckResult> {
  const versions: { path: string; version: unknown }[] = [];
  for (const target of targets) {
    const { version } = await readTarget(target);
    versions.push({ path: target.path, version });
  }
  const distinct = new Set(versions.map((v) => v.version));
  return { ok: distinct.size === 1 && typeof versions[0]?.version === "string", versions };
}

/** Writes `version` into every target. Reads and validates all of them before writing any. */
export async function writeVersion(
  version: string,
  targets: VersionTarget[] = defaultTargets(),
): Promise<void> {
  if (!SEMVER.test(version)) {
    throw new Error(`not a valid semantic version: ${version}`);
  }
  const loaded = await Promise.all(targets.map(readTarget));
  const written = loaded.map(({ target, text }) => ({
    path: target.path,
    text: target.setVersion(text, version),
  }));
  for (const file of written) await writeFile(file.path, file.text, "utf8");
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--check") {
    const result = await checkVersions();
    for (const { path, version } of result.versions) console.log(`${path}: ${String(version)}`);
    if (!result.ok) {
      console.error("version mismatch across release metadata");
      process.exitCode = 1;
    }
    return;
  }
  if (!arg || !SEMVER.test(arg)) {
    console.error("usage: release-version <x.y.z> | release-version --check");
    process.exitCode = 2;
    return;
  }
  const targets = defaultTargets();
  await writeVersion(arg, targets);
  console.log(`wrote version ${arg} to ${targets.length} release metadata file(s)`);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
