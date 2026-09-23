import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type {
  AgentAdapter,
  AgentAlias,
  AgentRecord,
  ComponentOutcome,
  RunResult,
  SetupContext,
} from "../types.js";

export const HARNESS_TIMEOUT_MS = 180_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

/**
 * Harness `--json` output is usually one document, but some tools (the skills installer) print
 * progress before a pretty-printed document, so try every line that could open one.
 */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;
  const lines = trimmed.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index]?.trimStart() ?? "";
    if (!start.startsWith("{") && !start.startsWith("[")) continue;
    const parsed = tryParse(lines.slice(index).join("\n"));
    if (parsed !== undefined) return parsed;
    const single = tryParse(start);
    if (single !== undefined) return single;
  }
  return undefined;
}

function tryParse(text: string): unknown {
  if (text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** The most useful single line of a failed command, for a summary detail. */
export function failureText(result: RunResult): string {
  if (result.code === -1) return "the command could not be started";
  const text = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    text.find((line) => /error|fail|fatal|denied|refused|unable/i.test(line)) ??
    text[0] ??
    `exit ${result.code}`
  );
}

export function homeDir(ctx: SetupContext): string | null {
  const home = ctx.env["HOME"] ?? ctx.env["USERPROFILE"];
  return home === undefined || home === "" ? null : home;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal PATH scan so detection never spawns anything. A shared `detectAgent` is being built
 * separately; this stays until the two are merged.
 */
export async function onPath(ctx: SetupContext, names: readonly string[]): Promise<boolean> {
  const dirs = (ctx.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  const extensions = ctx.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const name of names) {
      for (const extension of extensions) {
        if (await isExecutable(join(dir, name + extension))) return true;
      }
    }
  }
  return false;
}

export function retryCommand(aliases: readonly AgentAlias[], update: boolean): string {
  const agents = aliases.map((alias) => `--agent ${alias}`).join(" ");
  return update ? `livediff setup --update ${agents}` : `livediff setup ${agents}`;
}

export function agentRecord(
  kind: AgentAdapter["kind"],
  ctx: SetupContext,
  version: string | null,
  paths: string[],
): AgentRecord {
  return {
    adapter: kind,
    source: ctx.source.id,
    version,
    paths,
    verifiedAt: new Date().toISOString(),
  };
}

export function joinDetails(...parts: readonly (string | null | undefined)[]): string | undefined {
  const present = parts.filter(
    (part): part is string => part !== null && part !== undefined && part !== "",
  );
  return present.length === 0 ? undefined : present.join(" ");
}

export function outcomeId(alias: AgentAlias): string {
  return `agent:${alias}`;
}

export function unavailableOutcome(
  alias: AgentAlias,
  label: string,
  installHint: string,
): ComponentOutcome {
  return {
    id: outcomeId(alias),
    label,
    status: "unavailable",
    detail: `${installHint} Then run \`${retryCommand([alias], false)}\`.`,
    retry: retryCommand([alias], false),
  };
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Until release metadata declares an explicit CLI range, an integration is compatible with any
 * CLI of the same major.minor. The remediation never downgrades: whichever side is older is the
 * one to update.
 */
export function checkCompatibility(
  integrationVersion: string | null,
  cliVersion: string,
  alias: AgentAlias,
): string | null {
  if (integrationVersion === null) return null;
  const integration = parseSemver(integrationVersion);
  const cli = parseSemver(cliVersion);
  if (integration === null || cli === null) return null;
  if (integration.major === cli.major && integration.minor === cli.minor) return null;
  if (compareSemver(integration, cli) > 0) {
    return `Warning: this integration (${integrationVersion}) expects a newer LiveDiff CLI than ${cliVersion}; run \`npm install -g livediff@latest\`.`;
  }
  return `Warning: this integration (${integrationVersion}) is older than the LiveDiff CLI (${cliVersion}); run \`${retryCommand([alias], true)}\`.`;
}

/** Where a LiveDiff integration comes from, normalized so equivalent spellings compare equal. */
export type Registration =
  | { kind: "repo"; repo: string; ref: string | null }
  | { kind: "url"; url: string; ref: string | null }
  | { kind: "path"; path: string };

const GITHUB_URL =
  /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;
const REPO_SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

export function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.startsWith(".") || /^[A-Za-z]:[\\/]/.test(value);
}

export function pathRegistration(path: string): Registration {
  return { kind: "path", path: normalizePath(path) };
}

export function registrationFrom(location: string, ref: string | null): Registration {
  if (looksLikePath(location)) return pathRegistration(location);
  const github = GITHUB_URL.exec(location);
  if (github?.[1] !== undefined) return { kind: "repo", repo: github[1].toLowerCase(), ref };
  if (REPO_SHORTHAND.test(location)) return { kind: "repo", repo: location.toLowerCase(), ref };
  return {
    kind: "url",
    url: location
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "")
      .toLowerCase(),
    ref,
  };
}

/** Splits `location#ref`; a local path never carries a ref. */
export function registrationFromSpec(spec: string): Registration {
  if (looksLikePath(spec)) return { kind: "path", path: normalizePath(spec) };
  const hash = spec.lastIndexOf("#");
  if (hash === -1) return registrationFrom(spec, null);
  return registrationFrom(spec.slice(0, hash), spec.slice(hash + 1) || null);
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "");
}

export function sameRegistration(a: Registration, b: Registration): boolean {
  if (a.kind === "path" || b.kind === "path") {
    return a.kind === "path" && b.kind === "path" && a.path === b.path;
  }
  if (a.kind === "repo" && b.kind === "repo") return a.repo === b.repo && a.ref === b.ref;
  if (a.kind === "url" && b.kind === "url") return a.url === b.url && a.ref === b.ref;
  return false;
}

export function describeRegistration(registration: Registration): string {
  if (registration.kind === "path") return `the local directory ${registration.path}`;
  const base = registration.kind === "repo" ? registration.repo : registration.url;
  return registration.ref === null ? `${base} (default branch)` : `${base}#${registration.ref}`;
}
