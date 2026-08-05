import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  configPath,
  initConfig,
  loadConfig,
  setConfigValue,
  updateSchema,
} from "../server/config.js";
import { withTempXdg } from "./helpers.js";

const envNames = [
  "LIVEDIFF_PORT",
  "LIVEDIFF_POLL_MS",
  "LIVEDIFF_BROWSER",
  "LIVEDIFF_RENDERER",
] as const;

const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("configuration", () => {
  it("uses typed defaults when no config file exists", async () => {
    await withTempXdg(async () => {
      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    });
  });

  it("loads JSONC and lets environment settings take precedence", async () => {
    await withTempXdg(async () => {
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(
        configPath(),
        `{
          // A comment must be accepted.
          "hub": { "port": 4910, "pollIntervalMs": 1500 },
          "retention": { "archiveWarningBytes": 9000000 },
          "ui": { "defaultRenderer": "classic" },
        }`,
        "utf8",
      );
      process.env["LIVEDIFF_PORT"] = "4920";
      process.env["LIVEDIFF_BROWSER"] = "cmux open-window";

      expect(loadConfig()).toMatchObject({
        browser: { opener: ["cmux", "open-window"] },
        hub: { port: 4920, pollIntervalMs: 1500 },
        retention: { archiveWarningBytes: 9_000_000 },
        ui: { defaultRenderer: "classic" },
      });
    });
  });

  it("rejects unknown and invalid settings instead of silently falling back", async () => {
    await withTempXdg(async () => {
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(configPath(), '{ "hub": { "port": 0 }, "typo": true }', "utf8");
      expect(() => loadConfig()).toThrow(/hub\.port|typo/);
    });
  });

  it("initializes a schema-linked config without overwriting and updates values atomically", async () => {
    await withTempXdg(async ({ config }) => {
      await initConfig();
      const path = join(config, "livediff", "config.jsonc");
      await expect(readFile(path, "utf8")).resolves.toContain('"$schema": "./config.schema.json"');
      await expect(
        readFile(join(config, "livediff", "config.schema.json"), "utf8"),
      ).resolves.toContain('"title": "LiveDiff configuration"');
      await expect(initConfig()).rejects.toThrow(/already exists/);

      await setConfigValue("retention.archiveWarningBytes", 8_000_000);
      expect(loadConfig().retention.archiveWarningBytes).toBe(8_000_000);
    });
  });

  it("updates the installed schema without changing configured values", async () => {
    await withTempXdg(async ({ config }) => {
      await initConfig();
      await setConfigValue("retention.archiveWarningBytes", 8_000_000);
      const path = join(config, "livediff", "config.jsonc");
      const before = await readFile(path, "utf8");
      const schema = join(config, "livediff", "config.schema.json");
      await writeFile(schema, "outdated schema\n", "utf8");

      await updateSchema();

      await expect(readFile(path, "utf8")).resolves.toBe(before);
      await expect(readFile(schema, "utf8")).resolves.toContain(
        '"title": "LiveDiff configuration"',
      );
    });
  });
});
