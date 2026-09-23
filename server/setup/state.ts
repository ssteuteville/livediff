import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic } from "../atomic.js";
import { configDir } from "../registry.js";
import { isAgentAlias, type AgentAlias, type AgentRecord, type SharedSkill } from "./types.js";

export const SETUP_STATE_VERSION = 1;

const SETUP_STATE_FILENAME = "setup.json";

export type SetupRunOutcome = "success" | "partial" | "failed" | "cancelled";

/**
 * What setup installed and owns. It is a reconciliation aid, not proof of anything: reruns
 * always inspect live state. The browser preference itself stays in config.jsonc; only the
 * fact that setup wrote the current opener is recorded here, so a user's custom opener is never
 * mistaken for ours.
 */
export interface SetupState {
  version: typeof SETUP_STATE_VERSION;
  cli: { packageName: string; version: string; bin: string; verifiedAt: string } | null;
  agents: Partial<Record<AgentAlias, AgentRecord>>;
  /** The canonical portable-skill directory and every agent that links to it. */
  sharedSkill: SharedSkill | null;
  /** The opener argv setup configured, when it did. */
  ownedOpener: string[] | null;
  lastRun: { at: string; outcome: SetupRunOutcome; retry: string | null } | null;
}

export function emptySetupState(): SetupState {
  return {
    version: SETUP_STATE_VERSION,
    cli: null,
    agents: {},
    sharedSkill: null,
    ownedOpener: null,
    lastRun: null,
  };
}

export function setupStatePath(): string {
  return join(configDir(), SETUP_STATE_FILENAME);
}

export type LoadedSetupState =
  | { kind: "missing"; state: SetupState }
  | { kind: "loaded"; state: SetupState }
  | { kind: "unreadable"; state: SetupState; reason: string }
  /** Written by a newer livediff; this one must not overwrite what it cannot understand. */
  | { kind: "newer"; state: SetupState; version: number };

/** Never throws: an unreadable record degrades to live inspection, and says so. */
export async function loadSetupState(path = setupStatePath()): Promise<LoadedSetupState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { kind: "missing", state: emptySetupState() };
    return { kind: "unreadable", state: emptySetupState(), reason: String(error) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unreadable", state: emptySetupState(), reason: "not valid JSON" };
  }
  const newer = newerVersion(raw);
  if (newer !== null) return { kind: "newer", state: emptySetupState(), version: newer };
  const state = parseSetupState(raw);
  if (state === null) {
    return { kind: "unreadable", state: emptySetupState(), reason: "unrecognized format" };
  }
  return { kind: "loaded", state };
}

export async function saveSetupState(state: SetupState, path = setupStatePath()): Promise<void> {
  await writeJsonAtomic(path, state);
}

/** The atomic write of `saveSetupState`, for a signal handler that exits right after. */
export function saveSetupStateSync(state: SetupState, path = setupStatePath()): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
  }
}

function newerVersion(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const version = raw["version"];
  return typeof version === "number" && version > SETUP_STATE_VERSION ? version : null;
}

export function parseSetupState(raw: unknown): SetupState | null {
  if (!isRecord(raw) || raw["version"] !== SETUP_STATE_VERSION) return null;
  return {
    version: SETUP_STATE_VERSION,
    cli: parseCli(raw["cli"]),
    agents: parseAgents(raw["agents"]),
    sharedSkill: parseSharedSkill(raw["sharedSkill"]),
    ownedOpener: parseStringArray(raw["ownedOpener"]),
    lastRun: parseLastRun(raw["lastRun"]),
  };
}

function parseCli(raw: unknown): SetupState["cli"] {
  if (!isRecord(raw)) return null;
  const { packageName, version, bin, verifiedAt } = raw;
  if (
    typeof packageName !== "string" ||
    typeof version !== "string" ||
    typeof bin !== "string" ||
    typeof verifiedAt !== "string"
  ) {
    return null;
  }
  return { packageName, version, bin, verifiedAt };
}

function parseAgents(raw: unknown): SetupState["agents"] {
  const agents: SetupState["agents"] = {};
  if (!isRecord(raw)) return agents;
  for (const [alias, value] of Object.entries(raw)) {
    if (!isAgentAlias(alias)) continue;
    const record = parseAgentRecord(value);
    if (record !== null) agents[alias] = record;
  }
  return agents;
}

function parseAgentRecord(raw: unknown): AgentRecord | null {
  if (!isRecord(raw)) return null;
  const { adapter, source, version, verifiedAt } = raw;
  if (adapter !== "native-plugin" && adapter !== "portable-skill") return null;
  if (typeof source !== "string" || typeof verifiedAt !== "string") return null;
  if (version !== null && typeof version !== "string") return null;
  return { adapter, source, version, paths: parseStringArray(raw["paths"]) ?? [], verifiedAt };
}

function parseSharedSkill(raw: unknown): SetupState["sharedSkill"] {
  if (!isRecord(raw) || typeof raw["path"] !== "string") return null;
  const agents = (parseStringArray(raw["agents"]) ?? []).filter(isAgentAlias);
  return { path: raw["path"], agents };
}

function parseLastRun(raw: unknown): SetupState["lastRun"] {
  if (!isRecord(raw) || typeof raw["at"] !== "string") return null;
  const outcome = raw["outcome"];
  if (
    outcome !== "success" &&
    outcome !== "partial" &&
    outcome !== "failed" &&
    outcome !== "cancelled"
  ) {
    return null;
  }
  const retry = typeof raw["retry"] === "string" ? raw["retry"] : null;
  return { at: raw["at"], outcome, retry };
}

function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    values.push(item);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
