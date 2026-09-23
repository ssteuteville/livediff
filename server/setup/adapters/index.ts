import type { AgentAdapter, AgentAlias } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { portableSkillAdapter } from "./skills.js";

const ADAPTERS: Record<AgentAlias, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: portableSkillAdapter("cursor"),
  copilot: portableSkillAdapter("copilot"),
  gemini: portableSkillAdapter("gemini"),
  opencode: portableSkillAdapter("opencode"),
};

/** The adapter that installs and verifies LiveDiff for one agent alias. */
export function adapterFor(alias: AgentAlias): AgentAdapter {
  return ADAPTERS[alias];
}
