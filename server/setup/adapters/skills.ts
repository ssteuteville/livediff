import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterAction,
  AdapterInspection,
  AdapterPlan,
  AdapterResult,
  AgentAdapter,
  AgentAlias,
  ComponentStatus,
  SetupContext,
  SharedSkill,
} from "../types.js";
import { AGENT_LABELS, detectAgent } from "../detect.js";
import {
  agentRecord,
  checkCompatibility,
  describeRegistration,
  failureText,
  homeDir,
  isRecord,
  joinDetails,
  outcomeId,
  registrationFrom,
  registrationFromSpec,
  retryCommand,
  sameRegistration,
  stringField,
  unavailableOutcome,
} from "./common.js";

/** The skills installer, pinned to the version whose behavior docs/DISTRIBUTION.md records. */
export const SKILLS_INSTALLER = "skills@1.7.0";

const SKILL_NAME = "livediff";
const INSTALLER_TIMEOUT_MS = 300_000;

export type PortableAlias = "cursor" | "copilot" | "gemini" | "opencode";

interface PortableTarget {
  name: string;
  /** The installer's agent id; it rejects `copilot`. */
  installerId: string;
  installHint: string;
}

const TARGETS: Record<PortableAlias, PortableTarget> = {
  cursor: {
    name: AGENT_LABELS.cursor,
    installerId: "cursor",
    installHint: "Cursor is not installed. Install it from https://cursor.com.",
  },
  copilot: {
    name: AGENT_LABELS.copilot,
    installerId: "github-copilot",
    installHint:
      "GitHub Copilot CLI is not installed. Install it with `npm install -g @github/copilot`.",
  },
  gemini: {
    name: AGENT_LABELS.gemini,
    installerId: "gemini-cli",
    installHint:
      "Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`.",
  },
  opencode: {
    name: AGENT_LABELS.opencode,
    installerId: "opencode",
    installHint: "OpenCode is not installed. Install it from https://opencode.ai.",
  },
};

export function isPortableAlias(alias: string): alias is PortableAlias {
  return Object.hasOwn(TARGETS, alias);
}

interface SkillPaths {
  /** Skills 1.7.0 writes one real directory here for every one of the four agents. */
  skillDir: string;
  lockFile: string;
}

function skillPaths(ctx: SetupContext): SkillPaths | null {
  const home = homeDir(ctx);
  if (home === null) return null;
  const state = ctx.env["XDG_STATE_HOME"];
  const lockFile =
    state === undefined || state === ""
      ? join(home, ".agents", ".skill-lock.json")
      : join(state, "skills", ".skill-lock.json");
  return { skillDir: join(home, ".agents", "skills", SKILL_NAME), lockFile };
}

interface SkillState {
  present: boolean;
  version: string | null;
  /** The installer's ownership record; it writes one only for GitHub `owner/repo` sources. */
  lock: { source: string; ref: string | null } | null;
}

async function readSkill(paths: SkillPaths): Promise<SkillState> {
  let manifest: string | null = null;
  try {
    manifest = await readFile(join(paths.skillDir, "SKILL.md"), "utf8");
  } catch {
    manifest = null;
  }
  return {
    present: manifest !== null,
    version: manifest === null ? null : skillVersion(manifest),
    lock: await readLock(paths.lockFile),
  };
}

async function readLock(path: string): Promise<SkillState["lock"]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  const skills = isRecord(raw) && isRecord(raw["skills"]) ? raw["skills"] : null;
  const entry = skills?.[SKILL_NAME];
  if (!isRecord(entry)) return null;
  const source = stringField(entry, "source");
  return source === null ? null : { source, ref: stringField(entry, "ref") };
}

/** `metadata.version` from SKILL.md frontmatter, block or inline form; null when absent. */
export function skillVersion(manifest: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(manifest)?.[1];
  if (frontmatter === undefined) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const inline = /^metadata:\s*\{(.*)\}\s*$/.exec(line)?.[1];
    if (inline !== undefined) {
      const version = /(?:^|,)\s*version:\s*([^,}]+)/.exec(inline)?.[1];
      return version === undefined ? null : scalar(version);
    }
    if (!/^metadata:\s*(?:#.*)?$/.test(line)) continue;
    for (let nested = index + 1; nested < lines.length; nested++) {
      const child = lines[nested] ?? "";
      if (!/^\s/.test(child)) break;
      const version = /^\s+version:\s*(.+)$/.exec(child)?.[1];
      if (version !== undefined) return scalar(version);
    }
    return null;
  }
  return null;
}

function scalar(raw: string): string | null {
  const value = raw.replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  const text = quoted?.[2] ?? value;
  return text === "" ? null : text;
}

function conflictOf(ctx: SetupContext, paths: SkillPaths, state: SkillState): string | null {
  if (!state.present) return null;
  const expected = registrationFromSpec(ctx.source.skills);
  // A local-path install writes no lock entry, so its ownership cannot be told apart.
  if (expected.kind === "path") return null;
  const wanted = describeRegistration(expected);
  if (state.lock === null) {
    return `A livediff skill already exists at ${paths.skillDir}, with no installer record showing it came from ${wanted}.`;
  }
  const found = registrationFrom(state.lock.source, state.lock.ref);
  if (sameRegistration(found, expected)) return null;
  return `The livediff skill at ${paths.skillDir} was installed from ${describeRegistration(found)}, not ${wanted}.`;
}

async function detectTarget(ctx: SetupContext, alias: PortableAlias): Promise<boolean> {
  return (await detectAgent(alias, ctx)).detected;
}

function names(aliases: readonly AgentAlias[]): string {
  return aliases.map((alias) => AGENT_LABELS[alias]).join(", ");
}

function union(...lists: readonly (readonly AgentAlias[])[]): AgentAlias[] {
  const merged: AgentAlias[] = [];
  for (const list of lists)
    for (const alias of list) if (!merged.includes(alias)) merged.push(alias);
  return merged;
}

/** The single installer operation one setup run performs on behalf of every portable agent. */
type SharedRun =
  | { kind: "failed"; detail: string; retry: string; version: string | null }
  | { kind: "skipped"; detail: string }
  | {
      kind: "done";
      paths: SkillPaths;
      before: SkillState;
      after: SkillState;
      ranInstaller: boolean;
      replaced: string | null;
      agents: AgentAlias[];
      /** Disclosures that belong on the summary once, not once per agent. */
      notes: string[];
      leader: AgentAlias;
    };

/**
 * One installer run serves all four agents (they share a directory), so the first portable
 * adapter applied in a setup run performs it for every selected portable agent and the rest
 * report from its result. Keyed by the run's `selected` array, which the coordinator passes
 * unchanged to every adapter in one run and builds afresh for the next, so runs never share.
 */
const sharedRuns = new WeakMap<readonly AgentAlias[], Promise<SharedRun>>();

function sharedRun(
  ctx: SetupContext,
  action: AdapterAction,
  plan: AdapterPlan,
  self: PortableAlias,
): Promise<SharedRun> {
  const existing = sharedRuns.get(plan.selected);
  if (existing !== undefined) return existing;
  const started = performShared(ctx, action, plan, self);
  sharedRuns.set(plan.selected, started);
  return started;
}

async function performShared(
  ctx: SetupContext,
  action: AdapterAction,
  plan: AdapterPlan,
  self: PortableAlias,
): Promise<SharedRun> {
  const update = action === "update";
  const paths = skillPaths(ctx);
  if (paths === null) {
    return {
      kind: "failed",
      detail: "Could not find your home directory (HOME is not set).",
      retry: retryCommand([self], update),
      version: null,
    };
  }
  const targets: PortableAlias[] = [self];
  for (const alias of plan.selected) {
    if (isPortableAlias(alias) && !targets.includes(alias) && (await detectTarget(ctx, alias))) {
      targets.push(alias);
    }
  }
  const previous = plan.sharedSkill?.agents ?? [];
  const candidates = previous.filter((alias) => !plan.selected.includes(alias));
  // A harness that is no longer detected cannot object to being updated, so it must not be able
  // to block `--update --yes` forever just because it is still listed from an earlier run.
  const affected: AgentAlias[] = [];
  for (const alias of candidates) {
    if (!isPortableAlias(alias) || (await detectTarget(ctx, alias))) affected.push(alias);
  }
  const retry = retryCommand(union(targets, update ? affected : []), update);
  const before = await readSkill(paths);
  const expected = registrationFromSpec(ctx.source.skills);

  const conflict = conflictOf(ctx, paths, before);
  if (conflict !== null) {
    if (!plan.interactive) {
      return {
        kind: "failed",
        detail: `${conflict} Setup will not replace it unattended: rerun \`${retry}\` in a terminal to replace it.`,
        retry,
        version: before.version,
      };
    }
    const replace = await ctx.prompts.confirm(
      `${conflict} Replace it with ${describeRegistration(expected)}? Every agent that reads ${paths.skillDir} will use the new copy.`,
      false,
    );
    if (!replace) {
      return {
        kind: "failed",
        detail: `${conflict} Kept it as it is, as you asked.`,
        retry,
        version: before.version,
      };
    }
  }

  const changesFiles = before.present && (update || conflict !== null);
  if (changesFiles && affected.length > 0) {
    if (!plan.interactive) {
      return {
        kind: "failed",
        detail: `Updating the LiveDiff skill also updates it for ${names(affected)}, which share ${paths.skillDir}. Include every affected agent to go ahead.`,
        retry,
        version: before.version,
      };
    }
    const proceed = await ctx.prompts.confirm(
      `Updating the LiveDiff skill also updates it for: ${names(affected)}. Continue?`,
      true,
    );
    if (!proceed) {
      return {
        kind: "skipped",
        detail: `Kept the LiveDiff skill at ${before.version ?? "its current version"}; updating it would also change ${names(affected)}.`,
      };
    }
  }

  const installerIds = union(targets, changesFiles ? affected : [])
    .filter(isPortableAlias)
    .map((alias) => TARGETS[alias].installerId);
  const args = installerArgs(ctx, action, before, conflict !== null, installerIds);
  if (args !== null) {
    const result = await ctx.run("npx", ["-y", SKILLS_INSTALLER, ...args], {
      env: ctx.env,
      timeoutMs: INSTALLER_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const still = before.present
        ? ` LiveDiff skill ${before.version ?? "(version unknown)"} is still installed.`
        : "";
      return {
        kind: "failed",
        detail: `The skills installer failed: ${failureText(result)}.${still}`,
        retry,
        version: before.version,
      };
    }
  }

  const after = await readSkill(paths);
  const unverified = verificationProblem(ctx, paths, after);
  if (unverified !== null)
    return { kind: "failed", detail: unverified, retry, version: after.version };

  const notes: string[] = [];
  if (plan.selected.includes("codex") || plan.recorded["codex"] !== undefined) {
    notes.push(
      `Codex also lists this skill from ${paths.skillDir} alongside its native LiveDiff plugin.`,
    );
  }
  return {
    kind: "done",
    paths,
    before,
    after,
    ranInstaller: args !== null,
    replaced: conflict === null ? null : conflict,
    agents: union(previous, targets, changesFiles ? affected : []),
    notes,
    leader: self,
  };
}

/** Null when the healthy shared skill already serves the new agents and nothing must change. */
function installerArgs(
  ctx: SetupContext,
  action: AdapterAction,
  before: SkillState,
  replacing: boolean,
  installerIds: readonly string[],
): string[] | null {
  const add = [
    "add",
    ctx.source.skills,
    "--skill",
    SKILL_NAME,
    "-g",
    "-a",
    ...installerIds,
    "-y",
    "--json",
  ];
  if (!before.present || replacing) return add;
  if (action === "install") return null;
  // `update` reinstalls from the lock entry, which the installer writes only for GitHub sources;
  // anything else would report "no installed skills found" and change nothing.
  return registrationFromSpec(ctx.source.skills).kind === "repo" && before.lock !== null
    ? ["update", SKILL_NAME, "-g", "-y"]
    : add;
}

function verificationProblem(
  ctx: SetupContext,
  paths: SkillPaths,
  after: SkillState,
): string | null {
  if (!after.present) {
    return `The skills installer finished, but ${join(paths.skillDir, "SKILL.md")} does not exist.`;
  }
  const conflict = conflictOf(ctx, paths, after);
  return conflict === null
    ? null
    : `The skill was written, but its installer record does not match: ${conflict}`;
}

function outcomeFor(
  alias: PortableAlias,
  ctx: SetupContext,
  plan: AdapterPlan,
  shared: SharedRun,
): AdapterResult {
  const label = `${TARGETS[alias].name} skill`;
  const prior = plan.recorded[alias] ?? null;
  const base = { id: outcomeId(alias), label, source: ctx.source.id };
  if (shared.kind === "failed") {
    return {
      outcome: {
        ...base,
        status: "failed",
        version: shared.version ?? undefined,
        detail: shared.detail,
        retry: shared.retry,
      },
      record: prior,
    };
  }
  if (shared.kind === "skipped") {
    return { outcome: { ...base, status: "skipped", detail: shared.detail }, record: prior };
  }
  const { before, after } = shared;
  const status = statusFor(alias, plan, shared);
  const changed = status === "installed" || status === "updated";
  const sharedSkill: SharedSkill = { path: shared.paths.skillDir, agents: shared.agents };
  return {
    outcome: {
      ...base,
      status,
      version: after.version ?? undefined,
      detail: joinDetails(
        status === "updated" ? `${before.version ?? "?"} → ${after.version ?? "?"}.` : null,
        shared.replaced === null || alias !== shared.leader
          ? null
          : `Replaced the previous copy. ${shared.replaced}`,
        after.version === null
          ? "Installed, but the skill's version could not be read from SKILL.md."
          : null,
        ...(alias === shared.leader ? shared.notes : []),
        checkCompatibility(after.version, ctx.cliVersion, alias),
      ),
      restartRequired: changed ? true : undefined,
    },
    record: agentRecord("portable-skill", ctx, after.version, [shared.paths.skillDir]),
    sharedSkill,
  };
}

function statusFor(
  alias: PortableAlias,
  plan: AdapterPlan,
  shared: Extract<SharedRun, { kind: "done" }>,
): ComponentStatus {
  const { before, after } = shared;
  if (shared.ranInstaller && !before.present) return "installed";
  if (
    shared.ranInstaller &&
    before.version !== null &&
    after.version !== null &&
    before.version !== after.version
  ) {
    return "updated";
  }
  if (shared.replaced !== null) return "installed";
  const served =
    plan.recorded[alias] !== undefined || (plan.sharedSkill?.agents.includes(alias) ?? false);
  return served ? "unchanged" : "installed";
}

async function inspectPortable(
  alias: PortableAlias,
  ctx: SetupContext,
): Promise<AdapterInspection> {
  const paths = skillPaths(ctx);
  if (paths === null || !(await detectTarget(ctx, alias))) {
    return { available: false, installed: null, conflict: null };
  }
  const state = await readSkill(paths);
  return {
    available: true,
    installed: state.present
      ? {
          version: state.version,
          source:
            state.lock === null
              ? null
              : describeRegistration(registrationFrom(state.lock.source, state.lock.ref)),
        }
      : null,
    conflict: conflictOf(ctx, paths, state),
  };
}

export function portableSkillAdapter(alias: PortableAlias): AgentAdapter {
  const target = TARGETS[alias];
  return {
    alias,
    label: `${target.name} skill`,
    kind: "portable-skill",
    detect: (ctx) => detectTarget(ctx, alias),
    inspect: (ctx) => inspectPortable(alias, ctx),
    apply: async (ctx, action, plan) => {
      if (!plan.inspection.available) {
        return {
          outcome: unavailableOutcome(alias, `${target.name} skill`, target.installHint),
          record: null,
        };
      }
      return outcomeFor(alias, ctx, plan, await sharedRun(ctx, action, plan, alias));
    },
  };
}
