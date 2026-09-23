/**
 * The one script that assembles, validates, publishes, and promotes a release, run identically
 * from a maintainer's shell and from `.github/workflows/release.yml`. Each phase is behind its
 * own explicit flag — nothing is implied — because the boundary between "I built a tarball" and
 * "the world can now `npm install livediff`" is exactly the boundary this script exists to guard.
 *
 * Phases:
 *   (default) / --dry-run       build, pack once into release/, check + smoke that tarball
 *   --publish <tarball>         publish that exact file (never rebuilds); requires confirmation
 *   --verify-registry <version> compare the registry's published integrity to the local tarball
 *   --promote <version>         push the release tag to the `stable` branch, fast-forward only
 *
 * `release/` is gitignored; it holds the immutable tarball plus a sidecar recording its sha512
 * integrity, so `--publish` can prove it is publishing the exact bytes `--dry-run` validated.
 */

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkVersions } from "./release-version.js";
import { checkPackage } from "./check-package.js";

const exec = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
const releaseDir = join(projectRoot, "release");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sidecarPath(tarballPath: string): string {
  return `${tarballPath}.sha512`;
}

async function sha512Integrity(path: string): Promise<string> {
  const data = await readFile(path);
  const hash = createHash("sha512").update(data).digest("base64");
  return `sha512-${hash}`;
}

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function assertCleanTree(): Promise<void> {
  const status = await git(["status", "--porcelain"]);
  if (status.length > 0) {
    throw new Error("working tree is not clean — commit or stash before releasing:\n" + status);
  }
}

/** A commit is "tagged-or-taggable": either already wearing v<version> at HEAD, or wearing none. */
async function assertTaggableOrTagged(version: string): Promise<void> {
  const tag = `v${version}`;
  let tagCommit: string | null = null;
  try {
    tagCommit = await git(["rev-list", "-n", "1", tag]);
  } catch {
    tagCommit = null;
  }
  if (tagCommit === null) return;
  const head = await git(["rev-parse", "HEAD"]);
  if (tagCommit !== head) {
    throw new Error(`tag ${tag} already exists but points at ${tagCommit}, not HEAD (${head})`);
  }
}

/** Redacts the value following `--otp` so a failure message never echoes the one-time password. */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, i) => (args[i - 1] === "--otp" ? "***" : arg));
}

async function runInherited(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${redactArgs(args).join(" ")} exited with code ${code}`));
    });
  });
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

// ─── --dry-run (default) ───────────────────────────────────────────────────

async function dryRun(): Promise<void> {
  const versions = await checkVersions();
  if (!versions.ok) {
    throw new Error(
      "release metadata disagrees on version; run `pnpm release:version --check` for detail",
    );
  }
  const version = String(versions.versions[0]?.version);
  console.log(`releasing version ${version}`);

  await assertCleanTree();
  await assertTaggableOrTagged(version);

  console.log("building…");
  await runInherited("pnpm", ["build"]);

  await mkdir(releaseDir, { recursive: true });
  console.log("packing (once)…");
  // --ignore-scripts: the build above is the one and only build; prepack must not run a second.
  const { stdout: packOut } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", releaseDir],
    { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const packed: unknown = JSON.parse(packOut);
  if (!Array.isArray(packed) || packed.length === 0) throw new Error("npm pack produced no output");
  const first = packed[0];
  if (!isRecord(first)) throw new Error("unexpected npm pack output");
  const filename = first["filename"];
  if (typeof filename !== "string") throw new Error("unexpected npm pack output: missing filename");
  const tarballPath = join(releaseDir, filename);

  console.log("checking package contents…");
  const check = await checkPackage({ tarballPath, projectRoot });
  if (check.problems.length > 0) {
    throw new Error(`check-package failed:\n${check.problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  console.log("smoke testing the packed tarball…");
  await runInherited("node", [join(__dirname, "smoke-package.js"), tarballPath]);

  const integrity = await sha512Integrity(tarballPath);
  await writeFile(sidecarPath(tarballPath), `${integrity}\n`, "utf8");

  console.log("");
  console.log(`tarball: ${tarballPath}`);
  console.log(`sha512 integrity: ${integrity}`);
  console.log("");
  console.log("next steps:");
  console.log(`  git tag v${version} && git push origin v${version}`);
  console.log(`  pnpm release -- --publish ${tarballPath}`);
  console.log(`  pnpm release -- --verify-registry ${version}`);
  console.log(`  pnpm release -- --promote ${version}`);
}

// ─── --publish <tarball> ───────────────────────────────────────────────────

/**
 * npm refuses to publish a prerelease without an explicit dist-tag, and a prerelease must never
 * become `latest` by default. Stable versions publish under npm's default tag.
 */
export function distTagFor(version: string): string | null {
  return version.includes("-") ? "next" : null;
}

async function projectVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  if (isRecord(parsed) && typeof parsed["version"] === "string") return parsed["version"];
  throw new Error("package.json has no version");
}

interface PublishOptions {
  tarballPath: string;
  yes: boolean;
  otp?: string | undefined;
}

async function publish(options: PublishOptions): Promise<void> {
  const sidecar = sidecarPath(options.tarballPath);
  const recorded = (await readFile(sidecar, "utf8")).trim();
  const actual = await sha512Integrity(options.tarballPath);
  if (recorded !== actual) {
    throw new Error(
      `integrity mismatch for ${options.tarballPath}: recorded ${recorded}, actual ${actual}. ` +
        "The file changed since --dry-run built it; re-run --dry-run rather than publishing this file.",
    );
  }
  console.log(`verified integrity: ${actual}`);

  if (!options.yes) {
    const ok = await confirm(`Publish ${options.tarballPath} to npm as livediff?`);
    if (!ok) {
      console.log("aborted.");
      return;
    }
  }

  const inCi =
    process.env["GITHUB_ACTIONS"] === "true" &&
    Boolean(process.env["ACTIONS_ID_TOKEN_REQUEST_URL"]);
  const args = ["publish", options.tarballPath];
  const tag = distTagFor(await projectVersion());
  if (tag !== null) args.push("--tag", tag);
  if (inCi) args.push("--provenance");
  if (options.otp) args.push("--otp", options.otp);

  // Inherited stdio: npm prompts for a one-time password on stdin/stdout when the account
  // requires it (auth-and-writes 2FA). Never capture or log that exchange.
  await runInherited("npm", args, { ...process.env, LIVEDIFF_RELEASE: "1" });
  console.log("published.");
}

// ─── --verify-registry <version> ───────────────────────────────────────────

async function findTarballForVersion(version: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const name = isRecord(parsed) && typeof parsed["name"] === "string" ? parsed["name"] : "livediff";
  return join(releaseDir, `${name}-${version}.tgz`);
}

async function verifyRegistry(version: string): Promise<void> {
  const tarballPath = await findTarballForVersion(version);
  const local = await sha512Integrity(tarballPath);
  const { stdout } = await exec("npm", ["view", `livediff@${version}`, "dist.integrity"], {
    maxBuffer: 1024 * 1024,
  });
  const registry = stdout.trim();
  if (registry !== local) {
    throw new Error(
      `registry integrity ${registry} does not match local tarball integrity ${local}`,
    );
  }
  console.log(`registry integrity for livediff@${version} matches the local tarball: ${local}`);
}

// ─── --promote <version> ───────────────────────────────────────────────────

const CATALOGS: { path: string; extractPath: (json: unknown) => string | null }[] = [
  {
    path: ".claude-plugin/marketplace.json",
    extractPath: (json) =>
      firstPluginSource(json, (entry) =>
        typeof entry["source"] === "string" ? entry["source"] : null,
      ),
  },
  {
    path: ".agents/plugins/marketplace.json",
    extractPath: (json) =>
      firstPluginSource(json, (entry) => {
        const source = entry["source"];
        if (!isRecord(source)) return null;
        const path = source["path"];
        return typeof path === "string" ? path : null;
      }),
  },
];

/** The portable skill the pinned skills installer targets. Not in the npm `files` allowlist —
 * that installer fetches it straight from the promoted git ref, so promotion must prove it's
 * actually there rather than trusting the tag exists. */
const PORTABLE_SKILL_PATH = "skills/livediff/SKILL.md";

function firstPluginSource(
  json: unknown,
  extract: (entry: Record<string, unknown>) => string | null,
): string | null {
  if (!isRecord(json)) return null;
  const plugins = json["plugins"];
  if (!Array.isArray(plugins) || plugins.length === 0) return null;
  const first = plugins[0];
  if (!isRecord(first)) return null;
  return extract(first);
}

async function validatePortableSkillAtTag(tag: string): Promise<void> {
  try {
    await git(["cat-file", "-e", `${tag}:${PORTABLE_SKILL_PATH}`]);
  } catch {
    throw new Error(
      `${PORTABLE_SKILL_PATH} does not exist at ${tag} — the promoted ref must ship the portable skill`,
    );
  }
  console.log(`${PORTABLE_SKILL_PATH} exists at ${tag}`);
}

async function validateCatalogsAtTag(tag: string): Promise<void> {
  for (const catalog of CATALOGS) {
    const raw = await git(["show", `${tag}:${catalog.path}`]);
    const json: unknown = JSON.parse(raw);
    const relativePath = catalog.extractPath(json);
    if (!relativePath)
      throw new Error(`${catalog.path} at ${tag}: could not find a plugin source path`);
    const normalized = relativePath.replace(/^\.\//, "");
    const listing = await git(["ls-tree", "-d", "--name-only", tag, "--", normalized]).catch(
      () => "",
    );
    if (!listing)
      throw new Error(
        `${catalog.path} at ${tag}: referenced path ${relativePath} does not exist at that tag`,
      );
  }
}

interface PromoteOptions {
  version: string;
  yes: boolean;
}

async function promote(options: PromoteOptions): Promise<void> {
  await verifyRegistry(options.version);

  const tag = `v${options.version}`;
  await validateCatalogsAtTag(tag);
  console.log(`both marketplace catalogs resolve at ${tag}`);
  await validatePortableSkillAtTag(tag);

  // A branch must point at a commit; pushing an annotated tag object there is rejected.
  const refspec = `${tag}^{commit}:refs/heads/stable`;
  console.log(`next: git push origin ${refspec}`);
  if (!options.yes) {
    console.log("(pass --yes to run it)");
    return;
  }
  // No --force: a rejected non-fast-forward push is the safety net, not an error to work around.
  await runInherited("git", ["push", "origin", refspec]);
  console.log("promoted.");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");

  const publishTarball = flagValue(argv, "--publish");
  if (publishTarball) {
    // npm reads a relative `dir/file.tgz` as a GitHub `owner/repo` shorthand.
    await publish({ tarballPath: resolve(publishTarball), yes, otp: flagValue(argv, "--otp") });
    return;
  }

  const verifyVersion = flagValue(argv, "--verify-registry");
  if (verifyVersion) {
    await verifyRegistry(verifyVersion);
    return;
  }

  const promoteVersion = flagValue(argv, "--promote");
  if (promoteVersion) {
    await promote({ version: promoteVersion, yes });
    return;
  }

  // Default and --dry-run are the same phase: this script never publishes without --publish.
  await dryRun();
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
