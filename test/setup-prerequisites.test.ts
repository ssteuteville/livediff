import { test } from "vitest";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrerequisites,
  offerGitHubSupport,
  offerGitInstall,
  parseFloor,
  type PrerequisiteProbe,
  type PrerequisiteReport,
} from "../server/setup/prerequisites.js";
import type { RunOptions, SetupRequest } from "../server/setup/types.js";
import {
  failed,
  fakeContext,
  fakeRunner,
  ok,
  recordingProgress,
  scriptedPrompter,
} from "./setup-fixtures.js";

function probe(overrides: Partial<PrerequisiteProbe> = {}): PrerequisiteProbe {
  return {
    nodeVersion: "22.12.0",
    identity: async () => ({
      name: "livediff",
      version: "1.0.0",
      root: "/home/u/.npm/_npx/ab12/node_modules/livediff",
      enginesNode: ">=22.12.0",
      binName: "livediff",
    }),
    findCmux: async () => null,
    ...overrides,
  };
}

function req(overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    agents: ["codex"],
    cliOnly: false,
    browser: null,
    update: false,
    yes: false,
    json: false,
    interactive: true,
    ...overrides,
  };
}

/** A PATH directory holding the named (empty) executables, e.g. `brew` or `apt-get`. */
async function withBin(names: string[], fn: (bin: string) => Promise<void>): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), "livediff-prereq-"));
  try {
    for (const name of names) {
      await writeFile(join(bin, name), "#!/bin/sh\n");
      await chmod(join(bin, name), 0o755);
    }
    await fn(bin);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

const tools = (overrides: Record<string, () => ReturnType<typeof ok>> = {}) =>
  fakeRunner((command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const override = overrides[key];
    if (override) return override();
    if (key === "npm --version") return ok("11.0.0\n");
    if (key === "git --version") return ok("git version 2.50.1\n");
    if (key === "gh --version") return ok("gh version 2.0.0\n");
    if (key === "gh auth status") return ok();
    return undefined;
  });

test("a healthy machine passes every check and reports cmux only when it is found", async () => {
  const { run } = tools();
  const progress = recordingProgress();
  const report = await checkPrerequisites(
    fakeContext({ run, progress, env: { PATH: "/usr/bin" } }),
    probe({ findCmux: async () => "/Applications/cmux.app/Contents/Resources/bin/cmux" }),
  );
  assert.equal(report.git, true);
  assert.equal(report.gh, "ready");
  assert.equal(report.cmux, true);
  assert.ok(report.outcomes.every((o) => o.status === "unchanged"));
  assert.ok(progress.lines.includes("ok Node.js 22.12.0 supported"));
  assert.ok(progress.lines.includes("ok Git available"));

  const linux = await checkPrerequisites(
    fakeContext({ run, platform: "linux" }),
    probe({ findCmux: async () => "/usr/bin/cmux" }),
  );
  assert.equal(linux.cmux, false);
});

test("an unsupported Node is a required failure with upgrade guidance, not a crash", async () => {
  const { run } = tools();
  const report = await checkPrerequisites(fakeContext({ run }), probe({ nodeVersion: "22.3.0" }));
  const node = report.outcomes.find((o) => o.id === "prereq:node");
  assert.equal(node?.status, "failed");
  assert.equal(node?.required, true);
  assert.match(node?.detail ?? "", /22\.3\.0 is older than the supported 22\.12\.0.*Upgrade Node/);
  assert.equal(node?.retry, "npx livediff@latest setup");
  assert.equal(parseFloor(">=24"), "24.0.0");
  assert.equal(parseFloor("^22 || >=24"), null);
});

test("gh state comes from exit codes only", async () => {
  const missing = await checkPrerequisites(
    fakeContext({
      run: tools({ "gh --version": () => ({ code: -1, stdout: "", stderr: "ENOENT" }) }).run,
    }),
    probe(),
  );
  assert.equal(missing.gh, "missing");
  const signedOut = await checkPrerequisites(
    fakeContext({ run: tools({ "gh auth status": () => failed("You are not logged in") }).run }),
    probe(),
  );
  assert.equal(signedOut.gh, "unauthenticated");
});

test("missing Git on macOS with Homebrew is installed only after a yes", async () => {
  await withBin(["brew"], async (bin) => {
    let gitInstalled = false;
    const { run, calls } = fakeRunner((command) => {
      if (command === "npm") return ok("11.0.0");
      if (command === "git") return gitInstalled ? ok("git version 2.51.0") : undefined;
      if (command === "brew") {
        gitInstalled = true;
        return ok();
      }
      return undefined;
    });
    const env = { PATH: bin };
    const before = await checkPrerequisites(fakeContext({ run, env }), probe());
    assert.equal(before.git, false);
    const gitOutcome = before.outcomes.find((o) => o.id === "prereq:git");
    assert.equal(gitOutcome?.required, true);
    assert.match(gitOutcome?.detail ?? "", /brew install git/);

    const declined = await offerGitInstall(
      fakeContext({ run, env, prompts: scriptedPrompter({ confirm: [false] }) }),
      req(),
      before,
    );
    assert.equal(declined.git, false);
    assert.ok(!calls.some((c) => c.command === "brew"));

    const quiet = await offerGitInstall(
      fakeContext({ run, env }),
      req({ interactive: false }),
      before,
    );
    assert.equal(quiet.git, false);

    const accepted = await offerGitInstall(
      fakeContext({ run, env, prompts: scriptedPrompter({ confirm: [true] }) }),
      req(),
      before,
    );
    assert.equal(accepted.git, true);
    assert.equal(accepted.outcomes.find((o) => o.id === "prereq:git")?.status, "unchanged");
    const brew = calls.find((c) => c.command === "brew");
    assert.deepEqual(brew?.args, ["install", "git"]);
    assert.equal(brew?.options?.inherit, true);
  });
});

test("missing Git on Linux shows the sudo command and never runs it", async () => {
  await withBin(["apt-get"], async (bin) => {
    const { run, calls } = fakeRunner((command) => (command === "npm" ? ok("11") : undefined));
    const ctx = fakeContext({
      run,
      env: { PATH: bin },
      platform: "linux",
      prompts: scriptedPrompter({}),
    });
    const report = await offerGitInstall(ctx, req(), await checkPrerequisites(ctx, probe()));
    assert.equal(report.git, false);
    assert.match(
      report.outcomes.find((o) => o.id === "prereq:git")?.detail ?? "",
      /sudo apt-get install git/,
    );
    assert.ok(!calls.some((c) => c.command === "apt-get" || c.command === "sudo"));
  });
});

function ghReport(gh: PrerequisiteReport["gh"]): PrerequisiteReport {
  return { outcomes: [], git: true, gh, cmux: false };
}

test("GitHub support is skipped without prompts, and never installs or signs in on its own", async () => {
  await withBin(["brew"], async (bin) => {
    const { run, calls } = tools();
    const ctx = fakeContext({ run, env: { PATH: bin } });
    const [missing] = await offerGitHubSupport(
      ctx,
      req({ interactive: false }),
      ghReport("missing"),
    );
    assert.equal(missing?.status, "skipped");
    assert.match(
      missing?.detail ?? "",
      /brew install gh.*gh auth login.*local reviews work without it/,
    );
    const [signedOut] = await offerGitHubSupport(
      ctx,
      req({ interactive: false }),
      ghReport("unauthenticated"),
    );
    assert.equal(signedOut?.status, "skipped");
    assert.equal(calls.length, 0);
  });
});

test("declining GitHub support is skipped; accepting runs the native login with the terminal", async () => {
  let signedIn = false;
  const loginCalls: (RunOptions | undefined)[] = [];
  const { run } = fakeRunner((command, args, options) => {
    if (command !== "gh") return undefined;
    if (args[0] === "auth" && args[1] === "login") {
      loginCalls.push(options);
      signedIn = true;
      return ok();
    }
    if (args[0] === "auth") return signedIn ? ok() : failed("not logged in");
    return ok();
  });
  const [declined] = await offerGitHubSupport(
    fakeContext({ run, prompts: scriptedPrompter({ confirm: [false] }) }),
    req(),
    ghReport("unauthenticated"),
  );
  assert.equal(declined?.status, "skipped");
  assert.equal(loginCalls.length, 0);

  const [accepted] = await offerGitHubSupport(
    fakeContext({ run, prompts: scriptedPrompter({ confirm: [true] }) }),
    req(),
    ghReport("unauthenticated"),
  );
  assert.equal(accepted?.status, "installed");
  assert.equal(loginCalls[0]?.inherit, true);
});

test("macOS without Homebrew gets instructions for gh instead of an install offer", async () => {
  await withBin([], async (bin) => {
    await mkdir(bin, { recursive: true });
    const { run } = tools();
    const ctx = fakeContext({ run, env: { PATH: bin }, prompts: scriptedPrompter({}) });
    const [outcome] = await offerGitHubSupport(ctx, req(), ghReport("missing"));
    assert.equal(outcome?.status, "skipped");
    assert.match(outcome?.detail ?? "", /cli\.github\.com/);
  });
});
