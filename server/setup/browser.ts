import { access, constants as fsConstants } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  environmentNameForKey,
  setConfigValue,
  storedBrowserOpener,
  unsetConfigValue,
} from "../config.js";
import { findCmux } from "../cmux-open.js";
import type { SetupState } from "./state.js";
import type { BrowserChoice, ComponentOutcome, PersistentCli, SetupContext } from "./types.js";

const CMUX_HELPER_RELATIVE = join("dist-server", "server", "cmux-open.js");
const LEGACY_SHIM_NAME = "livediff-cmux-open";

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

function cmuxOpenerArgv(persistent: PersistentCli): string[] {
  return [persistent.node, join(persistent.packageRoot, CMUX_HELPER_RELATIVE)];
}

function classifyOpener(argv: readonly string[] | null): SavedBrowser["kind"] {
  if (argv === null) return "none";
  if (argv.length === 2 && argv[1] !== undefined && argv[1].endsWith(CMUX_HELPER_RELATIVE)) {
    return "cmux";
  }
  if (argv.length === 1 && argv[0] !== undefined && basename(argv[0]) === LEGACY_SHIM_NAME) {
    return "legacy-cmux";
  }
  return "custom";
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Staleness for the two kinds setup owns/recognizes; `none`/`custom` are never stale. */
async function isStaleOpener(
  kind: "cmux" | "legacy-cmux",
  argv: readonly string[],
): Promise<boolean> {
  if (kind === "legacy-cmux") {
    const shim = argv[0];
    if (shim === undefined) return true;
    return !(await isExecutable(shim));
  }
  const [node, helper] = argv;
  if (node === undefined || helper === undefined) return true;
  const [nodeOk, helperOk] = await Promise.all([isExecutable(node), isPresent(helper)]);
  return !nodeOk || !helperOk;
}

function arraysEqual(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Refuse to persist a path that lives inside an npx temporary cache. */
function isInNpxCache(path: string): boolean {
  return path.split(sep).includes("_npx");
}

function environmentOverrideValue(): string | null {
  const name = environmentNameForKey("browser.opener");
  if (name === null) return null;
  return process.env[name] ?? null;
}

function withEnvironmentNote(detail: string): string {
  const override = environmentOverrideValue();
  if (override === null) return detail;
  return (
    `${detail} The LIVEDIFF_BROWSER environment override ("${override}") currently takes ` +
    "precedence over this saved preference."
  );
}

/** Read-only inspection of the saved browser preference. */
export async function inspectSavedBrowser(ctx: SetupContext): Promise<SavedBrowser> {
  void ctx; // config.jsonc and LIVEDIFF_BROWSER are read from the real environment, like config.ts.
  const stored = storedBrowserOpener();
  const kind = classifyOpener(stored);
  const stale =
    (kind === "cmux" || kind === "legacy-cmux") && stored !== null
      ? await isStaleOpener(kind, stored)
      : false;
  return { stored, kind, stale, environmentOverride: environmentOverrideValue() };
}

const RETRY_CMUX = "livediff setup --browser cmux";

function outcome(partial: Omit<ComponentOutcome, "id" | "label">): ComponentOutcome {
  return { id: "browser", label: "Browser", ...partial };
}

/**
 * Apply an explicit or chosen browser preference. `cmux` points `browser.opener` at the packaged
 * helper under the persistent install; `system` removes the custom opener. Never throws for
 * expected failures — those come back as `status: "failed"` with a targeted retry command.
 *
 * `findCmuxImpl` is an optional seam (defaulting to the real `findCmux`) purely for tests: on a
 * machine that has cmux installed at the standard macOS location — which real dev machines,
 * including the one this was written on, do — there is no way to make the real filesystem report
 * "cmux is missing" to exercise the explicit `--browser cmux` failure path. Every real caller gets
 * the real lookup; only tests pass a fake one.
 */
export async function configureBrowser(
  ctx: SetupContext,
  choice: BrowserChoice,
  state: SetupState,
  findCmuxImpl: typeof findCmux = findCmux,
): Promise<ComponentOutcome> {
  if (choice === "system") return configureSystem(state);
  return configureCmux(ctx, state, findCmuxImpl);
}

async function configureSystem(state: SetupState): Promise<ComponentOutcome> {
  // Explicit system choice removes even a custom opener — the user asked for it deliberately.
  const removed = await unsetConfigValue("browser.opener");
  state.ownedOpener = null;
  if (!removed) {
    return outcome({
      status: "unchanged",
      detail: withEnvironmentNote("Already using the system browser."),
    });
  }
  return outcome({
    status: "updated",
    detail: withEnvironmentNote("Removed the configured browser opener; using the system browser."),
  });
}

async function configureCmux(
  ctx: SetupContext,
  state: SetupState,
  findCmuxImpl: typeof findCmux,
): Promise<ComponentOutcome> {
  if (ctx.persistent === null) {
    return outcome({
      status: "failed",
      detail: "cmux needs the persistent CLI; retry after it installs.",
      retry: RETRY_CMUX,
    });
  }
  if (ctx.platform !== "darwin") {
    return outcome({
      status: "unavailable",
      detail: `cmux browser integration is only supported on macOS currently (platform: ${ctx.platform}).`,
    });
  }
  const desired = cmuxOpenerArgv(ctx.persistent);
  if (desired.some(isInNpxCache)) {
    return outcome({
      status: "failed",
      detail:
        "refusing to save a browser opener path inside a temporary npx cache; install a " +
        "persistent CLI first.",
      retry: RETRY_CMUX,
    });
  }
  const cmux = await findCmuxImpl(ctx.env, ctx.platform);
  if (cmux === null) {
    return outcome({
      status: "failed",
      detail: "cmux was not found on PATH or in /Applications; install cmux and retry.",
      retry: RETRY_CMUX,
    });
  }

  const stored = storedBrowserOpener();
  const kind = classifyOpener(stored);
  if (kind === "cmux" && arraysEqual(stored, desired)) {
    state.ownedOpener = desired;
    return outcome({
      status: "unchanged",
      detail: withEnvironmentNote("cmux already configured."),
    });
  }

  await setConfigValue("browser.opener", desired);
  state.ownedOpener = desired;

  if (kind === "legacy-cmux" && stored !== null) {
    const shim = stored[0];
    return outcome({
      status: "updated",
      detail: withEnvironmentNote(
        `Migrated from the legacy shim at ${shim} to the packaged cmux helper. ` +
          `The old shim was left in place; remove it manually if you like.`,
      ),
    });
  }

  const status = stored === null ? "installed" : "updated";
  return outcome({ status, detail: withEnvironmentNote("Configured cmux as the browser opener.") });
}

/**
 * Reruns: rewrite an owned cmux opener whose path has gone stale or no longer matches the current
 * persistent install (a new version-manager Node, a moved package root). Returns null when
 * nothing applies — including every custom opener, which this never touches.
 */
export async function repairOwnedOpener(
  ctx: SetupContext,
  state: SetupState,
): Promise<ComponentOutcome | null> {
  if (ctx.persistent === null) return null;
  const stored = storedBrowserOpener();
  if (stored === null) return null;
  const kind = classifyOpener(stored);
  const owns = kind === "cmux" || arraysEqual(stored, state.ownedOpener);
  if (!owns) return null;

  const desired = cmuxOpenerArgv(ctx.persistent);
  if (desired.some(isInNpxCache)) return null;

  const stale = kind === "cmux" ? await isStaleOpener("cmux", stored) : true;
  const matchesDesired = arraysEqual(stored, desired);
  if (!stale && matchesDesired) return null;

  await setConfigValue("browser.opener", desired);
  state.ownedOpener = desired;
  return outcome({
    status: "updated",
    detail: withEnvironmentNote(
      "Repaired the cmux browser opener to point at the current install.",
    ),
  });
}
