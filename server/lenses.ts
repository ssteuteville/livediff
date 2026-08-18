import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./registry.js";
import { LENSES_DIR_NAME, LENS_NAME_PATTERN, LENS_STORE_VERSION } from "./constants.js";
import { writeJsonAtomic } from "./atomic.js";
import { withLock } from "./locks.js";
import { pathMatcher } from "./glob.js";
import type { Highlight, Lens } from "../shared/types.ts";

/**
 * Lens sets, one JSON file per workspace, a sibling of the comment stores.
 *
 * An ordered array rather than a keyed object: a workspace holds a handful of lenses and always
 * reads them as a whole set, and the order is meaningful — it is the order the picker shows, and
 * later the order of a walkthrough's steps.
 */

interface LensFile {
  version: number;
  lenses: Lens[];
}

export function lensStorePath(wsId: string): string {
  return join(configDir(), LENSES_DIR_NAME, `${wsId}.json`);
}

export function parseLens(value: unknown, where: string): Lens {
  if (!isRecord(value)) throw new TypeError(`${where}: must be an object`);
  const name = value["name"];
  if (typeof name !== "string" || !LENS_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `${where}: name must be lowercase letters, digits, and dashes, 1–40 characters, not starting with a dash`,
    );
  }
  const paths = value["paths"];
  if (!isStringArray(paths) || paths.length === 0 || paths.some((p) => p.length === 0)) {
    throw new TypeError(`${where}: paths must be a non-empty array of non-empty patterns`);
  }
  const why = value["why"];
  if (why !== undefined && why !== null && typeof why !== "string") {
    throw new TypeError(`${where}: why must be a string`);
  }
  const createdAt = value["createdAt"];
  if (createdAt !== undefined && typeof createdAt !== "string") {
    throw new TypeError(`${where}: createdAt must be a string`);
  }
  return {
    name,
    why: typeof why === "string" ? why : null,
    paths,
    highlights: parseHighlights(value["highlights"], where, paths),
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

function parseHighlights(value: unknown, where: string, paths: readonly string[]): Highlight[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${where}: highlights must be an array`);
  const covered = pathMatcher(paths);
  return value.map((entry, index) => {
    const at = `${where}: highlight ${index}`;
    if (!isRecord(entry)) throw new TypeError(`${at}: must be an object`);
    const path = entry["path"];
    if (typeof path !== "string" || path.length === 0)
      throw new TypeError(`${at}: path is required`);
    // A highlight the lens itself filters out could never render, so it is a mistake, not a no-op.
    if (!covered(path)) throw new TypeError(`${at}: ${path} is not matched by this lens's paths`);
    const start = lineNumber(entry["start"], `${at}: start`);
    const end = lineNumber(entry["end"], `${at}: end`);
    if (end < start) throw new TypeError(`${at}: end must not be before start`);
    return { path, start, end };
  });
}

function lineNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${where} must be a whole line number of 1 or more`);
  }
  return value;
}

export function parseLensSet(value: unknown): Lens[] {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value["lenses"] : undefined;
  if (!Array.isArray(raw)) throw new TypeError("expected { lenses: [...] } or an array of lenses");
  const lenses = raw.map((entry, index) => parseLens(entry, `lens ${index}`));
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (seen.has(lens.name)) throw new TypeError(`duplicate lens name: ${lens.name}`);
    seen.add(lens.name);
  }
  return lenses;
}

export async function listLenses(wsId: string): Promise<Lens[]> {
  const path = lensStorePath(wsId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Run \`livediff lens clear\` to discard it.`);
  }
  if (!isRecord(raw) || !Array.isArray(raw["lenses"])) return [];
  return raw["lenses"].flatMap((entry, index) => {
    // A hand-edited store should lose the broken entry, not the whole set.
    try {
      return [parseLens(entry, `lens ${index}`)];
    } catch {
      return [];
    }
  });
}

export async function setLenses(wsId: string, lenses: Lens[]): Promise<Lens[]> {
  return withLock(wsId, async () => {
    await write(wsId, lenses);
    return lenses;
  });
}

export async function upsertLens(wsId: string, lens: Lens): Promise<Lens[]> {
  return withLock(wsId, async () => {
    const current = await listLenses(wsId);
    const at = current.findIndex((entry) => entry.name === lens.name);
    // Replacing in place rather than moving to the end: the order is the reading order.
    const next = at === -1 ? [...current, lens] : current.with(at, lens);
    await write(wsId, next);
    return next;
  });
}

export async function removeLens(wsId: string, name: string): Promise<boolean> {
  return withLock(wsId, async () => {
    const current = await listLenses(wsId);
    const next = current.filter((entry) => entry.name !== name);
    if (next.length === current.length) return false;
    await write(wsId, next);
    return true;
  });
}

export async function clearLenses(wsId: string): Promise<boolean> {
  return withLock(wsId, async () => {
    try {
      await unlink(lensStorePath(wsId));
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  });
}

async function write(wsId: string, lenses: Lens[]): Promise<void> {
  const file: LensFile = { version: LENS_STORE_VERSION, lenses };
  await writeJsonAtomic(lensStorePath(wsId), file);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
