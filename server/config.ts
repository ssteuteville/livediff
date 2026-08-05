import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, parseTree, type ParseError } from "jsonc-parser";
import { writeTextAtomic } from "./atomic.js";
import {
  ARCHIVE_WARN_BYTES,
  DEFAULT_POLL_MS,
  DEFAULT_PORT,
  ENV,
  ORPHAN_ARCHIVE_DAYS,
  PURGE_DAYS,
  RESOLVED_ARCHIVE_DAYS,
} from "./constants.js";
import { configDir } from "./registry.js";
import { RENDERERS, type Renderer } from "../shared/constants.ts";

const CONFIG_FILENAME = "config.jsonc";
const CONFIG_SCHEMA_FILENAME = "config.schema.json";
export const CONFIG_SCHEMA_REFERENCE = `./${CONFIG_SCHEMA_FILENAME}`;

export interface Config {
  browser: { opener: readonly string[] | null };
  hub: { port: number; pollIntervalMs: number };
  retention: {
    orphanArchiveAfterDays: number;
    resolvedArchiveAfterDays: number;
    purgeAfterDays: number;
    archiveWarningBytes: number;
  };
  ui: { defaultRenderer: Renderer };
}

interface ConfigFile {
  $schema?: string | undefined;
  browser?: { opener?: string[] | undefined } | undefined;
  hub?: { port?: number | undefined; pollIntervalMs?: number | undefined } | undefined;
  retention?:
    | {
        orphanArchiveAfterDays?: number | undefined;
        resolvedArchiveAfterDays?: number | undefined;
        purgeAfterDays?: number | undefined;
        archiveWarningBytes?: number | undefined;
      }
    | undefined;
  ui?: { defaultRenderer?: Renderer | undefined } | undefined;
}

export const DEFAULT_CONFIG: Config = {
  browser: { opener: null },
  hub: { port: DEFAULT_PORT, pollIntervalMs: DEFAULT_POLL_MS },
  retention: {
    orphanArchiveAfterDays: ORPHAN_ARCHIVE_DAYS,
    resolvedArchiveAfterDays: RESOLVED_ARCHIVE_DAYS,
    purgeAfterDays: PURGE_DAYS,
    archiveWarningBytes: ARCHIVE_WARN_BYTES,
  },
  ui: { defaultRenderer: "fast" },
};

export function configPath(): string {
  return join(configDir(), CONFIG_FILENAME);
}

export function schemaPath(): string {
  return join(configDir(), CONFIG_SCHEMA_FILENAME);
}

export function loadConfig(): Config {
  const file = readConfigFile();
  return applyEnvironment({
    browser: { opener: file.browser?.opener ?? DEFAULT_CONFIG.browser.opener },
    hub: {
      port: file.hub?.port ?? DEFAULT_CONFIG.hub.port,
      pollIntervalMs: file.hub?.pollIntervalMs ?? DEFAULT_CONFIG.hub.pollIntervalMs,
    },
    retention: {
      orphanArchiveAfterDays:
        file.retention?.orphanArchiveAfterDays ?? DEFAULT_CONFIG.retention.orphanArchiveAfterDays,
      resolvedArchiveAfterDays:
        file.retention?.resolvedArchiveAfterDays ??
        DEFAULT_CONFIG.retention.resolvedArchiveAfterDays,
      purgeAfterDays: file.retention?.purgeAfterDays ?? DEFAULT_CONFIG.retention.purgeAfterDays,
      archiveWarningBytes:
        file.retention?.archiveWarningBytes ?? DEFAULT_CONFIG.retention.archiveWarningBytes,
    },
    ui: { defaultRenderer: file.ui?.defaultRenderer ?? DEFAULT_CONFIG.ui.defaultRenderer },
  });
}

function readConfigFile(): ConfigFile {
  try {
    return parseConfigText(readFileSync(configPath(), "utf8"), configPath());
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

export async function initConfig(): Promise<string> {
  const path = configPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await ensureSchema();
    await writeFile(path, initialConfigText(), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isAlreadyExists(error))
      throw new Error(`configuration already exists at ${path}`, { cause: error });
    throw error;
  }
  return path;
}

export async function ensureSchema(): Promise<string> {
  const target = schemaPath();
  await mkdir(dirname(target), { recursive: true });
  try {
    await readFile(target, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await copyFile(bundledSchemaPath(), target);
  }
  return target;
}

export async function updateSchema(): Promise<string> {
  const target = schemaPath();
  const source = await readFile(bundledSchemaPath(), "utf8");
  await writeTextAtomic(target, source);
  return target;
}

export async function setConfigValue(key: string, value: unknown): Promise<void> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await ensureSchema();
    text = `{\n  "$schema": "${CONFIG_SCHEMA_REFERENCE}"\n}\n`;
  }
  parseConfigText(text, path);
  const pathSegments = configPathSegments(key);
  const tree = parseTree(text);
  if (!tree) throw new Error(`invalid configuration in ${path}`);
  const next = applyEdits(
    text,
    modify(text, pathSegments, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
  parseConfigText(next, path);
  await writeTextAtomic(path, next.endsWith("\n") ? next : `${next}\n`);
}

export function parseConfigText(text: string, path = "configuration"): ConfigFile {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0)
    throw new Error(`${path}: invalid JSONC (${errors.map((error) => error.error).join(", ")})`);
  return parseConfigFile(value, path);
}

function parseConfigFile(value: unknown, path: string): ConfigFile {
  const root = object(value, path, ["$schema", "browser", "hub", "retention", "ui"]);
  const browser = optionalObject(root, "browser", ["opener"]);
  const hub = optionalObject(root, "hub", ["port", "pollIntervalMs"]);
  const retention = optionalObject(root, "retention", [
    "orphanArchiveAfterDays",
    "resolvedArchiveAfterDays",
    "purgeAfterDays",
    "archiveWarningBytes",
  ]);
  const ui = optionalObject(root, "ui", ["defaultRenderer"]);
  return {
    $schema: optionalString(root, "$schema"),
    browser: browser ? { opener: optionalStringArray(browser, "opener") } : undefined,
    hub: hub
      ? {
          port: optionalPort(hub, "port"),
          pollIntervalMs: optionalPositiveInteger(hub, "pollIntervalMs"),
        }
      : undefined,
    retention: retention
      ? {
          orphanArchiveAfterDays: optionalPositiveInteger(
            retention,
            "orphanArchiveAfterDays",
            true,
          ),
          resolvedArchiveAfterDays: optionalPositiveInteger(
            retention,
            "resolvedArchiveAfterDays",
            true,
          ),
          purgeAfterDays: optionalPositiveInteger(retention, "purgeAfterDays", true),
          archiveWarningBytes: optionalPositiveInteger(retention, "archiveWarningBytes", true),
        }
      : undefined,
    ui: ui ? { defaultRenderer: optionalRenderer(ui, "defaultRenderer") } : undefined,
  };
}

function applyEnvironment(config: Config): Config {
  return {
    ...config,
    browser: { opener: environmentOpener() ?? config.browser.opener },
    hub: {
      port: environmentPort(ENV.PORT) ?? config.hub.port,
      pollIntervalMs: environmentPositiveInteger(ENV.POLL_MS) ?? config.hub.pollIntervalMs,
    },
    ui: { defaultRenderer: environmentRenderer() ?? config.ui.defaultRenderer },
  };
}

function environmentOpener(): readonly string[] | null {
  const value = process.env[ENV.BROWSER];
  if (value === undefined) return null;
  const opener = value.trim().split(/\s+/).filter(Boolean);
  if (opener.length === 0) throw new Error(`${ENV.BROWSER} must name an executable`);
  return opener;
}

function environmentPort(name: string): number | null {
  const value = process.env[name];
  if (value === undefined) return null;
  return port(Number(value), name);
}

function environmentPositiveInteger(name: string): number | null {
  const value = process.env[name];
  if (value === undefined) return null;
  return positiveInteger(Number(value), name, false);
}

function environmentRenderer(): Renderer | null {
  const value = process.env[ENV.RENDERER];
  if (value === undefined) return null;
  if (!isRenderer(value))
    throw new Error(`${ENV.RENDERER} must be one of: ${RENDERERS.join(", ")}`);
  return value;
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const record = value;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${path} has unknown setting${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  return record;
}

function optionalObject(
  value: Record<string, unknown>,
  key: string,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const child = value[key];
  return child === undefined ? undefined : object(child, key, keys);
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const child = value[key];
  if (child !== undefined && typeof child !== "string") throw new Error(`${key} must be a string`);
  return child;
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const child = value[key];
  if (child === undefined) return undefined;
  if (
    !Array.isArray(child) ||
    child.length === 0 ||
    child.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${key} must be a non-empty array of non-empty strings`);
  }
  return child;
}

function optionalPort(value: Record<string, unknown>, key: string): number | undefined {
  const child = value[key];
  return child === undefined ? undefined : port(child, key);
}

function port(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${key} must be an integer from 1 to 65535`);
  }
  return value;
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  allowZero = false,
): number | undefined {
  const child = value[key];
  return child === undefined ? undefined : positiveInteger(child, key, allowZero);
}

function positiveInteger(value: unknown, key: string, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${key} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return value;
}

function optionalRenderer(value: Record<string, unknown>, key: string): Renderer | undefined {
  const child = value[key];
  if (child === undefined) return undefined;
  if (!isRenderer(child)) throw new Error(`${key} must be one of: ${RENDERERS.join(", ")}`);
  return child;
}

function isRenderer(value: unknown): value is Renderer {
  return typeof value === "string" && (RENDERERS as readonly string[]).includes(value);
}

function configPathSegments(key: string): string[] {
  const segments = key.split(".");
  const allowed = new Set([
    "browser.opener",
    "hub.port",
    "hub.pollIntervalMs",
    "retention.orphanArchiveAfterDays",
    "retention.resolvedArchiveAfterDays",
    "retention.purgeAfterDays",
    "retention.archiveWarningBytes",
    "ui.defaultRenderer",
  ]);
  if (!allowed.has(key)) throw new Error(`unknown configuration setting: ${key}`);
  return segments;
}

function initialConfigText(): string {
  return `{
  "$schema": "${CONFIG_SCHEMA_REFERENCE}",
  // Add only settings you want to override. Run \`livediff config list --effective\` to see defaults.
}
`;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function bundledSchemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = import.meta.url.endsWith(".ts") ? join(here, "..") : join(here, "..", "..");
  return join(root, "schemas", "config-v1.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
