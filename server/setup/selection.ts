import type { SetupState } from "./state.js";
import type { AgentAlias, BrowserChoice, SetupContext, SetupRequest } from "./types.js";

/**
 * Task 5: the agents this run configures. Explicit flags win; otherwise the picker shows
 * detected agents first and configures only confirmed selections. Empty means CLI only.
 */
export async function chooseAgents(
  request: SetupRequest,
  ctx: SetupContext,
  state: SetupState,
): Promise<AgentAlias[]> {
  void request;
  void ctx;
  void state;
  throw new Error("not implemented: chooseAgents");
}

/**
 * Task 5: the browser choice to apply, or null to leave the saved preference alone. Asks only
 * when cmux is available and no preference exists yet.
 */
export async function chooseBrowser(
  request: SetupRequest,
  ctx: SetupContext,
  cmuxAvailable: boolean,
): Promise<BrowserChoice | null> {
  void request;
  void ctx;
  void cmuxAvailable;
  throw new Error("not implemented: chooseBrowser");
}
