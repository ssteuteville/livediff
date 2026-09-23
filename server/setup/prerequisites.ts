import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable, isExecutableFile, userPath } from "../executable-path.js";
import { readPackageIdentity, setupRetryCommand, type PackageIdentity } from "./npm.js";
import type { ComponentOutcome, SetupContext, SetupRequest } from "./types.js";

export interface PrerequisiteReport {
  outcomes: ComponentOutcome[];
  git: boolean;
  gh: "ready" | "unauthenticated" | "missing";
  /** A usable cmux executable on a platform where its integration is verified. */
  cmux: boolean;
}

/** What the checks read from the running process, injectable for tests. */
export interface PrerequisiteProbe {
  nodeVersion: string;
  identity: () => Promise<PackageIdentity>;
  findCmux: CmuxFinder;
}

export type CmuxFinder = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists?: (path: string) => Promise<boolean>,
) => Promise<string | null>;

const GH_LOGIN = "gh auth login";
const LOCAL_REVIEWS_NOTE = "local reviews work without it";

export function defaultProbe(): PrerequisiteProbe {
  return {
    nodeVersion: process.versions.node,
    identity: () => readPackageIdentity(),
    findCmux: findCmuxExecutable,
  };
}

/**
 * Stand-in for the cmux worker's `findCmux` in server/cmux-open.ts, with the same shape: the
 * `cmux` on the user's PATH, then the macOS app bundle — not merely an inherited CMUX_*
 * variable. Swap for that export at merge.
 */
export async function findCmuxExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean> = isExecutableFile,
): Promise<string | null> {
  if (platform !== "darwin") return null;
  const onPath = await findExecutable("cmux", userPath(env));
  if (onPath !== null) return onPath;
  const home = env["HOME"] ?? homedir();
  for (const app of ["/Applications", join(home, "Applications")]) {
    const bundled = join(app, "cmux.app", "Contents", "Resources", "bin", "cmux");
    if (await exists(bundled)) return bundled;
  }
  return null;
}

/** Read-only checks for Node, npm, Git, cmux, and `gh`. Required failures carry a retry. */
export async function checkPrerequisites(
  ctx: SetupContext,
  probe: PrerequisiteProbe = defaultProbe(),
): Promise<PrerequisiteReport> {
  const identity = await probe.identity();
  const retry = setupRetryCommand(identity);
  const env = { ...ctx.env, PATH: userPath(ctx.env) };
  const outcomes: ComponentOutcome[] = [];

  outcomes.push(checkNode(ctx, probe.nodeVersion, identity.enginesNode, retry));

  const npm = await ctx.run("npm", ["--version"], { env });
  if (npm.code === 0) {
    outcomes.push(ok(ctx, "prereq:npm", "npm", npm.stdout.trim(), "npm available"));
  } else {
    outcomes.push(
      requiredFailure(
        ctx,
        "prereq:npm",
        "npm",
        "npm is required to install the CLI. Install Node.js with npm (https://nodejs.org), then retry.",
        retry,
      ),
    );
  }

  const gitVersion = await readGitVersion(ctx, env);
  if (gitVersion !== null) {
    outcomes.push(ok(ctx, "prereq:git", "Git", gitVersion, "Git available"));
  } else {
    ctx.progress.warn("Git is not installed");
    outcomes.push(missingGit(await gitInstallPlan(ctx), retry));
  }

  const cmux = (await probe.findCmux(ctx.env, ctx.platform)) !== null;
  if (cmux) ctx.progress.ok("cmux detected");

  return { outcomes, git: gitVersion !== null, gh: await ghState(ctx, env), cmux };
}

function checkNode(
  ctx: SetupContext,
  version: string,
  engines: string | null,
  retry: string,
): ComponentOutcome {
  const floor = engines === null ? null : parseFloor(engines);
  if (floor !== null && compareVersions(version, floor) < 0) {
    return requiredFailure(
      ctx,
      "prereq:node",
      "Node.js",
      `Node.js ${version} is older than the supported ${floor}. Upgrade Node.js (https://nodejs.org, or your version manager), then retry.`,
      retry,
    );
  }
  return ok(ctx, "prereq:node", "Node.js", version, `Node.js ${version} supported`);
}

/** The lower bound of a simple `>=x.y.z` range; anything more elaborate is not checked here. */
export function parseFloor(range: string): string | null {
  const match = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  if (match === null) return null;
  return `${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readGitVersion(ctx: SetupContext, env: NodeJS.ProcessEnv): Promise<string | null> {
  const git = await ctx.run("git", ["--version"], { env });
  if (git.code !== 0) return null;
  return /(\d+\.\d+(?:\.\d+)?)/.exec(git.stdout)?.[1] ?? git.stdout.trim();
}

async function ghState(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
): Promise<PrerequisiteReport["gh"]> {
  const version = await ctx.run("gh", ["--version"], { env });
  if (version.code !== 0) return "missing";
  // Only the exit code is used: the output names accounts and scopes and is never shown.
  const auth = await ctx.run("gh", ["auth", "status"], { env });
  return auth.code === 0 ? "ready" : "unauthenticated";
}

interface InstallPlan {
  /** A command setup may run after the user confirms: no sudo, an already-installed manager. */
  runnable: readonly string[] | null;
  /** What to tell the user when setup cannot or may not run it. */
  instruction: string;
}

async function gitInstallPlan(ctx: SetupContext): Promise<InstallPlan> {
  const path = userPath(ctx.env);
  if (ctx.platform === "darwin") {
    if ((await findExecutable("brew", path)) !== null) {
      return { runnable: ["brew", "install", "git"], instruction: "brew install git" };
    }
    return { runnable: null, instruction: "xcode-select --install" };
  }
  if (ctx.platform === "linux") {
    const managers: [string, string][] = [
      ["apt-get", "sudo apt-get install git"],
      ["dnf", "sudo dnf install git"],
      ["pacman", "sudo pacman -S git"],
      ["zypper", "sudo zypper install git"],
    ];
    for (const [manager, command] of managers) {
      if ((await findExecutable(manager, path)) !== null)
        return { runnable: null, instruction: command };
    }
  }
  return { runnable: null, instruction: "install Git from https://git-scm.com/downloads" };
}

function missingGit(plan: InstallPlan, retry: string): ComponentOutcome {
  return {
    id: "prereq:git",
    label: "Git",
    status: "failed",
    required: true,
    detail: `Git is required. Install it (${plan.instruction}), then retry.`,
    retry,
  };
}

/**
 * Missing Git blocks setup, so offer the one install setup may run — through an
 * already-installed Homebrew, after the user says yes. Commands that need sudo are only shown.
 * Returns the report with Git's outcome replaced once it is really there.
 */
export async function offerGitInstall(
  ctx: SetupContext,
  request: SetupRequest,
  report: PrerequisiteReport,
): Promise<PrerequisiteReport> {
  if (report.git) return report;
  const plan = await gitInstallPlan(ctx);
  if (plan.runnable === null || !request.interactive) return report;
  const [command, ...args] = plan.runnable;
  if (command === undefined) return report;
  const accepted = await ctx.prompts.confirm(
    `Git is required. Install it now with \`${plan.runnable.join(" ")}\`?`,
    true,
  );
  if (!accepted) return report;
  ctx.progress.step(`Running ${plan.runnable.join(" ")}…`);
  const env = { ...ctx.env, PATH: userPath(ctx.env) };
  await ctx.run(command, args, { env, inherit: true });
  const version = await readGitVersion(ctx, env);
  if (version === null) return report;
  const outcomes = report.outcomes.map((outcome) =>
    outcome.id === "prereq:git"
      ? ok(ctx, "prereq:git", "Git", version, `Git ${version} installed`)
      : outcome,
  );
  return { ...report, outcomes, git: true };
}

/**
 * Optional PR support: `gh` installed and signed in. Offered only in interactive runs, and only
 * run after an explicit yes; declining — or running without prompts — is `skipped`, never a
 * failure. Tokens are never read: sign-in state comes from `gh auth status`'s exit code.
 */
export async function offerGitHubSupport(
  ctx: SetupContext,
  request: SetupRequest,
  report: PrerequisiteReport,
): Promise<ComponentOutcome[]> {
  const env = { ...ctx.env, PATH: userPath(ctx.env) };
  let gh = report.gh;

  if (gh === "missing") {
    const brew =
      ctx.platform === "darwin" && (await findExecutable("brew", env["PATH"] ?? "")) !== null;
    const instruction = brew ? "brew install gh" : "https://cli.github.com";
    if (!request.interactive || !brew) {
      return [
        githubSkipped(
          `install the GitHub CLI (${instruction}) and run \`${GH_LOGIN}\` to review pull requests; ${LOCAL_REVIEWS_NOTE}`,
        ),
      ];
    }
    const install = await ctx.prompts.confirm(
      `Install the GitHub CLI with \`brew install gh\` to review pull requests? (${LOCAL_REVIEWS_NOTE})`,
      false,
    );
    if (!install)
      return [githubSkipped(`run \`brew install gh\` and \`${GH_LOGIN}\` to enable it later`)];
    ctx.progress.step("Running brew install gh…");
    await ctx.run("brew", ["install", "gh"], { env, inherit: true });
    const installed = await ctx.run("gh", ["--version"], { env });
    if (installed.code !== 0) {
      return [
        {
          id: "github",
          label: "GitHub PR support",
          status: "failed",
          detail: "brew install gh did not install gh",
          retry: "brew install gh",
        },
      ];
    }
    gh =
      (await ctx.run("gh", ["auth", "status"], { env })).code === 0 ? "ready" : "unauthenticated";
  }

  if (gh === "unauthenticated") {
    if (!request.interactive)
      return [githubSkipped(`run \`${GH_LOGIN}\` to review pull requests; ${LOCAL_REVIEWS_NOTE}`)];
    const login = await ctx.prompts.confirm(
      `Sign in to GitHub now with \`${GH_LOGIN}\` to review pull requests? (${LOCAL_REVIEWS_NOTE})`,
      false,
    );
    if (!login) return [githubSkipped(`run \`${GH_LOGIN}\` to enable it later`)];
    await ctx.run("gh", ["auth", "login"], { env, inherit: true });
    if ((await ctx.run("gh", ["auth", "status"], { env })).code !== 0) {
      return [githubSkipped(`not signed in; run \`${GH_LOGIN}\` to enable it later`)];
    }
    return [
      { id: "github", label: "GitHub PR support", status: "installed", detail: "gh signed in" },
    ];
  }

  return [
    { id: "github", label: "GitHub PR support", status: "unchanged", detail: "gh signed in" },
  ];
}

function githubSkipped(detail: string): ComponentOutcome {
  return { id: "github", label: "GitHub PR support", status: "skipped", detail };
}

function ok(
  ctx: SetupContext,
  id: string,
  label: string,
  version: string,
  message: string,
): ComponentOutcome {
  ctx.progress.ok(message);
  return { id, label, status: "unchanged", version };
}

function requiredFailure(
  ctx: SetupContext,
  id: string,
  label: string,
  detail: string,
  retry: string,
): ComponentOutcome {
  ctx.progress.fail(detail);
  return { id, label, status: "failed", required: true, detail, retry };
}
