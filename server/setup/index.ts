import { EXIT_ERROR, EXIT_OK } from "../constants.js";
import { adapterFor } from "./adapters/index.js";
import {
  configureBrowser,
  inspectSavedBrowser,
  repairOwnedOpener,
  type SavedBrowser,
} from "./browser.js";
import { AGENT_LABELS } from "./detect.js";
import { acquireSetupLock, adoptSetupLock, type SetupLock } from "./lock.js";
import {
  ensurePersistentCli,
  handOffSetup,
  readPackageIdentity,
  setupRetryCommand,
} from "./npm.js";
import { checkPrerequisites, offerGitHubSupport, offerGitInstall } from "./prerequisites.js";
import { chooseAgents, chooseBrowser } from "./selection.js";
import {
  emptySetupState,
  loadSetupState,
  saveSetupState,
  saveSetupStateSync,
  type SetupRunOutcome,
  type SetupState,
} from "./state.js";
import {
  SetupCancelled,
  type AdapterInspection,
  type AgentAlias,
  type BrowserChoice,
  type ComponentOutcome,
  type SetupContext,
  type SetupRequest,
} from "./types.js";

/** Exit status for a run stopped by SIGINT/SIGTERM, as shells report it. */
const EXIT_SIGNAL = 130;

export interface SetupRunReport {
  outcome: SetupRunOutcome;
  outcomes: ComponentOutcome[];
  exitCode: number;
  /** One instruction for the user's first review, shown only when core setup is ready. */
  firstUse: string | null;
  /**
   * The rest of the run happened in the newly installed CLI after `--update`; it printed its own
   * summary on the shared terminal, so this process must print nothing more.
   */
  handedOff: boolean;
}

export interface RunSetupOptions {
  /** `LIVEDIFF_SETUP_CONTINUATION` as this process received it, already removed from its env. */
  continuationToken?: string | null | undefined;
  /** `LIVEDIFF_SETUP_CLI_CHANGED` as this process received it, already removed from its env. */
  cliChanged?: boolean | undefined;
}

/** Mutable bookkeeping shared with the signal handler. */
interface Run {
  state: SetupState;
  /** A newer livediff's record: never written over. */
  readOnly: boolean;
  outcomes: ComponentOutcome[];
  /** Outcomes of explicitly requested work, where `unavailable` counts as a failure. */
  requested: Set<ComponentOutcome>;
  handingOff: boolean;
  retry: string;
}

/**
 * The whole setup run: read-only checks, decisions, then mutations — each component verified
 * and recorded on its own so a failure in one never discards another's success.
 */
export async function runSetup(
  request: SetupRequest,
  ctx: SetupContext,
  options: RunSetupOptions = {},
): Promise<SetupRunReport> {
  const identity = await readPackageIdentity();
  const lock = await takeLock(options.continuationToken ?? null);
  const run: Run = {
    state: emptySetupState(),
    readOnly: true,
    outcomes: [],
    requested: new Set(),
    handingOff: false,
    retry: setupRetryCommand(identity),
  };
  const onSignal = (): void => interrupted(run, lock);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await runLocked(request, ctx, run, lock, options.cliChanged ?? false);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await lock.release();
  }
}

async function takeLock(token: string | null): Promise<SetupLock> {
  if (token !== null && token !== "") {
    const adopted = await adoptSetupLock(token);
    if (adopted !== null) return adopted;
  }
  return acquireSetupLock();
}

/**
 * Ctrl-C outside a prompt (prompts turn it into `SetupCancelled`): keep what completed, say how
 * to resume, and free the lock. While the new CLI owns the terminal after a handoff, it handles
 * the signal and this process only waits for it.
 */
function interrupted(run: Run, lock: SetupLock): void {
  if (run.handingOff) return;
  if (!run.readOnly) {
    run.state.lastRun = { at: new Date().toISOString(), outcome: "cancelled", retry: run.retry };
    saveSetupStateSync(run.state);
  }
  lock.releaseSync();
  process.stderr.write(
    `\nSetup interrupted; completed steps were kept. Resume with: ${run.retry}\n`,
  );
  process.exit(EXIT_SIGNAL);
}

async function runLocked(
  request: SetupRequest,
  ctx: SetupContext,
  run: Run,
  lock: SetupLock,
  cliChanged: boolean,
): Promise<SetupRunReport> {
  const loaded = await loadSetupState();
  if (loaded.kind === "newer") return refuseNewerRecord(ctx, loaded.version);
  run.state = loaded.state;
  run.readOnly = false;
  if (loaded.kind === "unreadable") {
    ctx.progress.warn(`ignoring unreadable setup record (${loaded.reason}); inspecting live state`);
  }
  const { state, outcomes } = run;
  let agents: AgentAlias[] = [];

  try {
    const prerequisites = await offerGitInstall(ctx, request, await checkPrerequisites(ctx));
    outcomes.push(...prerequisites.outcomes);
    if (coreBlocked(outcomes)) return await finish(run, agents);

    agents = await chooseAgents(request, ctx, state);
    const saved = await inspectSavedBrowser(ctx, state.ownedOpener);
    const browser = await chooseBrowser(
      request,
      ctx,
      prerequisites.cmux,
      saved,
      state.cli === null,
    );
    const inspections = await inspectAgents(ctx, agents);

    const cli = await ensurePersistentCli(ctx, {
      update: request.update,
      continuation: !lock.owned,
      cliChanged,
    });
    outcomes.push(cli.outcome);
    if (cli.persistent === null) {
      outcomes.push(...needsCli(agents, browser, run.retry));
      return await finish(run, agents);
    }
    ctx.persistent = cli.persistent;
    state.cli = {
      packageName: cli.persistent.packageName,
      version: cli.persistent.version,
      bin: cli.persistent.bin,
      verifiedAt: new Date().toISOString(),
    };
    await saveSetupState(state);

    if (cli.handoff) {
      run.handingOff = true;
      const args = continuationArgs(request, agents, browser);
      const exitCode = await handOffSetup(ctx, cli.persistent, args, lock.token, cli.changed);
      return {
        outcome: exitCode === EXIT_OK ? "success" : "failed",
        outcomes,
        exitCode,
        firstUse: null,
        handedOff: true,
      };
    }

    outcomes.push(await browserStep(ctx, request, browser, saved, run));
    await saveSetupState(state);

    // Snapshotted once, before any agent in this run mutates state: an adapter's plan must see
    // what was true when the run started, not a sibling agent's update from earlier in this loop.
    const recordedBeforeRun = structuredClone(state.agents);
    const sharedSkillBeforeRun = structuredClone(state.sharedSkill);
    for (const alias of agents) {
      const inspected = inspections.get(alias);
      if (inspected === undefined) continue;
      const outcome =
        "failure" in inspected
          ? inspected.failure
          : await applyAgent(
              ctx,
              request,
              alias,
              agents,
              inspected.inspection,
              state,
              recordedBeforeRun,
              sharedSkillBeforeRun,
            );
      run.requested.add(outcome);
      outcomes.push(outcome);
      await saveSetupState(state);
    }

    if (agents.length > 0)
      outcomes.push(...(await offerGitHubSupport(ctx, request, prerequisites)));
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    await record(run, "cancelled", null);
    return {
      outcome: "cancelled",
      outcomes,
      exitCode: EXIT_ERROR,
      firstUse: null,
      handedOff: false,
    };
  }

  return finish(run, agents);
}

function refuseNewerRecord(ctx: SetupContext, version: number): SetupRunReport {
  const detail =
    `the setup record was written by a newer livediff (format ${version}). Run setup with ` +
    "that newer version; this one will not overwrite it.";
  ctx.progress.fail(detail);
  return {
    outcome: "failed",
    outcomes: [{ id: "state", label: "Setup record", status: "failed", detail, required: true }],
    exitCode: EXIT_ERROR,
    firstUse: null,
    handedOff: false,
  };
}

type Inspected = { inspection: AdapterInspection } | { failure: ComponentOutcome };

/** Inspect every selected agent before any mutation; a throwing adapter fails only itself. */
async function inspectAgents(
  ctx: SetupContext,
  agents: readonly AgentAlias[],
): Promise<Map<AgentAlias, Inspected>> {
  const inspections = new Map<AgentAlias, Inspected>();
  for (const alias of agents) {
    try {
      inspections.set(alias, { inspection: await adapterFor(alias).inspect(ctx) });
    } catch (error) {
      inspections.set(alias, {
        failure: agentFailure(alias, `could not inspect: ${messageOf(error)}`),
      });
    }
  }
  return inspections;
}

async function applyAgent(
  ctx: SetupContext,
  request: SetupRequest,
  alias: AgentAlias,
  agents: readonly AgentAlias[],
  inspection: AdapterInspection,
  state: SetupState,
  recorded: SetupState["agents"],
  sharedSkill: SetupState["sharedSkill"],
): Promise<ComponentOutcome> {
  const action = request.update ? "update" : "install";
  try {
    const adapter = adapterFor(alias);
    ctx.progress.step(`${action === "update" ? "Updating" : "Installing"} ${adapter.label}…`);
    const result = await adapter.apply(ctx, action, {
      selected: agents,
      recorded,
      sharedSkill,
      interactive: request.interactive,
      inspection,
    });
    if (result.record !== null) state.agents[alias] = result.record;
    else if (result.outcome.status !== "failed") {
      // A failure says nothing about what is still installed; only a verified absence drops it.
      delete state.agents[alias];
      pruneSharedSkillAgent(state, alias);
    }
    if (result.sharedSkill !== undefined) state.sharedSkill = result.sharedSkill;
    return result.outcome;
  } catch (error) {
    if (error instanceof SetupCancelled) throw error;
    return agentFailure(alias, messageOf(error));
  }
}

/** A dropped agent record can no longer justify skipping the shared skill install on its behalf. */
function pruneSharedSkillAgent(state: SetupState, alias: AgentAlias): void {
  if (state.sharedSkill === null) return;
  if (!state.sharedSkill.agents.includes(alias)) return;
  state.sharedSkill = {
    ...state.sharedSkill,
    agents: state.sharedSkill.agents.filter((a) => a !== alias),
  };
}

function agentFailure(alias: AgentAlias, detail: string): ComponentOutcome {
  return {
    id: `agent:${alias}`,
    label: AGENT_LABELS[alias],
    status: "failed",
    detail,
    retry: `livediff setup --agent ${alias}`,
  };
}

/** The browser line is always reported, including a preserved preference. */
async function browserStep(
  ctx: SetupContext,
  request: SetupRequest,
  choice: BrowserChoice | null,
  saved: SavedBrowser,
  run: Run,
): Promise<ComponentOutcome> {
  let outcome: ComponentOutcome;
  if (choice === null) {
    try {
      return (await repairOwnedOpener(ctx, run.state)) ?? preservedBrowser(saved);
    } catch (error) {
      return {
        id: "browser",
        label: "Browser",
        status: "failed",
        detail: `could not repair the saved cmux opener: ${messageOf(error)}`,
        retry: "livediff setup --browser cmux",
      };
    }
  }
  try {
    ctx.progress.step(`Configuring the ${choice === "cmux" ? "cmux" : "system"} browser…`);
    outcome = await configureBrowser(ctx, choice, run.state);
  } catch (error) {
    if (error instanceof SetupCancelled) throw error;
    outcome = {
      id: "browser",
      label: "Browser",
      status: "failed",
      detail: messageOf(error),
      retry: `livediff setup --browser ${choice}`,
    };
  }
  if (request.browser !== null) run.requested.add(outcome);
  return outcome;
}

function preservedBrowser(saved: SavedBrowser): ComponentOutcome {
  const override =
    saved.environmentOverride === null
      ? ""
      : `; LIVEDIFF_BROWSER=${saved.environmentOverride} overrides it in this environment`;
  if (saved.stale) {
    return {
      id: "browser",
      label: "Browser",
      status: "unavailable",
      detail:
        `${describeSaved(saved)}, but its saved opener no longer exists — run ` +
        `\`livediff setup --browser cmux\` to repair it or \`--browser system\` to stop using it${override}`,
    };
  }
  return {
    id: "browser",
    label: "Browser",
    status: "unchanged",
    detail: describeSaved(saved) + override,
  };
}

const SAVED_BROWSER_NAMES: Record<SavedBrowser["kind"], (saved: SavedBrowser) => string> = {
  none: () => "system browser",
  cmux: () => "cmux",
  "legacy-cmux": () => "cmux (legacy livediff-cmux-open helper)",
  custom: (saved) => `custom opener (${(saved.stored ?? []).join(" ")})`,
};

function describeSaved(saved: SavedBrowser): string {
  return SAVED_BROWSER_NAMES[saved.kind](saved);
}

/** Without a verified persistent CLI nothing may reference one; say what waits on it. */
function needsCli(
  agents: readonly AgentAlias[],
  browser: BrowserChoice | null,
  retry: string,
): ComponentOutcome[] {
  const outcomes: ComponentOutcome[] = agents.map((alias) => ({
    id: `agent:${alias}`,
    label: AGENT_LABELS[alias],
    status: "skipped",
    detail: "needs the persistent CLI",
    retry,
  }));
  if (browser !== null) {
    outcomes.push({
      id: "browser",
      label: "Browser",
      status: "skipped",
      detail: "needs the persistent CLI",
      retry,
    });
  }
  return outcomes;
}

/** The choices this run already made, as flags, so the handed-off CLI asks nothing again. */
export function continuationArgs(
  request: SetupRequest,
  agents: readonly AgentAlias[],
  browser: BrowserChoice | null,
): string[] {
  const args = ["--update"];
  for (const alias of agents) args.push("--agent", alias);
  if (agents.length === 0) args.push("--cli-only");
  if (browser !== null) args.push("--browser", browser);
  if (request.yes) args.push("--yes");
  if (request.json) args.push("--json");
  return args;
}

function coreBlocked(outcomes: readonly ComponentOutcome[]): boolean {
  return outcomes.some((o) => o.required === true && o.status === "failed");
}

function isFailure(outcome: ComponentOutcome, requested: ReadonlySet<ComponentOutcome>): boolean {
  if (outcome.status === "failed") return true;
  return outcome.status === "unavailable" && requested.has(outcome);
}

async function finish(run: Run, agents: readonly AgentAlias[]): Promise<SetupRunReport> {
  const failures = run.outcomes.filter((o) => isFailure(o, run.requested));
  const outcome = summarize(run.outcomes, failures.length);
  const retries = failures.flatMap((o) => (o.retry === undefined ? [] : [o.retry]));
  await record(run, outcome, retries.length === 0 ? null : [...new Set(retries)].join("\n"));
  const coreReady = !coreBlocked(run.outcomes) && run.state.cli !== null;
  return {
    outcome,
    outcomes: run.outcomes,
    exitCode: outcome === "success" ? EXIT_OK : EXIT_ERROR,
    firstUse: coreReady ? firstUse(run, agents) : null,
    handedOff: false,
  };
}

function firstUse(run: Run, agents: readonly AgentAlias[]): string {
  const integrated = agents.some((alias) => run.state.agents[alias] !== undefined);
  if (integrated) {
    return 'Open your repository in your agent and ask: "Use LiveDiff to review my changes."';
  }
  return "Run `livediff` inside a Git repository to review its changes; `livediff help` lists every command.";
}

function summarize(outcomes: readonly ComponentOutcome[], failed: number): SetupRunOutcome {
  if (failed === 0) return "success";
  const succeeded = outcomes.some(
    (o) =>
      !o.id.startsWith("prereq:") &&
      (o.status === "installed" || o.status === "updated" || o.status === "unchanged"),
  );
  return succeeded ? "partial" : "failed";
}

async function record(run: Run, outcome: SetupRunOutcome, retry: string | null): Promise<void> {
  if (run.readOnly) return;
  run.state.lastRun = { at: new Date().toISOString(), outcome, retry };
  await saveSetupState(run.state);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
