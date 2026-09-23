import type { AgentAdapter, AgentAlias } from "../types.js";

/** Task 6: the adapter that installs and verifies LiveDiff for one agent alias. */
export function adapterFor(alias: AgentAlias): AgentAdapter {
  throw new Error(`not implemented: adapter for ${alias}`);
}
