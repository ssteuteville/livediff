import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const built = (path: string): string =>
  pathToFileURL(fileURLToPath(new URL(`../dist-server/server/${path}`, import.meta.url))).href;

const npmAvailable = await exec("npm", ["--version"]).then(
  () => true,
  () => false,
);

/**
 * The real thing, minus the registry: pack a tiny package whose `livediff` bin runs setup's npm
 * step, execute it through `npx` from an unrelated directory with an isolated cache and global
 * prefix (containing a space), and prove the persistent bin still works after npx has exited.
 * `LIVEDIFF_SETUP_PACKAGE` points the install at the same tarball, so nothing is downloaded.
 */
test.skipIf(!npmAvailable)(
  "npx setup leaves a persistent livediff that runs outside npx",
  { timeout: 120_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "livediff-npx-")));
    try {
      const pkg = join(root, "pkg");
      await mkdir(join(pkg, "bin"), { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "livediff-setup-probe",
          version: "0.0.1-test",
          type: "module",
          bin: { livediff: "bin/livediff.js" },
        }),
      );
      await writeFile(join(pkg, "bin", "livediff.js"), probeScript());
      await chmod(join(pkg, "bin", "livediff.js"), 0o755);
      await exec("npm", ["pack", "--silent", "--pack-destination", root], { cwd: pkg });
      const tarball = join(root, "livediff-setup-probe-0.0.1-test.tgz");

      const prefix = join(root, "global prefix");
      const cwd = join(root, "somewhere", "else");
      await mkdir(cwd, { recursive: true });
      const nodeDir = dirname(process.execPath);
      const basePath = [join(prefix, "bin"), nodeDir, "/usr/bin", "/bin"].join(delimiter);
      const env = {
        HOME: root,
        PATH: basePath,
        npm_config_cache: join(root, "npm cache"),
        npm_config_prefix: prefix,
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        LIVEDIFF_SETUP_PACKAGE: `file:${tarball}`,
      };

      const npx = await exec(
        "npx",
        ["--yes", "--package", `file:${tarball}`, "livediff", "setup"],
        {
          cwd,
          env,
        },
      );
      const result: unknown = JSON.parse(npx.stdout);
      assert.ok(isRecord(result) && isRecord(result["persistent"]) && isRecord(result["outcome"]));
      assert.equal(result["outcome"]["status"], "installed", JSON.stringify(result));
      const persistent = result["persistent"];
      assert.equal(persistent["bin"], join(prefix, "bin", "livediff"));
      assert.equal(persistent["version"], "0.0.1-test");
      assert.ok(!JSON.stringify(persistent).includes("_npx"));
      assert.ok(
        (await readdir(join(root, "npm cache", "_npx"))).length > 0,
        "npx really ran from its cache",
      );

      const after = await exec(join(prefix, "bin", "livediff"), ["--version"], {
        cwd: root,
        env: { HOME: root, PATH: basePath },
      });
      assert.equal(after.stdout.trim(), "0.0.1-test");

      const rerun = await exec(join(prefix, "bin", "livediff"), ["setup"], {
        cwd: root,
        env: { ...env, PATH: basePath },
      });
      const second: unknown = JSON.parse(rerun.stdout);
      assert.ok(isRecord(second) && isRecord(second["outcome"]));
      assert.equal(second["outcome"]["status"], "unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

function probeScript(): string {
  return `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { ensurePersistentCli, readPackageIdentity } from ${JSON.stringify(built("setup/npm.js"))};
import { runProcess } from ${JSON.stringify(built("setup/process.js"))};
const self = await readPackageIdentity(fileURLToPath(import.meta.url));
if (process.argv[2] === "--version") {
  console.log(self.version);
  process.exit(0);
}
const quiet = () => {};
const ctx = {
  run: runProcess,
  prompts: null,
  progress: { step: quiet, ok: quiet, warn: quiet, fail: quiet, info: quiet },
  env: process.env,
  platform: process.platform,
  cliVersion: self.version,
  source: null,
  persistent: null,
};
const result = await ensurePersistentCli(ctx, { update: false, continuation: false }, self);
console.log(JSON.stringify(result));
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
