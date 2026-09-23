import type { SetupState } from "./state.js";
import type { BrowserChoice, ComponentOutcome, SetupContext } from "./types.js";

/**
 * The browser preference as stored, kept apart from what is effective right now: an
 * environment override wins at runtime but is not the user's saved choice.
 */
export interface SavedBrowser {
  /** The opener argv in config.jsonc, or null for the system browser. */
  stored: readonly string[] | null;
  /**
   * `none` — no custom opener; `cmux` — the packaged helper setup configures; `legacy-cmux` —
   * the old `livediff-cmux-open` shim from the source script; `custom` — anything else, which
   * setup must never overwrite unless the user explicitly passes `--browser`.
   */
  kind: "none" | "cmux" | "legacy-cmux" | "custom";
  /** The saved cmux opener points at a helper or Node that no longer exists. */
  stale: boolean;
  /** `LIVEDIFF_BROWSER`, when it overrides the stored value. */
  environmentOverride: string | null;
}

/** Task 7: read-only inspection of the saved browser preference. */
export async function inspectSavedBrowser(ctx: SetupContext): Promise<SavedBrowser> {
  void ctx;
  throw new Error("not implemented: inspectSavedBrowser");
}

/**
 * Task 7: apply an explicit or chosen browser preference. `cmux` points `browser.opener` at the
 * packaged helper under the persistent install; `system` removes the custom opener.
 */
export async function configureBrowser(
  ctx: SetupContext,
  choice: BrowserChoice,
  state: SetupState,
): Promise<ComponentOutcome> {
  void ctx;
  void choice;
  void state;
  throw new Error("not implemented: configureBrowser");
}
