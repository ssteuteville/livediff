import type { SetupRunReport } from "./index.js";
import type { ComponentOutcome, PersistentCli, SetupContext } from "./types.js";

export interface PersistentCliResult {
  outcome: ComponentOutcome;
  persistent: PersistentCli | null;
  /** Set when `--update` handed the rest of the run to the newly installed CLI. */
  handedOff: SetupRunReport | null;
}

/** Task 4: install or reuse the persistent npm CLI and verify it outside npx's temporary PATH. */
export async function ensurePersistentCli(
  ctx: SetupContext,
  options: { update: boolean },
): Promise<PersistentCliResult> {
  void ctx;
  void options;
  throw new Error("not implemented: ensurePersistentCli");
}
