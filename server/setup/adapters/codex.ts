import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SetupContext } from "../types.js";
import {
  failureText,
  HARNESS_TIMEOUT_MS,
  homeDir,
  isRecord,
  looksLikePath,
  parseJsonOutput,
  pathRegistration,
  registrationFrom,
  stringField,
  type Registration,
} from "./common.js";
import { nativeAdapter, type NativePlugin, type NativeRead, type StepResult } from "./native.js";

const MARKETPLACE = "livediff";
const PLUGIN_ID = "livediff@livediff";
const LIST_TIMEOUT_MS = 60_000;

async function codex(
  ctx: SetupContext,
  args: readonly string[],
  timeoutMs = HARNESS_TIMEOUT_MS,
): Promise<StepResult & { stdout: string }> {
  const result = await ctx.run("codex", args, { env: ctx.env, timeoutMs });
  if (result.code !== 0) return { ok: false, error: failureText(result), stdout: result.stdout };
  return { ok: true, stdout: result.stdout };
}

function codexHome(ctx: SetupContext): string | null {
  const configured = ctx.env["CODEX_HOME"];
  if (configured !== undefined && configured !== "") return configured;
  const home = homeDir(ctx);
  return home === null ? null : join(home, ".codex");
}

/**
 * Reads the string values of one table from a TOML document. Deliberately narrow: `codex plugin
 * marketplace list` omits the ref, and this one table of flat strings is all setup needs, which
 * does not justify a TOML dependency.
 */
export function readTomlTable(
  text: string,
  path: readonly string[],
): Record<string, string> | null {
  let inTable = false;
  let found: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header?.[1] !== undefined) {
      inTable = sameKeyPath(parseKeyPath(header[1]), path);
      if (inTable) found = {};
      continue;
    }
    if (line.startsWith("[")) {
      inTable = false;
      continue;
    }
    if (!inTable || found === null) continue;
    const pair = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.+)$/.exec(line);
    if (pair?.[1] === undefined || pair[2] === undefined) continue;
    const value = parseTomlString(pair[2]);
    if (value !== null) found[pair[1].replace(/^"|"$/g, "")] = value;
  }
  return found;
}

function parseKeyPath(text: string): string[] {
  const parts: string[] = [];
  for (const match of text.matchAll(
    /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/g,
  )) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

function sameKeyPath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function parseTomlString(value: string): string | null {
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? null : value.slice(1, end);
  }
  if (!value.startsWith('"')) return null;
  for (let index = 1; index < value.length; index++) {
    if (value[index] === "\\") {
      index++;
      continue;
    }
    if (value[index] !== '"') continue;
    try {
      const parsed: unknown = JSON.parse(value.slice(0, index + 1));
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function configuredMarketplace(ctx: SetupContext): Promise<Record<string, string> | null> {
  const home = codexHome(ctx);
  if (home === null) return null;
  try {
    return readTomlTable(await readFile(join(home, "config.toml"), "utf8"), [
      "marketplaces",
      MARKETPLACE,
    ]);
  } catch {
    return null;
  }
}

function registrationOf(
  listed: Record<string, unknown>,
  table: Record<string, string> | null,
): Registration {
  const listedSource = isRecord(listed["marketplaceSource"]) ? listed["marketplaceSource"] : {};
  const sourceType = table?.["source_type"] ?? stringField(listedSource, "sourceType");
  const source = table?.["source"] ?? stringField(listedSource, "source") ?? "an unknown source";
  if (sourceType === "local") return pathRegistration(source);
  return registrationFrom(source, table?.["ref"] ?? null);
}

function pluginOf(ctx: SetupContext, listed: unknown): NativePlugin | null {
  const installed =
    isRecord(listed) && Array.isArray(listed["installed"]) ? listed["installed"] : [];
  const entry = installed
    .filter(isRecord)
    .find((candidate) => candidate["pluginId"] === PLUGIN_ID && candidate["installed"] !== false);
  if (entry === undefined) return null;
  const version = stringField(entry, "version");
  const home = codexHome(ctx);
  const cache = home === null ? null : join(home, "plugins", "cache", MARKETPLACE, "livediff");
  const paths: string[] = [];
  if (cache !== null) paths.push(version === null ? cache : join(cache, version));
  return { version, enabled: entry["enabled"] !== false, paths };
}

async function read(ctx: SetupContext): Promise<NativeRead> {
  const marketplaces = await codex(
    ctx,
    ["plugin", "marketplace", "list", "--json"],
    LIST_TIMEOUT_MS,
  );
  if (!marketplaces.ok) return marketplaces;
  const listed = parseJsonOutput(marketplaces.stdout);
  if (!isRecord(listed) || !Array.isArray(listed["marketplaces"])) {
    return { ok: false, error: "unexpected `marketplace list` output" };
  }
  const plugins = await codex(ctx, ["plugin", "list", "--json"], LIST_TIMEOUT_MS);
  if (!plugins.ok) return plugins;
  const installed = parseJsonOutput(plugins.stdout);
  if (!isRecord(installed)) return { ok: false, error: "unexpected `plugin list` output" };
  const entry = listed["marketplaces"]
    .filter(isRecord)
    .find((candidate) => candidate["name"] === MARKETPLACE);
  return {
    ok: true,
    state: {
      registration:
        entry === undefined ? null : registrationOf(entry, await configuredMarketplace(ctx)),
      plugin: pluginOf(ctx, installed),
    },
  };
}

function expected(ctx: SetupContext): Registration {
  const { codexMarketplace, codexRef } = ctx.source;
  if (looksLikePath(codexMarketplace)) return pathRegistration(codexMarketplace);
  return registrationFrom(codexMarketplace, codexRef);
}

async function register(ctx: SetupContext): Promise<StepResult> {
  const { codexMarketplace, codexRef } = ctx.source;
  const ref = codexRef === null ? [] : ["--ref", codexRef];
  return codex(ctx, ["plugin", "marketplace", "add", codexMarketplace, ...ref, "--json"]);
}

export const codexAdapter = nativeAdapter({
  alias: "codex",
  label: "Codex plugin",
  harness: "Codex",
  executable: "codex",
  installHint: "The Codex CLI is not installed. Install it with `npm install -g @openai/codex`.",
  removeCommand: `codex plugin marketplace remove ${MARKETPLACE}`,
  enableHint: `set \`enabled = true\` under \`[plugins."${PLUGIN_ID}"]\` in Codex's config.toml`,
  expected,
  read,
  // Removal leaves an orphaned `[plugins."livediff@livediff"]` table and plugin cache behind;
  // the reinstall that follows overwrites both, and the plugin list verifies the result.
  remove: (ctx) => codex(ctx, ["plugin", "marketplace", "remove", MARKETPLACE]),
  register,
  install: (ctx) => codex(ctx, ["plugin", "add", PLUGIN_ID, "--json"]),
  // Verified against Codex 0.147.0: upgrading the marketplace also refreshes installed plugins.
  refresh: (ctx) => codex(ctx, ["plugin", "marketplace", "upgrade", MARKETPLACE, "--json"]),
});
