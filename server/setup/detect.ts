import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable, userPath } from "../executable-path.js";
import type { AgentAlias, SetupContext } from "./types.js";

export const AGENT_LABELS: Record<AgentAlias, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

const EXECUTABLES: Record<AgentAlias, readonly string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent", "cursor"],
  copilot: ["copilot"],
  gemini: ["gemini"],
  opencode: ["opencode"],
};

export interface AgentDetection {
  alias: AgentAlias;
  /** The harness's command, as the user's shell resolves it. */
  executable: string | null;
  /** Its per-user configuration directory, a hint that it has been used here. */
  configDir: string | null;
  detected: boolean;
}

/**
 * Read-only: is this harness present? Detection orders and labels the picker; it never
 * authorizes configuring anything, and an editor without a command-line tool still counts when
 * its configuration directory exists.
 */
export async function detectAgent(alias: AgentAlias, ctx: SetupContext): Promise<AgentDetection> {
  const path = userPath(ctx.env);
  let executable: string | null = null;
  for (const name of EXECUTABLES[alias]) {
    executable = await findExecutable(name, path);
    if (executable !== null) break;
  }
  const configDir = await existingDir(configDirFor(alias, ctx.env));
  return { alias, executable, configDir, detected: executable !== null || configDir !== null };
}

const CONFIG_DIRS: Record<AgentAlias, (env: NodeJS.ProcessEnv, home: string) => string> = {
  claude: (env, home) => nonEmpty(env["CLAUDE_CONFIG_DIR"]) ?? join(home, ".claude"),
  codex: (env, home) => nonEmpty(env["CODEX_HOME"]) ?? join(home, ".codex"),
  cursor: (_env, home) => join(home, ".cursor"),
  copilot: (_env, home) => join(home, ".copilot"),
  gemini: (_env, home) => join(home, ".gemini"),
  opencode: (env, home) =>
    join(nonEmpty(env["XDG_CONFIG_HOME"]) ?? join(home, ".config"), "opencode"),
};

function configDirFor(alias: AgentAlias, env: NodeJS.ProcessEnv): string {
  return CONFIG_DIRS[alias](env, nonEmpty(env["HOME"]) ?? homedir());
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

async function existingDir(path: string): Promise<string | null> {
  try {
    return (await stat(path)).isDirectory() ? path : null;
  } catch {
    return null;
  }
}
