import { EXIT_ERROR, EXIT_OK } from "../constants.js";
import { adapterFor } from "./adapters/index.js";
import { configureBrowser } from "./browser.js";
import {
  acquireSetupLock,
  adoptSetupLock,
  SETUP_CONTINUATION_ENV,
  type SetupLock,
} from "./lock.js";
import { ensurePersistentCli } from "./npm.js";
import { checkPrerequisites, offerGitHubSupport } from "./prerequisites.js";
import { chooseAgents, chooseBrowser } from "./selection.js";
import { loadSetupState, saveSetupState, type SetupRunOutcome } from "./state.js";
import {
  SetupCancelled,
  type AdapterInspection,
  type AgentAlias,
  type ComponentOutcome,
  type SetupContext,
  type SetupRequest,
} from "./types.js";

/**
 * The whole setup run: read-only checks, decisions, then mutations — each component verified
 * and recorded on its own so a failure in one never discards another's success.
 */
export async function runSetup(request: SetupRequest, ctx: SetupContext): Promise<SetupRunReport> {
  const lock = await takeLock(ctx);
  try {
    return await runLocked(request, ctx);
  } finally {
    await lock.release();
  }
}

export interface SetupRunReport {
  outcome: SetupRunOutcome;
  outcomes: ComponentOutcome[];
  exitCode: number;
  /** One instruction for the user's first review, shown only when core setup is ready. */
  firstUse: string | null;
}

async function takeLock(ctx: SetupContext): Promise<SetupLock> {
  const token = ctx.env[SETUP_CONTINUATION_ENV];
  if (token !== undefined && token !== "") {
    const adopted = await adoptSetupLock(token);
    if (adopted !== null) return adopted;
  }
  return acquireSetupLock();
}

async function runLocked(request: SetupRequest, ctx: SetupContext): Promise<SetupRunReport> {
  const loaded = await loadSetupState();
  const state = loaded.state;
  if (loaded.kind === "unreadable") {
    ctx.progress.warn(`ignoring unreadable setup record (${loaded.reason}); inspecting live state`);
  }
  const outcomes: ComponentOutcome[] = [];

  try {
    const prerequisites = await checkPrerequisites(ctx);
    outcomes.push(...prerequisites.outcomes);

    const agents = await chooseAgents(request, ctx, state);
    const browser = await chooseBrowser(request, ctx, prerequisites.cmux);

    const inspections = new Map<AgentAlias, AdapterInspection>();
    for (const alias of agents) inspections.set(alias, await adapterFor(alias).inspect(ctx));

    const cli = await ensurePersistentCli(ctx, { update: request.update });
    outcomes.push(cli.outcome);
    if (cli.persistent !== null) {
      ctx.persistent = cli.persistent;
      state.cli = {
        packageName: cli.persistent.packageName,
        version: cli.persistent.version,
        bin: cli.persistent.bin,
        verifiedAt: new Date().toISOString(),
      };
    }
    if (cli.handedOff !== null) return cli.handedOff;

    if (browser !== null) outcomes.push(await configureBrowser(ctx, browser, state));

    for (const alias of agents) {
      const adapter = adapterFor(alias);
      const action = request.update ? "update" : "install";
      ctx.progress.step(`${action === "update" ? "Updating" : "Installing"} ${adapter.label}…`);
      const inspection = inspections.get(alias);
      if (inspection === undefined) continue;
      const result = await adapter.apply(ctx, action, {
        selected: agents,
        recorded: state.agents,
        sharedSkill: state.sharedSkill,
        interactive: request.interactive,
        inspection,
      });
      outcomes.push(result.outcome);
      if (result.record === null) delete state.agents[alias];
      else state.agents[alias] = result.record;
      if (result.sharedSkill !== undefined) state.sharedSkill = result.sharedSkill;
    }

    if (!request.cliOnly) outcomes.push(...(await offerGitHubSupport(ctx, request, prerequisites)));
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    await record(state, "cancelled", null);
    return { outcome: "cancelled", outcomes, exitCode: EXIT_ERROR, firstUse: null };
  }

  const outcome = summarize(outcomes);
  await record(state, outcome, retryFor(outcomes));
  const coreReady = !outcomes.some((o) => o.required === true && o.status === "failed");
  return {
    outcome,
    outcomes,
    exitCode: outcome === "success" ? EXIT_OK : EXIT_ERROR,
    firstUse: coreReady
      ? 'Open your repository in your agent and ask: "Use LiveDiff to review my changes."'
      : null,
  };
}

function summarize(outcomes: readonly ComponentOutcome[]): SetupRunOutcome {
  const failed = outcomes.filter((o) => o.status === "failed").length;
  if (failed === 0) return "success";
  const succeeded = outcomes.some(
    (o) => o.status === "installed" || o.status === "updated" || o.status === "unchanged",
  );
  return succeeded ? "partial" : "failed";
}

function retryFor(outcomes: readonly ComponentOutcome[]): string | null {
  const retries = outcomes.flatMap((o) => (o.status === "failed" && o.retry ? [o.retry] : []));
  return retries.length === 0 ? null : retries.join("\n");
}

async function record(
  state: Awaited<ReturnType<typeof loadSetupState>>["state"],
  outcome: SetupRunOutcome,
  retry: string | null,
): Promise<void> {
  state.lastRun = { at: new Date().toISOString(), outcome, retry };
  await saveSetupState(state);
}
