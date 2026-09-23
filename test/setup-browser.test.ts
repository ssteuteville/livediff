import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, setConfigValue } from "../server/config.js";
import { emptySetupState, type SetupState } from "../server/setup/state.js";
import {
  configureBrowser,
  inspectSavedBrowser,
  repairOwnedOpener,
} from "../server/setup/browser.js";
import type { Prompter, Progress, Runner, SetupContext } from "../server/setup/types.js";
import { withTempXdg } from "./helpers.js";

const fakeRun: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
const fakePrompts: Prompter = {
  multiselect: async () => [],
  select: async () => {
    throw new Error("unexpected select() call");
  },
  confirm: async () => false,
};
const fakeProgress: Progress = {
  step: () => undefined,
  ok: () => undefined,
  warn: () => undefined,
  fail: () => undefined,
  info: () => undefined,
};

/**
 * `LIVEDIFF_BROWSER` is stripped from the default env so these tests never depend on whether the
 * developer running them happens to have it set in their own shell (browser.ts now reads
 * `ctx.env`, never `process.env`, for exactly this reason).
 */
function defaultEnv(): NodeJS.ProcessEnv {
  const { LIVEDIFF_BROWSER: _unused, ...rest } = process.env;
  return rest;
}

function baseCtx(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    run: fakeRun,
    prompts: fakePrompts,
    progress: fakeProgress,
    env: defaultEnv(),
    platform: "darwin",
    cliVersion: "0.0.0-test",
    source: {
      id: "test",
      claudeMarketplace: "test",
      codexMarketplace: "test",
      codexRef: null,
      skills: "test",
    },
    persistent: null,
    ...overrides,
  };
}

/**
 * A real (but fake-content) persistent install, laid out like a real npm install
 * (`node_modules/<packageName>/dist-server/server/cmux-open.js`) so the path-shape ownership
 * check in browser.ts actually matches it, and so filesystem staleness checks behave truthfully.
 */
async function makePersistent(
  root: string,
  packageName = "livediff",
): Promise<{ node: string; packageRoot: string }> {
  const packageRoot = join(root, "node_modules", packageName);
  const helperDir = join(packageRoot, "dist-server", "server");
  await mkdir(helperDir, { recursive: true });
  await writeFile(join(helperDir, "cmux-open.js"), "// fake compiled helper\n");
  const node = join(root, "bin", "node");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(node, "#!/bin/sh\nexit 0\n");
  await chmod(node, 0o755);
  return { node, packageRoot };
}

function helperPathFor(packageRoot: string): string {
  return join(packageRoot, "dist-server", "server", "cmux-open.js");
}

async function makeCmuxOnPath(root: string): Promise<string> {
  const bin = join(root, "cmux-bin");
  await mkdir(bin, { recursive: true });
  const cmux = join(bin, "cmux");
  await writeFile(cmux, "#!/bin/sh\nexit 0\n");
  await chmod(cmux, 0o755);
  return bin;
}

describe("setup/browser", () => {
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  async function tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "livediff-setup-browser-"));
    dirs.push(d);
    return d;
  }

  it("inspects a fresh install with no configured opener as kind none", async () => {
    await withTempXdg(async () => {
      const ctx = baseCtx();
      const saved = await inspectSavedBrowser(ctx);
      expect(saved).toEqual({
        stored: null,
        kind: "none",
        stale: false,
        environmentOverride: null,
      });
    });
  });

  it("fresh cmux configure writes argv and records ownedOpener", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "cmux", state);

      const desired = [node, helperPathFor(packageRoot)];
      expect(result.status).toBe("installed");
      expect(state.ownedOpener).toEqual(desired);
      expect(loadConfig().browser.opener).toEqual(desired);

      const saved = await inspectSavedBrowser(ctx);
      expect(saved).toEqual({
        stored: desired,
        kind: "cmux",
        stale: false,
        environmentOverride: null,
      });
    });
  });

  it("a rerun with the same persistent install is unchanged", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();

      await configureBrowser(ctx, "cmux", state);
      const second = await configureBrowser(ctx, "cmux", state);

      expect(second.status).toBe("unchanged");
    });
  });

  it("explicit system removes a custom opener", async () => {
    await withTempXdg(async () => {
      await setConfigValue("browser.opener", ["my-custom-opener", "--flag"]);
      const ctx = baseCtx();
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "system", state);

      expect(result.status).toBe("updated");
      expect(state.ownedOpener).toBeNull();
      expect(loadConfig().browser.opener).toBeNull();
    });
  });

  it("system choice is unchanged when nothing was configured", async () => {
    await withTempXdg(async () => {
      const ctx = baseCtx();
      const state: SetupState = emptySetupState();
      const result = await configureBrowser(ctx, "system", state);
      expect(result.status).toBe("unchanged");
    });
  });

  it("inspect reports a custom opener as kind custom", async () => {
    await withTempXdg(async () => {
      await setConfigValue("browser.opener", ["code", "--open-url"]);
      const ctx = baseCtx();
      const saved = await inspectSavedBrowser(ctx);
      expect(saved.kind).toBe("custom");
      expect(saved.stale).toBe(false);
      expect(saved.stored).toEqual(["code", "--open-url"]);
    });
  });

  it("classifies a dev-checkout opener (no node_modules ancestor) as custom, not cmux", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const devHelper = join(root, "checkout", "dist-server", "server", "cmux-open.js");
      await mkdir(join(root, "checkout", "dist-server", "server"), { recursive: true });
      await writeFile(devHelper, "// dev build\n");
      await setConfigValue("browser.opener", [process.execPath, devHelper]);

      const ctx = baseCtx();
      const saved = await inspectSavedBrowser(ctx);
      expect(saved.kind).toBe("custom");
    });
  });

  it("rejects a differently-named dist-server directory as a suffix-match false positive", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const trap = join(
        root,
        "node_modules",
        "livediff",
        "my-dist-server",
        "server",
        "cmux-open.js",
      );
      await mkdir(join(root, "node_modules", "livediff", "my-dist-server", "server"), {
        recursive: true,
      });
      await writeFile(trap, "// not the real thing\n");
      await setConfigValue("browser.opener", [process.execPath, trap]);

      const ctx = baseCtx();
      const saved = await inspectSavedBrowser(ctx);
      expect(saved.kind).toBe("custom");
    });
  });

  it("migrates a legacy shim to the packaged helper without deleting the shim", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const shimDir = join(root, "local-bin");
      await mkdir(shimDir, { recursive: true });
      const shimPath = join(shimDir, "livediff-cmux-open");
      await writeFile(shimPath, "#!/bin/sh\nexit 0\n");
      await chmod(shimPath, 0o755);
      await setConfigValue("browser.opener", [shimPath]);

      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();

      const before = await inspectSavedBrowser(ctx);
      expect(before.kind).toBe("legacy-cmux");

      const result = await configureBrowser(ctx, "cmux", state);

      expect(result.status).toBe("updated");
      expect(result.detail).toContain(shimPath);
      expect(loadConfig().browser.opener).toEqual([node, helperPathFor(packageRoot)]);
      // The shim itself must be left alone: access must still succeed, not merely "not deleted".
      await expect(access(shimPath)).resolves.toBeUndefined();
    });
  });

  it("repairOwnedOpener leaves a legacy shim alone", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const persistent = await makePersistent(root);
      const shimDir = join(root, "local-bin");
      await mkdir(shimDir, { recursive: true });
      const shimPath = join(shimDir, "livediff-cmux-open");
      await writeFile(shimPath, "#!/bin/sh\nexit 0\n");
      await chmod(shimPath, 0o755);
      await setConfigValue("browser.opener", [shimPath]);

      const ctx = baseCtx({
        persistent: { packageName: "livediff", version: "1.0.0", bin: "livediff", ...persistent },
      });
      const state: SetupState = emptySetupState();

      const outcome = await repairOwnedOpener(ctx, state);

      expect(outcome).toBeNull();
      expect(loadConfig().browser.opener).toEqual([shimPath]);
      await expect(access(shimPath)).resolves.toBeUndefined();
    });
  });

  it("explicit cmux choice replaces a custom opener and names it in the outcome", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      await setConfigValue("browser.opener", ["my-editor", "--open"]);

      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "cmux", state);

      expect(result.status).toBe("updated");
      expect(result.detail).toContain("my-editor --open");
      expect(loadConfig().browser.opener).toEqual([node, helperPathFor(packageRoot)]);
    });
  });

  it("detects staleness once the helper file disappears", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();
      await configureBrowser(ctx, "cmux", state);

      await rm(helperPathFor(packageRoot), { force: true });

      const saved = await inspectSavedBrowser(ctx, state.ownedOpener);
      expect(saved.kind).toBe("cmux");
      expect(saved.stale).toBe(true);
    });
  });

  it("configureBrowser fails (not silently succeeds) when the install's own helper is missing", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      await rm(helperPathFor(packageRoot), { force: true });
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "cmux", state);

      expect(result.status).toBe("failed");
      expect(result.retry).toBe("livediff setup --browser cmux");
      expect(loadConfig().browser.opener).toBeNull();
      expect(state.ownedOpener).toBeNull();
    });
  });

  it("repairOwnedOpener rewrites a stale owned opener to the current persistent install", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const original = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx1 = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node: original.node,
          packageRoot: original.packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();
      await configureBrowser(ctx1, "cmux", state);

      // Simulate a version-manager reinstall: new node/package paths, old ones gone.
      const v2Root = join(root, "v2");
      await mkdir(v2Root, { recursive: true });
      const reinstalled = await makePersistent(v2Root);
      const ctx2 = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.1.0",
          bin: "livediff",
          node: reinstalled.node,
          packageRoot: reinstalled.packageRoot,
        },
        env: ctx1.env,
      });

      const outcome = await repairOwnedOpener(ctx2, state);

      expect(outcome).not.toBeNull();
      expect(outcome?.status).toBe("updated");
      const desired = [reinstalled.node, helperPathFor(reinstalled.packageRoot)];
      expect(loadConfig().browser.opener).toEqual(desired);
      expect(state.ownedOpener).toEqual(desired);
    });
  });

  it('reports "failed", not "updated", when the stored opener already equals desired but is broken', async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const { node, packageRoot } = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node,
          packageRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();
      await configureBrowser(ctx, "cmux", state);

      // The stored argv still exactly matches what repair would write, but the file is gone.
      await rm(helperPathFor(packageRoot), { force: true });

      const outcome = await repairOwnedOpener(ctx, state);

      expect(outcome).not.toBeNull();
      expect(outcome?.status).toBe("failed");
      expect(outcome?.retry).toBe("livediff setup --browser cmux");
    });
  });

  it("repairOwnedOpener ignores a custom opener even with a stale ownedOpener record", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const persistent = await makePersistent(root);
      await setConfigValue("browser.opener", ["my-editor", "--open"]);
      const ctx = baseCtx({
        persistent: { packageName: "livediff", version: "1.0.0", bin: "livediff", ...persistent },
      });
      const state: SetupState = emptySetupState();
      state.ownedOpener = ["/some/stale/node", "/some/stale/cmux-open.js"];

      const outcome = await repairOwnedOpener(ctx, state);

      expect(outcome).toBeNull();
      expect(loadConfig().browser.opener).toEqual(["my-editor", "--open"]);
    });
  });

  it("repairOwnedOpener returns null when there is nothing to repair", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const persistent = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: { packageName: "livediff", version: "1.0.0", bin: "livediff", ...persistent },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();
      await configureBrowser(ctx, "cmux", state);

      const outcome = await repairOwnedOpener(ctx, state);
      expect(outcome).toBeNull();
    });
  });

  it("discloses an active LIVEDIFF_BROWSER override on inspect and on configure", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const persistent = await makePersistent(root);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: { packageName: "livediff", version: "1.0.0", bin: "livediff", ...persistent },
        env: {
          ...defaultEnv(),
          PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}`,
          LIVEDIFF_BROWSER: "code --open-url",
        },
      });
      const state: SetupState = emptySetupState();

      const saved = await inspectSavedBrowser(ctx);
      expect(saved.environmentOverride).toBe("code --open-url");

      const result = await configureBrowser(ctx, "cmux", state);
      expect(result.detail).toContain("LIVEDIFF_BROWSER");
      expect(result.detail).toContain("takes");
    });
  });

  it("refuses to write a path inside an npx temporary cache", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const npxRoot = join(root, "_npx", "abcd1234", "node_modules", "livediff");
      const helperDir = join(npxRoot, "dist-server", "server");
      await mkdir(helperDir, { recursive: true });
      await writeFile(join(helperDir, "cmux-open.js"), "// fake\n");
      const nodeBin = join(root, "_npx", "abcd1234", "node");
      await writeFile(nodeBin, "#!/bin/sh\nexit 0\n");
      await chmod(nodeBin, 0o755);
      const cmuxDir = await makeCmuxOnPath(root);
      const ctx = baseCtx({
        persistent: {
          packageName: "livediff",
          version: "1.0.0",
          bin: "livediff",
          node: nodeBin,
          packageRoot: npxRoot,
        },
        env: { ...defaultEnv(), PATH: `${cmuxDir}:${process.env["PATH"] ?? ""}` },
      });
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "cmux", state);

      expect(result.status).toBe("failed");
      expect(result.retry).toBe("livediff setup --browser cmux");
      expect(loadConfig().browser.opener).toBeNull();
      expect(state.ownedOpener).toBeNull();
    });
  });

  it("missing cmux with an explicit choice fails rather than silently using the system browser", async () => {
    await withTempXdg(async () => {
      const root = await tmp();
      const persistent = await makePersistent(root);
      const ctx = baseCtx({
        persistent: { packageName: "livediff", version: "1.0.0", bin: "livediff", ...persistent },
        env: { ...defaultEnv(), PATH: "/nonexistent-only" },
      });
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "cmux", state, async () => null);

      expect(result.status).toBe("failed");
      expect(result.retry).toBe("livediff setup --browser cmux");
      expect(loadConfig().browser.opener).toBeNull();
    });
  });

  it("cmux is unavailable (not failed) on an unsupported platform, even without a persistent CLI", async () => {
    await withTempXdg(async () => {
      const ctx = baseCtx({ persistent: null, platform: "linux" });
      const state: SetupState = emptySetupState();

      const result = await configureBrowser(ctx, "cmux", state);

      expect(result.status).toBe("unavailable");
    });
  });

  it("cmux without a verified persistent CLI fails, not unavailable", async () => {
    await withTempXdg(async () => {
      const ctx = baseCtx({ persistent: null });
      const state: SetupState = emptySetupState();
      const result = await configureBrowser(ctx, "cmux", state);
      expect(result.status).toBe("failed");
      expect(result.detail).toContain("persistent CLI");
    });
  });
});
