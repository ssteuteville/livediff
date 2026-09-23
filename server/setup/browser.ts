import type { SetupState } from "./state.js";
import type { BrowserChoice, ComponentOutcome, SetupContext } from "./types.js";

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
