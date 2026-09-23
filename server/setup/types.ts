/**
 * Contracts shared by the setup coordinator and its adapters. Adapters talk to the outside world
 * only through a `SetupContext`, so tests can substitute the subprocess runner, prompts, and
 * environment without touching the developer's real harness installations.
 */

export const AGENT_ALIASES = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "opencode",
] as const;

export type AgentAlias = (typeof AGENT_ALIASES)[number];

export const BROWSER_CHOICES = ["cmux", "system"] as const;

export type BrowserChoice = (typeof BROWSER_CHOICES)[number];

export function isAgentAlias(value: string): value is AgentAlias {
  return AGENT_ALIASES.some((alias) => alias === value);
}

export function isBrowserChoice(value: string): value is BrowserChoice {
  return BROWSER_CHOICES.some((choice) => choice === value);
}

/** What the user asked for, after flag parsing and before any prompt or inspection. */
export interface SetupRequest {
  /** Explicit `--agent` selections, deduplicated, in the order given. */
  agents: readonly AgentAlias[];
  cliOnly: boolean;
  browser: BrowserChoice | null;
  update: boolean;
  yes: boolean;
  json: boolean;
  /** Prompts are allowed: a TTY on both ends, and neither `--json` nor `--yes`. */
  interactive: boolean;
}

export type ComponentStatus =
  /** Newly installed and verified. */
  | "installed"
  /** Already healthy; nothing was changed. */
  | "unchanged"
  /** Moved to a newer verified version. */
  | "updated"
  /** Optional work the user declined or that did not apply. Not a failure. */
  | "skipped"
  /** Requested work that did not complete. Always makes setup exit non-zero. */
  | "failed"
  /** The capability cannot be provided here (missing harness, unsupported platform). */
  | "unavailable";

/** One line of the final summary: a verified result, never an intention. */
export interface ComponentOutcome {
  id: string;
  label: string;
  status: ComponentStatus;
  version?: string | undefined;
  source?: string | undefined;
  detail?: string | undefined;
  /** A command that retries just this component. */
  retry?: string | undefined;
  /** The harness must start a new session before the integration is visible. */
  restartRequired?: boolean | undefined;
  /** Whether a failure here blocks core readiness (Git missing) rather than one integration. */
  required?: boolean | undefined;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  /** Hand the terminal to the child (interactive logins, package-manager prompts). */
  inherit?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface RunResult {
  /** Exit code; -1 when the executable could not be started at all. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Subprocess execution as argv, never a shell string. Resolves on any exit code; never throws. */
export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string | undefined;
}

/** The narrow prompt boundary. Any cancellation rejects with `SetupCancelled`. */
export interface Prompter {
  multiselect<T extends string>(
    message: string,
    options: readonly ChoiceOption<T>[],
    initial: readonly T[],
  ): Promise<T[]>;
  select<T extends string>(message: string, options: readonly ChoiceOption<T>[]): Promise<T>;
  confirm(message: string, initial: boolean): Promise<boolean>;
}

export class SetupCancelled extends Error {
  constructor() {
    super("setup cancelled");
    this.name = "SetupCancelled";
  }
}

/** Progress goes to stderr so `--json` stdout stays parseable. */
export interface Progress {
  step(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
  info(message: string): void;
}

/**
 * Where integrations are installed from. Defaults to the published stable sources; the
 * `LIVEDIFF_SETUP_SOURCE` override points them at a local checkout for pre-release testing.
 */
export interface IntegrationSource {
  /** Human-readable identity recorded in the setup state. */
  id: string;
  claudeMarketplace: string;
  codexMarketplace: string;
  codexRef: string | null;
  skills: string;
}

export interface SetupContext {
  run: Runner;
  prompts: Prompter;
  progress: Progress;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Version of the CLI executing setup. */
  cliVersion: string;
  source: IntegrationSource;
  /**
   * The persistent `livediff` install that harnesses and the browser opener must reference.
   * Null until the npm step has verified one; nothing may be configured with a temporary path.
   */
  persistent: PersistentCli | null;
}

export interface PersistentCli {
  packageName: string;
  version: string;
  /** Absolute path of the `livediff` executable as the user's shell resolves it. */
  bin: string;
  /** Absolute path of the installed package root. */
  packageRoot: string;
  /** Absolute path of the Node executable that runs it. */
  node: string;
}

/** What an adapter found on disk and in the harness, before deciding what to do. */
export interface AdapterInspection {
  /** The harness itself (or its skills location) is available. */
  available: boolean;
  /** Present LiveDiff integration, if any. `version` is null when it cannot be read. */
  installed: { version: string | null; source: string | null } | null;
  /** A same-named registration from another source that setup must not silently replace. */
  conflict: string | null;
}

export type AdapterAction = "install" | "update";

/** The ownership facts setup records for one integration after live verification. */
export interface AgentRecord {
  adapter: AgentAdapter["kind"];
  source: string;
  version: string | null;
  paths: string[];
  verifiedAt: string;
}

export interface AdapterResult {
  outcome: ComponentOutcome;
  /**
   * The verified record after this run. Null only when live inspection shows nothing is
   * installed; a failed update of a still-present integration returns the prior record.
   */
  record: AgentRecord | null;
  /** Set when the canonical shared skill or its agent list changed. */
  sharedSkill?: SharedSkill | null | undefined;
}

export interface AgentAdapter {
  alias: AgentAlias;
  label: string;
  kind: "native-plugin" | "portable-skill";
  /** Read-only: is the harness present at all? Used to order and hint the picker. */
  detect(ctx: SetupContext): Promise<boolean>;
  inspect(ctx: SetupContext): Promise<AdapterInspection>;
  /** Install, repair, or update, then verify against live state. Never throws. */
  apply(ctx: SetupContext, action: AdapterAction, plan: AdapterPlan): Promise<AdapterResult>;
}

/** What an adapter needs to know about the rest of the run to act safely. */
export interface AdapterPlan {
  /** Every agent this run configures, so shared installs can tell who else they affect. */
  selected: readonly AgentAlias[];
  /** Ownership as recorded before this run; a hint, never proof. */
  recorded: Readonly<Record<string, AgentRecord | undefined>>;
  sharedSkill: SharedSkill | null;
  /** Prompts are allowed. When false, anything needing acknowledgement fails with a retry. */
  interactive: boolean;
  /** The inspection taken before any mutation this run. */
  inspection: AdapterInspection;
}

/** One canonical portable-skill install that several agents read. */
export interface SharedSkill {
  path: string;
  agents: AgentAlias[];
}
