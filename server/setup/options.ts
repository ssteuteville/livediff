import { flagValues } from "../cli-args.js";
import {
  AGENT_ALIASES,
  BROWSER_CHOICES,
  isAgentAlias,
  isBrowserChoice,
  type AgentAlias,
  type SetupRequest,
} from "./types.js";

export interface TerminalState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export type ParsedSetupOptions = { ok: true; request: SetupRequest } | { ok: false; error: string };

/**
 * Turn `livediff setup` argv into a request, rejecting anything contradictory before a single
 * mutation happens. `--agent` is read from raw argv because the shared flag map keeps only the
 * last value of a repeated flag.
 */
export function parseSetupOptions(
  rawArgv: readonly string[],
  terminal: TerminalState,
): ParsedSetupOptions {
  const has = (flag: string): boolean => rawArgv.includes(flag);
  const agentValues = flagValues(rawArgv, "--agent");
  const browserValues = flagValues(rawArgv, "--browser");

  const agents: AgentAlias[] = [];
  for (const raw of agentValues) {
    const value = raw.trim().toLowerCase();
    if (value === "") return usage("--agent requires a value");
    if (!isAgentAlias(value)) {
      return usage(`unknown agent '${raw}' — expected one of: ${AGENT_ALIASES.join(", ")}`);
    }
    if (!agents.includes(value)) agents.push(value);
  }

  if (browserValues.length > 1) return usage("--browser may only be given once");
  const browserRaw = browserValues[0];
  let browser: SetupRequest["browser"] = null;
  if (browserRaw !== undefined) {
    const value = browserRaw.trim().toLowerCase();
    if (!isBrowserChoice(value)) {
      return usage(
        `invalid --browser '${browserRaw}' — expected one of: ${BROWSER_CHOICES.join(", ")}`,
      );
    }
    browser = value;
  }

  const cliOnly = has("--cli-only");
  if (cliOnly && agents.length > 0) {
    return usage("--cli-only cannot be combined with --agent: choose agents or CLI only");
  }

  const update = has("--update");
  const yes = has("--yes");
  const json = has("--json");
  const interactive = terminal.stdinIsTTY && terminal.stdoutIsTTY && !json && !yes;
  if (!interactive && !cliOnly && agents.length === 0 && !update) {
    return usage(
      `${nonInteractiveReason(yes, json)} needs an explicit selection: pass one or more ` +
        "--agent values, --cli-only, or --update",
    );
  }

  return { ok: true, request: { agents, cliOnly, browser, update, yes, json, interactive } };
}

function nonInteractiveReason(yes: boolean, json: boolean): string {
  if (yes) return "--yes";
  if (json) return "--json";
  return "setup without a terminal";
}

function usage(error: string): ParsedSetupOptions {
  return { ok: false, error };
}
