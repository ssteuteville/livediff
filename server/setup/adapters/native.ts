import type {
  AdapterAction,
  AdapterInspection,
  AdapterPlan,
  AdapterResult,
  AgentAdapter,
  AgentAlias,
  AgentRecord,
  ComponentStatus,
  SetupContext,
} from "../types.js";
import {
  agentRecord,
  checkCompatibility,
  describeRegistration,
  joinDetails,
  onPath,
  outcomeId,
  retryCommand,
  sameRegistration,
  unavailableOutcome,
  type Registration,
} from "./common.js";

export interface NativePlugin {
  version: string | null;
  enabled: boolean;
  paths: string[];
}

export interface NativeState {
  /** The same-named marketplace registration, whatever its source. */
  registration: Registration | null;
  plugin: NativePlugin | null;
}

export type NativeRead = { ok: true; state: NativeState } | { ok: false; error: string };

/** A failed step carries the single line worth showing the user. */
export type StepResult = { ok: true } | { ok: false; error: string };

/** The harness-specific commands behind one native plugin integration. */
export interface NativeHarness {
  alias: AgentAlias;
  label: string;
  /** Harness name in prose ("Claude Code"). */
  harness: string;
  executable: string;
  installHint: string;
  removeCommand: string;
  /** Completes "enable it: …". */
  enableHint: string;
  expected(ctx: SetupContext): Registration;
  read(ctx: SetupContext): Promise<NativeRead>;
  remove(ctx: SetupContext): Promise<StepResult>;
  register(ctx: SetupContext): Promise<StepResult>;
  install(ctx: SetupContext): Promise<StepResult>;
  /** Moves the registration and the installed plugin to the newest release on its ref. */
  refresh(ctx: SetupContext): Promise<StepResult>;
}

export function nativeAdapter(spec: NativeHarness): AgentAdapter {
  return {
    alias: spec.alias,
    label: spec.label,
    kind: "native-plugin",
    detect: (ctx) => onPath(ctx, [spec.executable]),
    inspect: (ctx) => inspectNative(spec, ctx),
    apply: (ctx, action, plan) => applyNative(spec, ctx, action, plan),
  };
}

async function inspectNative(spec: NativeHarness, ctx: SetupContext): Promise<AdapterInspection> {
  if (!(await onPath(ctx, [spec.executable]))) {
    return { available: false, installed: null, conflict: null };
  }
  const read = await spec.read(ctx);
  if (!read.ok) return { available: true, installed: null, conflict: null };
  const { registration, plugin } = read.state;
  const expected = spec.expected(ctx);
  return {
    available: true,
    installed:
      plugin === null
        ? null
        : {
            version: plugin.version,
            source: registration === null ? null : describeRegistration(registration),
          },
    conflict:
      registration !== null && !sameRegistration(registration, expected)
        ? conflictMessage(spec, registration, expected, ctx)
        : null,
  };
}

function conflictMessage(
  spec: NativeHarness,
  found: Registration,
  expected: Registration,
  ctx: SetupContext,
): string {
  return `LiveDiff is registered in ${spec.harness} from ${describeRegistration(found)}, not ${target(expected, ctx)}.`;
}

function target(expected: Registration, ctx: SetupContext): string {
  const where = describeRegistration(expected);
  return ctx.source.id.startsWith("local:") ? where : `the published marketplace (${where})`;
}

class NativeRun {
  readonly spec: NativeHarness;
  readonly ctx: SetupContext;
  readonly action: AdapterAction;
  readonly prior: AgentRecord | null;

  constructor(spec: NativeHarness, ctx: SetupContext, action: AdapterAction, plan: AdapterPlan) {
    this.spec = spec;
    this.ctx = ctx;
    this.action = action;
    this.prior = plan.recorded[spec.alias] ?? null;
  }

  failed(detail: string, record: AgentRecord | null, version?: string | null): AdapterResult {
    return {
      outcome: {
        id: outcomeId(this.spec.alias),
        label: this.spec.label,
        status: "failed",
        version: version ?? undefined,
        source: this.ctx.source.id,
        detail,
        retry: retryCommand([this.spec.alias], this.action === "update"),
      },
      record,
    };
  }

  succeeded(status: ComponentStatus, plugin: NativePlugin, detail?: string): AdapterResult {
    const changed = status === "installed" || status === "updated";
    return {
      outcome: {
        id: outcomeId(this.spec.alias),
        label: this.spec.label,
        status,
        version: plugin.version ?? undefined,
        source: this.ctx.source.id,
        detail: joinDetails(
          detail,
          plugin.version === null
            ? `Installed, but its version could not be read; check with \`${this.spec.executable} plugin list\`.`
            : null,
          plugin.enabled
            ? null
            : `LiveDiff is disabled in ${this.spec.harness}; to enable it, ${this.spec.enableHint}.`,
          checkCompatibility(plugin.version, this.ctx.cliVersion, this.spec.alias),
        ),
        restartRequired: changed ? true : undefined,
      },
      record: agentRecord("native-plugin", this.ctx, plugin.version, plugin.paths),
    };
  }

  /** What to keep recording when a step fails while the plugin is still installed. */
  fallback(state: NativeState): AgentRecord | null {
    if (this.prior !== null) return this.prior;
    if (state.plugin === null) return null;
    return agentRecord("native-plugin", this.ctx, state.plugin.version, state.plugin.paths);
  }
}

async function applyNative(
  spec: NativeHarness,
  ctx: SetupContext,
  action: AdapterAction,
  plan: AdapterPlan,
): Promise<AdapterResult> {
  if (!plan.inspection.available) {
    return { outcome: unavailableOutcome(spec.alias, spec.label, spec.installHint), record: null };
  }
  const run = new NativeRun(spec, ctx, action, plan);
  const read = await spec.read(ctx);
  if (!read.ok) {
    return run.failed(`Could not read ${spec.harness}'s plugins: ${read.error}`, run.prior);
  }
  let state = read.state;
  let migratedFrom: string | null = null;
  const expected = spec.expected(ctx);

  if (state.registration !== null && !sameRegistration(state.registration, expected)) {
    const conflict = conflictMessage(spec, state.registration, expected, ctx);
    const from = describeRegistration(state.registration);
    if (!plan.interactive) {
      return run.failed(
        `${conflict} Setup will not replace it unattended: rerun \`${retryCommand([spec.alias], action === "update")}\` in a terminal to migrate, or remove it yourself with \`${spec.removeCommand}\`.`,
        run.prior,
        state.plugin?.version,
      );
    }
    const confirmed = await ctx.prompts.confirm(
      `LiveDiff is registered from ${from}. Replace it with ${target(expected, ctx)}? This reinstalls the plugin.`,
      false,
    );
    if (!confirmed) {
      return run.failed(
        `${conflict} Kept it as it is, as you asked; to migrate later, run \`${retryCommand([spec.alias], action === "update")}\`.`,
        run.prior,
        state.plugin?.version,
      );
    }
    const removed = await spec.remove(ctx);
    if (!removed.ok) {
      return run.failed(
        `Could not remove the registration from ${from}: ${removed.error}`,
        run.prior,
      );
    }
    migratedFrom = from;
    state = { registration: null, plugin: null };
  }

  const migration =
    migratedFrom === null ? null : `Replaced the registration from ${migratedFrom}.`;
  if (state.registration !== null && state.plugin !== null) {
    if (action === "install") return run.succeeded("unchanged", state.plugin);
    return updateNative(run, state, state.plugin);
  }

  // Once a migration has removed the old registration nothing of ours is left to record.
  const onFailure = migratedFrom === null ? run.fallback(state) : null;
  if (state.registration === null) {
    const registered = await spec.register(ctx);
    if (!registered.ok) {
      return run.failed(
        joinDetails(migration, `Could not add the LiveDiff marketplace: ${registered.error}`) ?? "",
        onFailure,
      );
    }
  }
  const installed = await spec.install(ctx);
  if (!installed.ok) {
    return run.failed(
      joinDetails(migration, `Could not install the LiveDiff plugin: ${installed.error}`) ?? "",
      onFailure,
    );
  }
  const verified = await spec.read(ctx);
  if (!verified.ok || verified.state.plugin === null) {
    const why = verified.ok ? "it is not listed afterwards" : verified.error;
    return run.failed(
      `${spec.harness} reported the install, but it could not be verified: ${why}.`,
      onFailure,
    );
  }
  return run.succeeded("installed", verified.state.plugin, migration ?? undefined);
}

async function updateNative(
  run: NativeRun,
  state: NativeState,
  before: NativePlugin,
): Promise<AdapterResult> {
  const { spec, ctx } = run;
  const still = `LiveDiff ${before.version ?? "(version unknown)"} is still installed.`;
  const refreshed = await spec.refresh(ctx);
  if (!refreshed.ok) {
    return run.failed(
      `Could not update: ${refreshed.error}. ${still}`,
      run.fallback(state),
      before.version,
    );
  }
  const after = await spec.read(ctx);
  if (!after.ok || after.state.plugin === null) {
    const why = after.ok ? "the plugin is no longer listed" : after.error;
    return run.failed(
      `The update ran, but its result could not be verified: ${why}.`,
      run.fallback(state),
      before.version,
    );
  }
  const plugin = after.state.plugin;
  if (plugin.version === null) {
    return run.failed(
      `The update ran, but the installed version could not be read, so it cannot be confirmed; check with \`${spec.executable} plugin list\`.`,
      run.fallback(after.state),
    );
  }
  if (before.version === null) {
    return run.succeeded(
      "unchanged",
      plugin,
      `Now at ${plugin.version}; the previous version could not be read, so a change cannot be confirmed.`,
    );
  }
  if (before.version !== plugin.version) {
    return run.succeeded("updated", plugin, `${before.version} → ${plugin.version}.`);
  }
  return run.succeeded("unchanged", plugin, "Already up to date.");
}
