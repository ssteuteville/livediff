import type { SavedBrowser } from "./browser.js";
import { AGENT_LABELS, detectAgent } from "./detect.js";
import type { SetupState } from "./state.js";
import {
  AGENT_ALIASES,
  isAgentAlias,
  type AgentAlias,
  type BrowserChoice,
  type ChoiceOption,
  type SetupContext,
  type SetupRequest,
} from "./types.js";

const CLI_ONLY = "cli-only";
type Pick = AgentAlias | typeof CLI_ONLY;

/**
 * The agents this run configures. Explicit flags win; `--update` alone means the recorded
 * agents; otherwise one picker, detected agents first, with nothing preselected except agents
 * setup already manages. Detection never selects anything. Empty means CLI only.
 */
export async function chooseAgents(
  request: SetupRequest,
  ctx: SetupContext,
  state: SetupState,
): Promise<AgentAlias[]> {
  if (request.agents.length > 0) return [...request.agents];
  if (request.cliOnly) return [];
  const recorded = AGENT_ALIASES.filter((alias) => state.agents[alias] !== undefined);
  if (request.update) return recorded;
  if (!request.interactive) {
    // parseSetupOptions refuses this combination; reaching it is a bug, not a reason to hang.
    throw new Error("setup needs --agent, --cli-only, or --update when it cannot prompt");
  }

  const detections = await Promise.all(AGENT_ALIASES.map((alias) => detectAgent(alias, ctx)));
  const detected = detections.filter((d) => d.detected).map((d) => d.alias);
  if (detected.length > 0) {
    ctx.progress.ok(`${listLabels(detected)} detected`);
  }
  const options = pickerOptions(detected);

  for (;;) {
    const picked = await ctx.prompts.multiselect<Pick>(
      "Which agents should LiveDiff integrate with?",
      options,
      recorded,
    );
    const agents = picked.filter(isAgentAlias);
    if (picked.includes(CLI_ONLY) && agents.length > 0) {
      ctx.progress.warn(
        "CLI only means no agent integrations — pick agents or CLI only, not both.",
      );
      continue;
    }
    if (agents.length > 0) return agents;
    if (picked.includes(CLI_ONLY)) return [];
    if (await ctx.prompts.confirm("No agents selected. Install the CLI only?", true)) return [];
  }
}

function pickerOptions(detected: readonly AgentAlias[]): ChoiceOption<Pick>[] {
  const ordered = [...detected, ...AGENT_ALIASES.filter((alias) => !detected.includes(alias))];
  const options: ChoiceOption<Pick>[] = ordered.map((alias) => ({
    value: alias,
    label: detected.includes(alias) ? `${AGENT_LABELS[alias]} — detected` : AGENT_LABELS[alias],
  }));
  options.push({ value: CLI_ONLY, label: "CLI only", hint: "no agent integration" });
  return options;
}

function listLabels(aliases: readonly AgentAlias[]): string {
  const labels = aliases.map((alias) => AGENT_LABELS[alias]);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1) ?? ""}`;
}

/**
 * The browser choice to apply, or null to leave the saved preference alone. An explicit flag
 * always wins. Otherwise ask only on a fresh preference, when cmux is really available and a
 * prompt is allowed; any stored preference — even an unusable one — is preserved. The system
 * browser is stored as the absence of an opener, so after setup has once installed the CLI
 * (`firstRun` false) an empty preference is a choice too, not an invitation to ask again.
 */
export async function chooseBrowser(
  request: SetupRequest,
  ctx: SetupContext,
  cmuxAvailable: boolean,
  saved: SavedBrowser,
  firstRun: boolean,
): Promise<BrowserChoice | null> {
  if (request.browser !== null) return request.browser;
  if (saved.kind !== "none" || !firstRun || !cmuxAvailable || !request.interactive) return null;
  return ctx.prompts.select<BrowserChoice>(
    "Where should LiveDiff open? This applies to all your agents.",
    [
      { value: "cmux", label: "cmux browser — detected", hint: "recommended" },
      { value: "system", label: "System browser" },
    ],
  );
}
