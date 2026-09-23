import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parseSkillFile } from "./frontmatter.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const portableSkillRoot = join(root, "skills", "livediff");
const portableSkillPath = join(portableSkillRoot, "SKILL.md");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function readObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isRecord(value));
  return value;
}

async function nativeSkillFiles(): Promise<string[]> {
  const skillsDir = join(root, "plugins", "livediff", "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsDir, entry.name, "SKILL.md"));
}

test("the portable skill lives outside the native plugin directory", async () => {
  // Native Claude/Codex installs ship only ./plugins/livediff (see the marketplace
  // manifests). A skill nested under plugins/livediff/skills would install twice: once as
  // part of the native plugin, once as the loose portable skill the skills CLI discovers.
  const relativeToPlugin = relative(join(root, "plugins", "livediff"), portableSkillRoot);
  assert.ok(
    relativeToPlugin.startsWith(".."),
    "portable skill must not live under plugins/livediff",
  );
  // The skills CLI's standard discovery locations include a plain top-level `skills/`.
  assert.equal(relative(root, portableSkillRoot), join("skills", "livediff"));
});

test("every SKILL.md frontmatter parses as strict YAML", async () => {
  const files = [...(await nativeSkillFiles()), portableSkillPath];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.doesNotThrow(() => parseSkillFile(contents), `${file} has invalid YAML frontmatter`);
  }
});

test("the portable skill frontmatter matches the Agent Skills spec", async () => {
  const contents = await readFile(portableSkillPath, "utf8");
  const { data } = parseSkillFile(contents);

  const name = data["name"];
  assert.equal(typeof name, "string");
  assert.ok(typeof name === "string" && name.length <= 64 && name === "livediff");
  assert.match(typeof name === "string" ? name : "", /^[a-z0-9]+(-[a-z0-9]+)*$/);

  const description = data["description"];
  assert.equal(typeof description, "string");
  assert.ok(
    typeof description === "string" && description.length > 0 && description.length <= 1024,
  );

  const compatibility = data["compatibility"];
  if (typeof compatibility === "string") {
    assert.ok(compatibility.length <= 500);
  }

  const metadata = data["metadata"];
  assert.ok(isRecord(metadata));
  const version = isRecord(metadata) ? metadata["version"] : undefined;
  assert.equal(typeof version, "string");

  const packageManifest = await readObject(join(root, "package.json"));
  assert.equal(version, packageManifest["version"]);
});

test("the portable skill has no Claude-only or cross-referencing constructs", async () => {
  const files = [
    portableSkillPath,
    ...(await readdir(join(portableSkillRoot, "references"))).map((name) =>
      join(portableSkillRoot, "references", name),
    ),
  ];

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.ok(!contents.includes("!`"), `${file} uses Claude-only inline command execution`);
    assert.ok(!contents.includes("$ARGUMENTS"), `${file} references $ARGUMENTS`);
    assert.ok(!/^allowed-tools:/m.test(contents), `${file} declares allowed-tools`);
    assert.ok(!/^disable-model-invocation:/m.test(contents), `${file} uses a Claude-only field`);
    assert.ok(!contents.includes("/livediff:"), `${file} references a Claude slash command`);
  }
});

test("every relative link in the portable skill resolves inside the skill directory", async () => {
  const referenceNames = await readdir(join(portableSkillRoot, "references"));
  const files = [
    portableSkillPath,
    ...referenceNames.map((name) => join(portableSkillRoot, "references", name)),
  ];

  const linkPattern = /\]\(([^)]+)\)/g;

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const match of contents.matchAll(linkPattern)) {
      const target = match[1];
      if (target === undefined) continue;
      if (/^[a-z]+:\/\//i.test(target)) continue; // external URL, not a packaging concern
      const withoutAnchor = target.split("#")[0];
      if (withoutAnchor === undefined || withoutAnchor === "") continue; // pure in-page anchor
      assert.ok(!isAbsolute(withoutAnchor), `${file} links with an absolute path: ${target}`);
      const resolved = join(dirname(file), withoutAnchor);
      const fromSkillRoot = relative(portableSkillRoot, resolved);
      assert.ok(
        !fromSkillRoot.startsWith(".."),
        `${file} links outside the skill directory: ${target}`,
      );
      await assert.doesNotReject(
        readFile(resolved, "utf8"),
        `${file} links to a missing file: ${target}`,
      );
    }
  }
});

test("native plugin manifests are still valid after the portable skill was added", async () => {
  const pluginRoot = join(root, "plugins", "livediff");
  const codexManifest = await readObject(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claudeManifest = await readObject(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const packageManifest = await readObject(join(root, "package.json"));

  assert.equal(codexManifest["name"], "livediff");
  assert.equal(codexManifest["skills"], "./skills");
  assert.equal(claudeManifest["name"], "livediff");
  assert.equal(codexManifest["version"], packageManifest["version"]);
  assert.equal(claudeManifest["version"], packageManifest["version"]);

  // The native skills directory must still contain only the original, product-specific
  // skills — no copy of the portable `livediff` skill leaking in alongside them.
  const nativeSkillsDir = join(pluginRoot, "skills");
  const nativeSkillNames = await readdir(nativeSkillsDir);
  assert.ok(!nativeSkillNames.includes("livediff"));
});
