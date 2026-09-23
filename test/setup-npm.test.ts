import { test } from "vitest";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { userPath } from "../server/executable-path.js";
import { ensurePersistentCli, handOffSetup, type PackageIdentity } from "../server/setup/npm.js";
import { SETUP_CONTINUATION_ENV } from "../server/setup/lock.js";
import type { RunOptions, RunResult } from "../server/setup/types.js";
import { failed, fakeContext, fakeRunner, ok, recordingProgress } from "./setup-fixtures.js";

/**
 * A disposable npm world on real disk — a global prefix (with spaces in its path), npx's cache,
 * and the directories npm exec prepends to PATH — driven by a fake `npm` that installs by
 * writing files. Nothing here touches the developer's npm.
 */
interface World {
  root: string;
  prefix: string;
  globalRoot: string;
  binDir: string;
  npxBin: string;
  env: NodeJS.ProcessEnv;
  self: PackageIdentity;
  installGlobal(name: string, version: string): Promise<void>;
}

async function withWorld(
  options: { name?: string; version?: string; persistent?: boolean },
  fn: (world: World) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "livediff setup npm ")));
  const name = options.name ?? "livediff";
  const version = options.version ?? "1.2.3";
  const prefix = join(root, "global prefix");
  const globalRoot = join(prefix, "lib", "node_modules");
  const binDir = join(prefix, "bin");
  const npxModules = join(root, "npm cache", "_npx", "0a1b2c3d", "node_modules");
  const npxBin = join(npxModules, ".bin");
  const work = join(root, "work", "project");
  await mkdir(binDir, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeExecutable(join(binDir, "node"), "#!/bin/sh\n");

  const installPackage = async (
    modules: string,
    bins: string,
    pkgName: string,
    pkgVersion: string,
  ) => {
    const dir = join(modules, pkgName);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: pkgName, version: pkgVersion, bin: { livediff: "cli.js" } }),
    );
    await writeExecutable(join(dir, "cli.js"), "#!/usr/bin/env node\n");
    await mkdir(bins, { recursive: true });
    await rm(join(bins, "livediff"), { force: true });
    await symlink(join(dir, "cli.js"), join(bins, "livediff"));
    return dir;
  };

  const selfRoot = options.persistent
    ? await installPackage(globalRoot, binDir, name, version)
    : await installPackage(npxModules, npxBin, name, version);
  const env: NodeJS.ProcessEnv = {
    PATH: [
      npxBin,
      join(work, "node_modules", ".bin"),
      join(root, "work", "node_modules", ".bin"),
      join(root, "node_modules", ".bin"),
      "/opt/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
      binDir,
      "/usr/bin",
      "/bin",
    ].join(delimiter),
    npm_command: "exec",
    npm_lifecycle_event: "npx",
    npm_config_local_prefix: work,
    SHELL: "/bin/zsh",
  };
  if (options.persistent) env["PATH"] = [binDir, "/usr/bin", "/bin"].join(delimiter);
  const world: World = {
    root,
    prefix,
    globalRoot,
    binDir,
    npxBin,
    env,
    self: { name, version, root: selfRoot, enginesNode: ">=22", binName: "livediff" },
    installGlobal: async (pkgName, pkgVersion) => {
      await installPackage(globalRoot, binDir, pkgName, pkgVersion);
    },
  };
  try {
    await fn(world);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

/** The fake npm: prefix/root queries, installs that write the package, and `--version` of bins. */
function npmWorld(
  world: World,
  options: {
    latest?: string;
    install?: (spec: string) => RunResult | undefined;
    prefix?: RunResult;
  } = {},
) {
  return fakeRunner(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") return options.prefix ?? ok(`${world.prefix}\n`);
    if (command === "npm" && args[0] === "root") return ok(`${world.globalRoot}\n`);
    if (command === "npm" && args[0] === "view") {
      return options.latest === undefined ? failed("npm error 404") : ok(`${options.latest}\n`);
    }
    if (command === "npm" && args[0] === "install") {
      const spec = args.at(-1) ?? "";
      const custom = options.install?.(spec);
      if (custom !== undefined) return custom;
      const at = spec.lastIndexOf("@");
      await world.installGlobal(spec.slice(0, at), spec.slice(at + 1));
      return ok();
    }
    if (args[0] === "--version") return ok(`${await versionOfBin(command)}\n`);
    return undefined;
  });
}

async function versionOfBin(bin: string): Promise<string> {
  const pkg: unknown = JSON.parse(
    await readFile(join(dirname(await realpath(bin)), "package.json"), "utf8"),
  );
  return typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "?";
}

function installs(calls: { command: string; args: readonly string[] }[]): string[] {
  return calls
    .filter((c) => c.command === "npm" && c.args[0] === "install")
    .map((c) => c.args.at(-1) ?? "");
}

test("npx setup installs exactly the executing version and returns only persistent paths", async () => {
  await withWorld({}, async (world) => {
    const { run, calls } = npmWorld(world);
    const result = await ensurePersistentCli(
      fakeContext({ run, env: world.env }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "installed");
    assert.deepEqual(installs(calls), ["livediff@1.2.3"]);
    assert.deepEqual(result.persistent, {
      packageName: "livediff",
      version: "1.2.3",
      bin: join(world.binDir, "livediff"),
      packageRoot: join(world.globalRoot, "livediff"),
      node: join(world.binDir, "node"),
    });
    assert.equal(result.handoff, false);
    assert.ok(!JSON.stringify(result).includes("_npx"));
    const versionCall = calls.find((c) => c.args[0] === "--version");
    assert.equal(versionCall?.command, join(world.binDir, "livediff"));
    assert.ok(!(versionCall?.options?.env?.["PATH"] ?? "").includes("_npx"));
  });
});

test("a matching global install is reused; older and newer ones are replaced by the exact version", async () => {
  await withWorld({}, async (world) => {
    await world.installGlobal("livediff", "1.2.3");
    const reuse = npmWorld(world);
    const reused = await ensurePersistentCli(
      fakeContext({ run: reuse.run, env: world.env }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(reused.outcome.status, "unchanged");
    assert.deepEqual(installs(reuse.calls), []);

    for (const existing of ["1.0.0", "2.0.0"]) {
      await world.installGlobal("livediff", existing);
      const replace = npmWorld(world);
      const replaced = await ensurePersistentCli(
        fakeContext({ run: replace.run, env: world.env }),
        { update: false, continuation: false },
        world.self,
      );
      assert.equal(replaced.outcome.status, "installed", existing);
      assert.deepEqual(installs(replace.calls), ["livediff@1.2.3"]);
      assert.equal(replaced.persistent?.version, "1.2.3");
    }
  });
});

test("scoped package names install and verify under their scope", async () => {
  await withWorld({ name: "@acme/livediff", version: "3.0.0" }, async (world) => {
    const { run, calls } = npmWorld(world);
    const result = await ensurePersistentCli(
      fakeContext({ run, env: world.env }),
      { update: false, continuation: false },
      world.self,
    );
    assert.deepEqual(installs(calls), ["@acme/livediff@3.0.0"]);
    assert.equal(result.persistent?.packageRoot, join(world.globalRoot, "@acme", "livediff"));
    assert.equal(result.persistent?.packageName, "@acme/livediff");
  });
});

test("a plain `livediff setup` from the global install reuses it and never upgrades", async () => {
  await withWorld({ persistent: true }, async (world) => {
    const { run, calls } = npmWorld(world, { latest: "9.9.9" });
    const result = await ensurePersistentCli(
      fakeContext({ run, env: world.env }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "unchanged");
    assert.deepEqual(installs(calls), []);
    assert.ok(!calls.some((c) => c.args[0] === "view"));
  });
});

test("npm failures name the cause and give a retry, never sudo", async () => {
  await withWorld({}, async (world) => {
    const cases: [ReturnType<typeof npmWorld>, RegExp][] = [
      [
        npmWorld(world, { prefix: failed("npm error config prefix cannot be read") }),
        /npm prefix --global failed: npm error config prefix cannot be read/,
      ],
      [
        npmWorld(world, { prefix: { code: -1, stdout: "", stderr: "ENOENT" } }),
        /npm was not found/,
      ],
      [
        npmWorld(world, {
          install: () =>
            failed(
              "npm error code EACCES\nnpm error syscall mkdir\nnpm error A complete log of this run can be found in: /x.log",
              243,
            ),
        }),
        /permission denied.*resolving-eacces-permissions.*version manager.*never uses sudo/s,
      ],
      [
        npmWorld(world, {
          install: () =>
            failed(
              "npm error code ETARGET\nnpm error notarget No matching version\nnpm error A complete log of this run can be found in: /x.log",
            ),
        }),
        /failed: code ETARGET; notarget No matching version$/,
      ],
    ];
    for (const [runner, pattern] of cases) {
      const result = await ensurePersistentCli(
        fakeContext({ run: runner.run, env: world.env }),
        { update: false, continuation: false },
        world.self,
      );
      assert.equal(result.outcome.status, "failed");
      assert.equal(result.outcome.required, true);
      assert.equal(result.outcome.retry, "npx livediff@latest setup");
      assert.match(result.outcome.detail ?? "", pattern);
      assert.equal(result.persistent, null);
      assert.ok(!runner.calls.some((c) => c.command === "sudo"));
    }
  });
});

test("another livediff earlier on the user's PATH is reported, not removed", async () => {
  await withWorld({}, async (world) => {
    const pnpmHome = join(world.root, "Library", "pnpm");
    await writeExecutable(join(pnpmHome, "livediff"), "#!/bin/sh\necho 0.1.0\n");
    const env = {
      ...world.env,
      PATH: (world.env["PATH"] ?? "").replace(
        world.binDir,
        `${pnpmHome}${delimiter}${world.binDir}`,
      ),
    };
    const { run, calls } = npmWorld(world);
    const result = await ensurePersistentCli(
      fakeContext({ run, env }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "failed");
    assert.match(
      result.outcome.detail ?? "",
      new RegExp(`runs ${join(pnpmHome, "livediff")}.*pnpm remove --global livediff`),
    );
    assert.ok(!calls.some((c) => c.args.includes("uninstall") || c.args.includes("remove")));
  });
});

test("npx's own temporary livediff never counts as the installed one", async () => {
  await withWorld({}, async (world) => {
    const env = {
      ...world.env,
      PATH: (world.env["PATH"] ?? "").replace(`${delimiter}${world.binDir}`, ""),
    };
    const { run } = npmWorld(world);
    const result = await ensurePersistentCli(
      fakeContext({ run, env }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "failed");
    assert.match(
      result.outcome.detail ?? "",
      new RegExp(
        `${world.binDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not on your PATH.*export PATH="`,
      ),
    );
  });
});

test("--update resolves latest once, installs it, and hands off when the version changed", async () => {
  await withWorld({ persistent: true }, async (world) => {
    const { run, calls } = npmWorld(world, { latest: "1.3.0" });
    const progress = recordingProgress();
    const result = await ensurePersistentCli(
      fakeContext({ run, env: world.env, progress }),
      { update: true, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "updated");
    assert.equal(result.persistent?.version, "1.3.0");
    assert.equal(result.handoff, true);
    assert.deepEqual(installs(calls), ["livediff@1.3.0"]);
    assert.equal(calls.filter((c) => c.args[0] === "view").length, 1);
    assert.ok(progress.lines.includes("ok LiveDiff CLI 1.2.3 → 1.3.0"));
  });
});

test("--update with nothing newer changes nothing and does not hand off", async () => {
  await withWorld({ persistent: true }, async (world) => {
    const { run, calls } = npmWorld(world, { latest: "1.2.3" });
    const result = await ensurePersistentCli(
      fakeContext({ run, env: world.env }),
      { update: true, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "unchanged");
    assert.equal(result.handoff, false);
    assert.deepEqual(installs(calls), []);
  });
});

test("the handed-off CLI only verifies: no second lookup, install, or handoff", async () => {
  await withWorld({ persistent: true }, async (world) => {
    const { run, calls } = npmWorld(world, { latest: "5.0.0" });
    const result = await ensurePersistentCli(
      fakeContext({ run, env: world.env }),
      { update: true, continuation: true },
      world.self,
    );
    assert.equal(result.outcome.status, "updated");
    assert.equal(result.handoff, false);
    assert.ok(!calls.some((c) => c.args[0] === "view" || c.args[0] === "install"));
  });
});

test("LIVEDIFF_SETUP_PACKAGE installs that spec, and must produce the executing version", async () => {
  await withWorld({}, async (world) => {
    const tarball = join(world.root, "my build", "livediff-1.2.3.tgz");
    const good = npmWorld(world);
    const goodRun = fakeRunner(async (command, args, options) => {
      if (command === "npm" && args[0] === "install") {
        await world.installGlobal("livediff", "1.2.3");
        return ok();
      }
      return good.run(command, args, options);
    });
    const result = await ensurePersistentCli(
      fakeContext({ run: goodRun.run, env: { ...world.env, LIVEDIFF_SETUP_PACKAGE: tarball } }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(result.outcome.status, "installed");
    assert.deepEqual(installs(goodRun.calls), [tarball]);

    await rm(join(world.globalRoot, "livediff"), { recursive: true });
    const wrong = fakeRunner(async (command, args, options) => {
      if (command === "npm" && args[0] === "install") {
        await world.installGlobal("livediff", "1.0.0");
        return ok();
      }
      return good.run(command, args, options);
    });
    const mismatch = await ensurePersistentCli(
      fakeContext({ run: wrong.run, env: { ...world.env, LIVEDIFF_SETUP_PACKAGE: tarball } }),
      { update: false, continuation: false },
      world.self,
    );
    assert.equal(mismatch.outcome.status, "failed");
    assert.match(
      mismatch.outcome.detail ?? "",
      /installed livediff 1\.0\.0, but this setup is 1\.2\.3/,
    );
  });
});

test("the handoff runs the new CLI with the chosen flags, a clean PATH, and the lock token", async () => {
  const seen: { command: string; args: readonly string[]; options: RunOptions | undefined }[] = [];
  const ctx = fakeContext({
    run: async (command, args, options) => {
      seen.push({ command, args, options });
      return { code: 3, stdout: "", stderr: "" };
    },
    env: { PATH: `/cache/_npx/ab12/node_modules/.bin${delimiter}/usr/bin`, npm_command: "exec" },
  });
  const code = await handOffSetup(
    ctx,
    {
      packageName: "livediff",
      version: "2.0.0",
      bin: "/p/bin/livediff",
      packageRoot: "/p/lib/node_modules/livediff",
      node: "/p/bin/node",
    },
    ["--update", "--agent", "codex"],
    "token-123",
  );
  assert.equal(code, 3);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.command, "/p/bin/node");
  assert.deepEqual(seen[0]?.args, ["/p/bin/livediff", "setup", "--update", "--agent", "codex"]);
  assert.equal(seen[0]?.options?.inherit, true);
  assert.equal(seen[0]?.options?.env?.[SETUP_CONTINUATION_ENV], "token-123");
  assert.equal(seen[0]?.options?.env?.["PATH"], "/usr/bin");
});

test("only npm exec's own PATH entries are removed", () => {
  const env = {
    npm_command: "exec",
    npm_config_local_prefix: "/home/u/proj",
    PATH: [
      "/home/u/.npm/_npx/0f1e2d/node_modules/.bin",
      "/home/u/proj/node_modules/.bin",
      "/home/u/node_modules/.bin",
      "/home/node_modules/.bin",
      "/node_modules/.bin",
      "/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
      "/home/u/proj/node_modules/.bin",
      "/usr/local/bin",
    ].join(delimiter),
  };
  assert.equal(userPath(env), ["/home/u/proj/node_modules/.bin", "/usr/local/bin"].join(delimiter));

  const outsideNpm = { PATH: ["/home/u/proj/node_modules/.bin", "/usr/bin"].join(delimiter) };
  assert.equal(userPath(outsideNpm), outsideNpm.PATH);
});
