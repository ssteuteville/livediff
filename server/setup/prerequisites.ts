import type { ComponentOutcome, SetupContext, SetupRequest } from "./types.js";

export interface PrerequisiteReport {
  outcomes: ComponentOutcome[];
  git: boolean;
  gh: "ready" | "unauthenticated" | "missing";
  /** A usable cmux executable on a platform where its integration is verified. */
  cmux: boolean;
}

/** Task 5: read-only checks for Node, Git, cmux, and `gh`. */
export async function checkPrerequisites(ctx: SetupContext): Promise<PrerequisiteReport> {
  void ctx;
  throw new Error("not implemented: checkPrerequisites");
}

/** Task 5: optional PR support — offer installing/authenticating `gh`, never required. */
export async function offerGitHubSupport(
  ctx: SetupContext,
  request: SetupRequest,
  report: PrerequisiteReport,
): Promise<ComponentOutcome[]> {
  void ctx;
  void request;
  void report;
  throw new Error("not implemented: offerGitHubSupport");
}
