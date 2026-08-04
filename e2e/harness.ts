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
  const path = (JSON.parse(fromEnv("LIVEDIFF_E2E_PATHS")) as Record<string, string>)[name];
  if (!path) throw new Error(`no fixture path for ${name}`);
  return path;
}

export function workspaceUrl(name: FixtureName): string {
  const id = (JSON.parse(fromEnv("LIVEDIFF_E2E_IDS")) as Record<string, string>)[name];
  if (!id) throw new Error(`no workspace id for ${name}`);
  return `${hubUrl()}/?ws=${id}`;
}

/**
 * Deep link in focused mode. Prefer this: plain `?ws=` is clobbered on mount for any workspace that
 * is not first in the registry — see 2026-08-03-deep-link-selection.md — and focused mode also hides
 * the rail, so a test targets one worktree without the others on screen.
 */
export function focusUrl(name: FixtureName): string {
  return `${workspaceUrl(name)}&focus=1`;
}
