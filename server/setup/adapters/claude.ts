import type { SetupContext } from "../types.js";
import {
  failureText,
  HARNESS_TIMEOUT_MS,
  isRecord,
  parseJsonOutput,
  pathRegistration,
  registrationFrom,
  registrationFromSpec,
  stringField,
  type Registration,
} from "./common.js";
import { nativeAdapter, type NativePlugin, type NativeRead, type StepResult } from "./native.js";

const MARKETPLACE = "livediff";
const PLUGIN_ID = "livediff@livediff";
const LIST_TIMEOUT_MS = 60_000;

async function claude(
  ctx: SetupContext,
  args: readonly string[],
  timeoutMs = HARNESS_TIMEOUT_MS,
): Promise<StepResult & { stdout: string }> {
  const result = await ctx.run("claude", args, { env: ctx.env, timeoutMs });
  if (result.code !== 0) return { ok: false, error: failureText(result), stdout: result.stdout };
  return { ok: true, stdout: result.stdout };
}

/** Project- or local-scoped entries are not visible to other worktrees; only `user` scope counts. */
function isUserScoped(entry: Record<string, unknown>): boolean {
  const scope = entry["scope"];
  return scope === undefined || scope === "user";
}

/** `marketplace list --json` entries are `{name, source, repo|url|path, ref?}`. */
function registrationOf(entry: Record<string, unknown>): Registration {
  const ref = stringField(entry, "ref");
  const path = stringField(entry, "path");
  if (entry["source"] === "directory" && path !== null) return pathRegistration(path);
  const location =
    stringField(entry, "repo") ??
    stringField(entry, "url") ??
    path ??
    `${String(entry["source"])} source`;
  return registrationFrom(location, ref);
}

function pluginOf(entries: unknown[]): NativePlugin | null {
  const entry = entries
    .filter(isRecord)
    .find((candidate) => candidate["id"] === PLUGIN_ID && isUserScoped(candidate));
  if (entry === undefined) return null;
  const installPath = stringField(entry, "installPath");
  return {
    version: stringField(entry, "version"),
    enabled: entry["enabled"] !== false,
    paths: installPath === null ? [] : [installPath],
  };
}

async function read(ctx: SetupContext): Promise<NativeRead> {
  const marketplaces = await claude(
    ctx,
    ["plugin", "marketplace", "list", "--json"],
    LIST_TIMEOUT_MS,
  );
  if (!marketplaces.ok) return marketplaces;
  const listed = parseJsonOutput(marketplaces.stdout);
  if (!Array.isArray(listed)) return { ok: false, error: "unexpected `marketplace list` output" };
  const plugins = await claude(ctx, ["plugin", "list", "--json"], LIST_TIMEOUT_MS);
  if (!plugins.ok) return plugins;
  const installed = parseJsonOutput(plugins.stdout);
  if (!Array.isArray(installed)) return { ok: false, error: "unexpected `plugin list` output" };
  const entry = listed
    .filter(isRecord)
    .filter(isUserScoped)
    .find((candidate) => candidate["name"] === MARKETPLACE);
  return {
    ok: true,
    state: {
      registration: entry === undefined ? null : registrationOf(entry),
      plugin: pluginOf(installed),
    },
  };
}

async function step(ctx: SetupContext, args: readonly string[]): Promise<StepResult> {
  const result = await claude(ctx, args);
  if (!result.ok) return result;
  const parsed = parseJsonOutput(result.stdout);
  if (isRecord(parsed) && parsed["outcome"] === "failed") {
    return {
      ok: false,
      error: stringField(parsed, "failureCode") ?? "the harness reported a failure",
    };
  }
  return { ok: true };
}

/**
 * `plugin update` alone compares against the stale marketplace clone, so the marketplace is
 * refreshed first (verified against Claude Code 2.1.281).
 */
async function refresh(ctx: SetupContext): Promise<StepResult> {
  const marketplace = await step(ctx, ["plugin", "marketplace", "update", MARKETPLACE]);
  if (!marketplace.ok) return marketplace;
  return step(ctx, ["plugin", "update", PLUGIN_ID, "--json"]);
}

export const claudeAdapter = nativeAdapter({
  alias: "claude",
  label: "Claude Code plugin",
  harness: "Claude Code",
  executable: "claude",
  installHint: "Claude Code is not installed. Install it from https://claude.com/claude-code.",
  removeCommand: `claude plugin marketplace remove ${MARKETPLACE}`,
  enableHint: `run \`claude plugin enable ${PLUGIN_ID}\``,
  expected: (ctx) => registrationFromSpec(ctx.source.claudeMarketplace),
  read,
  remove: (ctx) => step(ctx, ["plugin", "marketplace", "remove", MARKETPLACE]),
  register: (ctx) => step(ctx, ["plugin", "marketplace", "add", ctx.source.claudeMarketplace]),
  install: (ctx) => step(ctx, ["plugin", "install", PLUGIN_ID, "--json"]),
  refresh,
});
