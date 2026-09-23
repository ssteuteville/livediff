/**
 * Installs a packed tarball into an isolated npm prefix and exercises the consumer journey end to
 * end: version check, worktree registration, HTTP asset/schema access, lens persistence across a
 * restart, and shutdown. Runs entirely outside the checkout so it cannot accidentally pick up
 * `dist-server/` from the source tree instead of the installed copy.
 *
 * Usage: `pnpm package:smoke <tarball> [--node <path-to-node-binary>]`
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";

const exec = promisify(execFile);

interface CliOptions {
  tarballPath: string;
  nodeBinary: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const nodeFlagIndex = argv.indexOf("--node");
  const nodeBinary = nodeFlagIndex >= 0 ? argv[nodeFlagIndex + 1] : undefined;
  const tarballPath = positional[0];
  if (!tarballPath) {
    throw new Error("usage: smoke-package <tarball> [--node <path-to-node-binary>]");
  }
  // npm reads a relative `dir/file.tgz` as a GitHub `owner/repo` shorthand.
  return { tarballPath: resolve(tarballPath), nodeBinary: nodeBinary ?? process.execPath };
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string | undefined;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

interface Sandbox {
  root: string;
  prefix: string;
  env: NodeJS.ProcessEnv;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "livediff-smoke-"));
  const prefix = join(root, "npm-prefix");
  const cache = join(root, "npm-cache");
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  const xdgState = join(root, "xdg-state");
  for (const dir of [prefix, cache, home, xdgConfig, xdgState])
    await mkdir(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    npm_config_prefix: prefix,
    npm_config_cache: cache,
    LIVEDIFF_BROWSER: "true",
    NO_COLOR: "1",
  };
  return { root, prefix, env };
}

async function installTarball(sandbox: Sandbox, tarballPath: string): Promise<void> {
  await exec("npm", ["install", "-g", tarballPath], {
    cwd: sandbox.root,
    env: sandbox.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runCli(
  sandbox: Sandbox,
  nodeBinary: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = sandbox.root,
): Promise<{ stdout: string; stderr: string }> {
  const cliPath = join(
    sandbox.prefix,
    "lib",
    "node_modules",
    "livediff",
    "dist-server",
    "server",
    "cli.js",
  );
  return exec(nodeBinary, [cliPath, ...args], {
    cwd,
    env: { ...sandbox.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function makeDisposableRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "smoke@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "Smoke Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# smoke\n", "utf8");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-qm", "init"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# smoke\n\nuncommitted change\n", "utf8");
  return repo;
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  const body = await response.text();
  return { status: response.status, body };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sandbox = await makeSandbox();
  const port = await freePort();
  try {
    try {
      await installTarball(sandbox, options.tarballPath);
      record("npm install -g <tarball>", true);
    } catch (error) {
      record("npm install -g <tarball>", false, exceptionMessage(error));
      return finish();
    }

    try {
      const { stdout } = await runCli(sandbox, options.nodeBinary, ["--version"]);
      record("livediff --version", true, stdout.trim());
    } catch (error) {
      record("livediff --version", false, exceptionMessage(error));
      return finish();
    }

    const repo = await makeDisposableRepo(sandbox.root);

    let workspaceId: string | undefined;
    try {
      const { stdout } = await runCli(sandbox, options.nodeBinary, ["link", repo, "--json"], {
        LIVEDIFF_PORT: String(port),
      });
      const parsed: unknown = JSON.parse(stdout);
      if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
        workspaceId = String((parsed as Record<string, unknown>)["id"]);
      }
      record("livediff link <repo> --json", Boolean(workspaceId), stdout.trim());
    } catch (error) {
      record("livediff link <repo> --json", false, exceptionMessage(error));
    }

    try {
      const index = await fetchText(`http://127.0.0.1:${port}/`);
      const assetMatch = index.body.match(/\/assets\/[^"']+\.(?:js|css)/);
      const assetOk = index.status === 200 && Boolean(assetMatch);
      record("GET / (UI index)", assetOk, `status=${index.status}`);
      if (assetMatch) {
        const asset = await fetchText(`http://127.0.0.1:${port}${assetMatch[0]}`);
        record(`GET ${assetMatch[0]}`, asset.status === 200, `status=${asset.status}`);
      }
    } catch (error) {
      record("GET / (UI index)", false, exceptionMessage(error));
    }

    try {
      const { stdout } = await runCli(sandbox, options.nodeBinary, ["config", "schema"], {
        LIVEDIFF_PORT: String(port),
      });
      const schemaPath = stdout.trim().split("\n").pop() ?? "";
      record("livediff config schema", schemaPath.length > 0, schemaPath);
    } catch (error) {
      record("livediff config schema", false, exceptionMessage(error));
    }

    try {
      await runCli(
        sandbox,
        options.nodeBinary,
        ["lens", "add", "smoke-lens", "--path", "README.md"],
        { LIVEDIFF_PORT: String(port) },
        repo,
      );
      const { stdout } = await runCli(
        sandbox,
        options.nodeBinary,
        ["lens", "list"],
        { LIVEDIFF_PORT: String(port) },
        repo,
      );
      record("livediff lens add / list", stdout.includes("smoke-lens"), stdout.trim());
    } catch (error) {
      record("livediff lens add / list", false, exceptionMessage(error));
    }

    try {
      await runCli(sandbox, options.nodeBinary, ["stop"], { LIVEDIFF_PORT: String(port) });
      record("livediff stop", true);
    } catch (error) {
      record("livediff stop", false, exceptionMessage(error));
    }

    try {
      const { stdout } = await runCli(
        sandbox,
        options.nodeBinary,
        ["lens", "list"],
        { LIVEDIFF_PORT: String(port) },
        repo,
      );
      record("lens persistence survives restart", stdout.includes("smoke-lens"), stdout.trim());
    } catch (error) {
      record("lens persistence survives restart", false, exceptionMessage(error));
    }

    await runCli(sandbox, options.nodeBinary, ["stop"], { LIVEDIFF_PORT: String(port) }).catch(
      () => {},
    );
  } finally {
    await rm(sandbox.root, { recursive: true, force: true }).catch(() => {});
  }
  finish();
}

function exceptionMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function finish(): void {
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
