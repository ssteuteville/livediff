export type FixtureName = "tracked20k" | "modfiles" | "minified" | "lockfile";

function fromEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`global setup did not publish ${key}`);
  return value;
}

export function hubUrl(): string {
  return fromEnv("LIVEDIFF_E2E_URL");
}

export function fixturePath(name: FixtureName): string {
  const path = parseStringRecord(fromEnv("LIVEDIFF_E2E_PATHS"))[name];
  if (!path) throw new Error(`no fixture path for ${name}`);
  return path;
}

export function workspaceId(name: FixtureName): string {
  const id = parseStringRecord(fromEnv("LIVEDIFF_E2E_IDS"))[name];
  if (!id) throw new Error(`no workspace id for ${name}`);
  return id;
}

function parseStringRecord(input: string): Record<string, string> {
  const parsed: unknown = JSON.parse(input);
  if (!isStringRecord(parsed)) {
    throw new Error("global setup published invalid fixture data");
  }
  return parsed;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function workspaceUrl(name: FixtureName): string {
  return `${hubUrl()}/?ws=${workspaceId(name)}`;
}

/**
 * Deep link in focused mode. Prefer this: plain `?ws=` is clobbered on mount for any workspace that
 * is not first in the registry — see 2026-08-03-deep-link-selection.md — and focused mode also hides
 * the rail, so a test targets one worktree without the others on screen.
 */
export function focusUrl(name: FixtureName): string {
  return `${workspaceUrl(name)}&focus=1`;
}
