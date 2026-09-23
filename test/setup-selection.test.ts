import { test } from "vitest";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SavedBrowser } from "../server/setup/browser.js";
import { detectAgent } from "../server/setup/detect.js";
import { chooseAgents, chooseBrowser } from "../server/setup/selection.js";
import { emptySetupState, type SetupState } from "../server/setup/state.js";
import type { SetupRequest } from "../server/setup/types.js";
import { fakeContext, fakeRunner, recordingProgress, scriptedPrompter } from "./setup-fixtures.js";

const noRun = fakeRunner(() => undefined).run;

function req(overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    agents: [],
    cliOnly: false,
    browser: null,
    update: false,
    yes: false,
    json: false,
    interactive: true,
    ...overrides,
  };
}

function withRecorded(...aliases: ("claude" | "codex" | "gemini")[]): SetupState {
  const state = emptySetupState();
  for (const alias of aliases) {
    state.agents[alias] = {
      adapter: "native-plugin",
      source: "s",
      version: "1",
      paths: [],
      verifiedAt: "t",
    };
  }
  return state;
}

/** A HOME with Cursor's config dir and a PATH holding a `codex` executable. */
async function withMachine(fn: (env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "livediff-detect-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(join(bin, "gemini"), "not executable");
    await fn({ HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, ".config") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("detection finds harness executables and config directories, read-only", async () => {
  await withMachine(async (env) => {
    const ctx = fakeContext({ run: noRun, env });
    const codex = await detectAgent("codex", ctx);
    assert.equal(codex.detected, true);
    assert.equal(codex.executable, join(env["PATH"] ?? "", "codex"));
    const cursor = await detectAgent("cursor", ctx);
    assert.equal(cursor.detected, true);
    assert.equal(cursor.executable, null);
    assert.equal(cursor.configDir, join(env["HOME"] ?? "", ".cursor"));
    assert.equal((await detectAgent("gemini", ctx)).detected, false);
    assert.equal((await detectAgent("claude", ctx)).detected, false);
  });
});

test("explicit agents, --cli-only, and --update never prompt", async () => {
  const ctx = fakeContext({ run: noRun });
  const state = withRecorded("claude", "gemini");
  assert.deepEqual(await chooseAgents(req({ agents: ["codex"] }), ctx, state), ["codex"]);
  assert.deepEqual(await chooseAgents(req({ cliOnly: true }), ctx, state), []);
  assert.deepEqual(await chooseAgents(req({ update: true }), ctx, state), ["claude", "gemini"]);
  assert.deepEqual(await chooseAgents(req({ update: true }), ctx, emptySetupState()), []);
});

test("the picker lists detected agents first and preselects only recorded ones", async () => {
  await withMachine(async (env) => {
    const seen: { options: string[]; initial: string[] }[] = [];
    const prompts = scriptedPrompter({ multiselect: [["cursor", "claude"]] });
    const ctx = fakeContext({
      run: noRun,
      env,
      prompts: {
        ...prompts,
        async multiselect(message, options, initial) {
          seen.push({ options: options.map((o) => o.label), initial: [...initial] });
          return prompts.multiselect(message, options, initial);
        },
      },
    });
    const agents = await chooseAgents(req(), ctx, withRecorded("claude"));
    assert.deepEqual(agents, ["cursor", "claude"]);
    assert.deepEqual(seen[0]?.options, [
      "Codex — detected",
      "Cursor — detected",
      "Claude Code",
      "GitHub Copilot",
      "Gemini CLI",
      "OpenCode",
      "CLI only",
    ]);
    assert.deepEqual(seen[0]?.initial, ["claude"]);
  });
});

test("CLI only together with agents is asked again; an empty pick confirms CLI only", async () => {
  await withMachine(async (env) => {
    const progress = recordingProgress();
    const prompts = scriptedPrompter({
      multiselect: [["codex", "cli-only"], [], ["cli-only"]],
      confirm: [false],
    });
    const ctx = fakeContext({ run: noRun, env, progress, prompts });
    assert.deepEqual(await chooseAgents(req(), ctx, emptySetupState()), []);
    assert.equal(prompts.asked.length, 4);
    assert.ok(progress.lines.some((line) => /pick agents or CLI only, not both/.test(line)));

    const confirmOnly = scriptedPrompter({ multiselect: [[]], confirm: [true] });
    assert.deepEqual(
      await chooseAgents(
        req(),
        fakeContext({ run: noRun, env, prompts: confirmOnly }),
        emptySetupState(),
      ),
      [],
    );
    assert.match(confirmOnly.asked[1] ?? "", /Install the CLI only\?/);
  });
});

const fresh: SavedBrowser = { stored: null, kind: "none", stale: false, environmentOverride: null };

test("the browser question appears only for a fresh preference with cmux available", async () => {
  const ask = () => fakeContext({ run: noRun, prompts: scriptedPrompter({ select: ["cmux"] }) });
  assert.equal(await chooseBrowser(req(), ask(), true, fresh, true), "cmux");
  assert.equal(await chooseBrowser(req(), ask(), false, fresh, true), null);
  assert.equal(await chooseBrowser(req({ interactive: false }), ask(), true, fresh, true), null);
  assert.equal(await chooseBrowser(req(), ask(), true, fresh, false), null);
  const custom: SavedBrowser = {
    stored: ["open", "-a", "Firefox"],
    kind: "custom",
    stale: false,
    environmentOverride: null,
  };
  assert.equal(await chooseBrowser(req(), ask(), true, custom, true), null);
  const staleCmux: SavedBrowser = { ...custom, kind: "cmux", stale: true };
  assert.equal(await chooseBrowser(req(), ask(), true, staleCmux, true), null);
});

test("an explicit --browser wins without asking, even over a saved preference", async () => {
  const ctx = fakeContext({ run: noRun });
  const custom: SavedBrowser = {
    stored: ["x"],
    kind: "custom",
    stale: false,
    environmentOverride: "y",
  };
  assert.equal(await chooseBrowser(req({ browser: "system" }), ctx, true, custom, false), "system");
  assert.equal(await chooseBrowser(req({ browser: "cmux" }), ctx, false, fresh, true), "cmux");
});
