import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readObject = async (path: string): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isRecord(value));
  return value;
};

const hasCodexEntry = (plugins: readonly unknown[]): boolean =>
  plugins.some((plugin) => {
    if (!isRecord(plugin)) return false;
    const source = plugin["source"];
    return (
      isRecord(source) && source["source"] === "local" && source["path"] === "./plugins/livediff"
    );
  });

const hasClaudeEntry = (plugins: readonly unknown[]): boolean =>
  plugins.some((plugin) => isRecord(plugin) && plugin["source"] === "./plugins/livediff");

test("the shared LiveDiff plugin is listed in both native marketplaces", async () => {
  const pluginRoot = join(root, "plugins", "livediff");
  const codexManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const claudeManifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const codexMarketplacePath = join(root, ".agents", "plugins", "marketplace.json");
  const claudeMarketplacePath = join(root, ".claude-plugin", "marketplace.json");

  await Promise.all([
    access(codexManifestPath),
    access(claudeManifestPath),
    access(join(pluginRoot, "skills", "review", "SKILL.md")),
  ]);

  const [codexManifest, claudeManifest, codexMarketplace, claudeMarketplace] = await Promise.all([
    readObject(codexManifestPath),
    readObject(claudeManifestPath),
    readObject(codexMarketplacePath),
    readObject(claudeMarketplacePath),
  ]);

  assert.equal(codexManifest["name"], "livediff");
  assert.equal(codexManifest["skills"], "./skills");
  assert.equal(claudeManifest["name"], "livediff");
  assert.ok(
    Array.isArray(codexMarketplace["plugins"]) && hasCodexEntry(codexMarketplace["plugins"]),
  );
  assert.ok(
    Array.isArray(claudeMarketplace["plugins"]) && hasClaudeEntry(claudeMarketplace["plugins"]),
  );
});

test("the installer registers and installs both native plugins", async () => {
  const installer = await readFile(join(root, "install.sh"), "utf8");

  assert.match(installer, /claude plugin marketplace add "\$SCRIPT_DIR"/);
  assert.match(installer, /claude plugin install livediff@livediff/);
  assert.match(installer, /codex plugin marketplace add "\$SCRIPT_DIR"/);
  assert.match(installer, /codex plugin add livediff@livediff/);
});
