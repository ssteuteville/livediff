import { access, constants as fsConstants } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { ENV } from "../constants.js";
import { setConfigValue, storedBrowserOpener, unsetConfigValue } from "../config.js";
import { findCmux } from "../cmux-open.js";
import type { SetupState } from "./state.js";
import type { BrowserChoice, ComponentOutcome, PersistentCli, SetupContext } from "./types.js";

const CMUX_HELPER_SEGMENTS = ["dist-server", "server", "cmux-open.js"];
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
  return [persistent.node, join(persistent.packageRoot, ...CMUX_HELPER_SEGMENTS)];
}

function arraysEqual(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * True only for a helper path that actually lives under an installed package's
 * `node_modules/<name>/dist-server/server/cmux-open.js` — matched on real path segments, so a
 * dev checkout's `.../dist-server/server/cmux-open.js` (no `node_modules` ancestor) or a
 * differently-named `.../my-dist-server/...` (wrong segment, not a suffix match) both fail.
 */
function isPackagedCmuxHelperPath(path: string): boolean {
  const segments = path.split(sep);
  const tail = segments.slice(-CMUX_HELPER_SEGMENTS.length);
  if (!arraysEqual(tail, CMUX_HELPER_SEGMENTS)) return false;
  return segments.slice(0, -CMUX_HELPER_SEGMENTS.length).includes("node_modules");
}

/**
 * An opener is `cmux` (setup-owned) only when it matches what setup itself last wrote, or when
 * its helper path has the shape of a real packaged install. Everything else — including a
 * source checkout's own `dist-server` — is `custom`, and repair must never touch it.
 */
function classifyOpener(
  argv: readonly string[] | null,
  ownedOpener: readonly string[] | null = null,
): SavedBrowser["kind"] {
  if (argv === null) return "none";
  if (arraysEqual(argv, ownedOpener)) return "cmux";
  if (argv.length === 2 && argv[1] !== undefined && isPackagedCmuxHelperPath(argv[1])) {
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

/** Refuse to persist a path that lives inside an npx temporary cache. */
function isInNpxCache(path: string): boolean {
  return path.split(sep).includes("_npx");
}

function environmentOverrideValue(env: NodeJS.ProcessEnv): string | null {
  return env[ENV.BROWSER] ?? null;
}

function withEnvironmentNote(env: NodeJS.ProcessEnv, detail: string): string {
  const override = environmentOverrideValue(env);
  if (override === null) return detail;
  return (
    `${detail} The LIVEDIFF_BROWSER environment override ("${override}") currently takes ` +
    "precedence over this saved preference."
  );
}

/**
 * Read-only inspection of the saved browser preference. `ownedOpener` is optional (defaults to
 * null) so this stays callable without a `SetupState` handy; passing it lets a relocated-but-
 * still-owned opener classify as `cmux` even if its path no longer has the packaged shape.
 */
export async function inspectSavedBrowser(
  ctx: SetupContext,
  ownedOpener: readonly string[] | null = null,
): Promise<SavedBrowser> {
  const stored = storedBrowserOpener();
  const kind = classifyOpener(stored, ownedOpener);
  const stale =
    (kind === "cmux" || kind === "legacy-cmux") && stored !== null
      ? await isStaleOpener(kind, stored)
      : false;
  return { stored, kind, stale, environmentOverride: environmentOverrideValue(ctx.env) };
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
 * `findCmuxImpl` defaults to the real `findCmux` and exists only as a test seam: a machine that
 * has cmux installed at the standard macOS location can't otherwise be made to report "cmux is
 * missing" for the explicit-failure test below.
 */
export async function configureBrowser(
  ctx: SetupContext,
  choice: BrowserChoice,
  state: SetupState,
  findCmuxImpl: typeof findCmux = findCmux,
): Promise<ComponentOutcome> {
  if (choice === "system") return configureSystem(ctx.env, state);
  return configureCmux(ctx, state, findCmuxImpl);
}

async function configureSystem(
  env: NodeJS.ProcessEnv,
  state: SetupState,
): Promise<ComponentOutcome> {
  // Explicit system choice removes even a custom opener — the user asked for it deliberately.
  const removed = await unsetConfigValue("browser.opener");
  state.ownedOpener = null;
  if (!removed) {
    return outcome({
      status: "unchanged",
      detail: withEnvironmentNote(env, "Already using the system browser."),
    });
  }
  return outcome({
    status: "updated",
    detail: withEnvironmentNote(
      env,
      "Removed the configured browser opener; using the system browser.",
    ),
  });
}

async function configureCmux(
  ctx: SetupContext,
  state: SetupState,
  findCmuxImpl: typeof findCmux,
): Promise<ComponentOutcome> {
  if (ctx.platform !== "darwin") {
    return outcome({
      status: "unavailable",
      detail: `cmux browser integration is only supported on macOS currently (platform: ${ctx.platform}).`,
    });
  }
  if (ctx.persistent === null) {
    return outcome({
      status: "failed",
      detail: "cmux needs the persistent CLI; retry after it installs.",
      retry: RETRY_CMUX,
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
  if (await isStaleOpener("cmux", desired)) {
    return outcome({
      status: "failed",
      detail: `the packaged cmux helper is missing from this install (expected ${desired[1]}); reinstall livediff and retry.`,
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
  const kind = classifyOpener(stored, state.ownedOpener);
  if (kind === "cmux" && arraysEqual(stored, desired)) {
    state.ownedOpener = desired;
    return outcome({
      status: "unchanged",
      detail: withEnvironmentNote(ctx.env, "cmux already configured."),
    });
  }

  await setConfigValue("browser.opener", desired);
  state.ownedOpener = desired;

  if (kind === "legacy-cmux" && stored !== null) {
    const shim = stored[0];
    return outcome({
      status: "updated",
      detail: withEnvironmentNote(
        ctx.env,
        `Migrated from the legacy shim at ${shim} to the packaged cmux helper. ` +
          `The old shim was left in place; remove it manually if you like.`,
      ),
    });
  }

  if (kind === "custom" && stored !== null) {
    return outcome({
      status: "updated",
      detail: withEnvironmentNote(
        ctx.env,
        `Replaced the custom opener ("${stored.join(" ")}") with the packaged cmux helper.`,
      ),
    });
  }

  const status = stored === null ? "installed" : "updated";
  return outcome({
    status,
    detail: withEnvironmentNote(ctx.env, "Configured cmux as the browser opener."),
  });
}

/**
 * Reruns: rewrite an owned cmux opener whose path has gone stale or no longer matches the current
 * persistent install (a new version-manager Node, a moved package root). Returns null when
 * nothing applies or nothing changed — including every custom opener, which this never touches.
 */
export async function repairOwnedOpener(
  ctx: SetupContext,
  state: SetupState,
): Promise<ComponentOutcome | null> {
  if (ctx.persistent === null) return null;
  const stored = storedBrowserOpener();
  if (stored === null) return null;
  const kind = classifyOpener(stored, state.ownedOpener);
  if (kind !== "cmux") return null;

  const desired = cmuxOpenerArgv(ctx.persistent);
  if (desired.some(isInNpxCache)) return null;

  const matchesDesired = arraysEqual(stored, desired);
  const desiredBroken = await isStaleOpener("cmux", desired);

  if (matchesDesired) {
    if (!desiredBroken) return null; // already correct and healthy
    return outcome({
      status: "failed",
      detail: withEnvironmentNote(
        ctx.env,
        "the configured cmux opener is broken (its node or helper path no longer exists), and " +
          "the current install has nothing newer to point it at.",
      ),
      retry: RETRY_CMUX,
    });
  }

  if (desiredBroken) {
    return outcome({
      status: "failed",
      detail: withEnvironmentNote(
        ctx.env,
        `found a stale cmux opener, but the current install's helper is missing too (expected ${desired[1]}); reinstall livediff and retry.`,
      ),
      retry: RETRY_CMUX,
    });
  }

  await setConfigValue("browser.opener", desired);
  state.ownedOpener = desired;
  return outcome({
    status: "updated",
    detail: withEnvironmentNote(
      ctx.env,
      "Repaired the cmux browser opener to point at the current install.",
    ),
  });
}
