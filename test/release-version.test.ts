import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  checkVersions,
  writeVersion,
  jsonTarget,
  frontmatterTarget,
  type VersionTarget,
} from "../scripts/release-version.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonField(path: string, key: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return isRecord(parsed) ? parsed[key] : undefined;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "release-version-test-"));
  tempDirs.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

function targets(root: string): VersionTarget[] {
  return [
    jsonTarget("package.json", undefined, root),
    jsonTarget("release.json", (json, version) => (json["cliRange"] = `>=${version}`), root),
    frontmatterTarget("SKILL.md", root),
  ];
}

test("checkVersions reports agreement when every target matches", async () => {
  const root = await fixture({
    "package.json": '{"name":"x","version":"1.2.3"}\n',
    "release.json": '{"version":"1.2.3","cliRange":">=1.2.3"}\n',
    "SKILL.md": '---\nname: livediff\nmetadata:\n  version: "1.2.3"\n---\nbody\n',
  });
  const result = await checkVersions(targets(root));
  assert.equal(result.ok, true);
  assert.equal(result.versions.length, 3);
});

test("checkVersions reports disagreement when one target drifts", async () => {
  const root = await fixture({
    "package.json": '{"name":"x","version":"1.2.3"}\n',
    "release.json": '{"version":"1.2.4","cliRange":">=1.2.4"}\n',
    "SKILL.md": '---\nname: livediff\nmetadata:\n  version: "1.2.3"\n---\nbody\n',
  });
  const result = await checkVersions(targets(root));
  assert.equal(result.ok, false);
});

test("writeVersion updates package.json, release.json's cliRange, and SKILL.md frontmatter together", async () => {
  const root = await fixture({
    "package.json": '{"name":"x","version":"1.2.3"}\n',
    "release.json": '{"version":"1.2.3","cliRange":">=1.2.3"}\n',
    "SKILL.md": '---\nname: livediff\nmetadata:\n  version: "1.2.3"\n---\nbody\n',
  });
  await writeVersion("1.3.0", targets(root));

  const skill = await readFile(join(root, "SKILL.md"), "utf8");

  assert.equal(await readJsonField(join(root, "package.json"), "version"), "1.3.0");
  assert.equal(await readJsonField(join(root, "release.json"), "version"), "1.3.0");
  assert.equal(await readJsonField(join(root, "release.json"), "cliRange"), ">=1.3.0");
  assert.match(skill, /version: "1\.3\.0"/);
  assert.match(skill, /^body$/m);

  const result = await checkVersions(targets(root));
  assert.equal(result.ok, true);
});

test("writeVersion rejects a non-semver string and writes nothing", async () => {
  const root = await fixture({
    "package.json": '{"name":"x","version":"1.2.3"}\n',
    "release.json": '{"version":"1.2.3","cliRange":">=1.2.3"}\n',
    "SKILL.md": '---\nname: livediff\nmetadata:\n  version: "1.2.3"\n---\nbody\n',
  });
  await assert.rejects(() => writeVersion("not-a-version", targets(root)));
  assert.equal(await readJsonField(join(root, "package.json"), "version"), "1.2.3");
});

test("frontmatterTarget fails loudly when no version line is present", async () => {
  const root = await fixture({
    "SKILL.md": "---\nname: livediff\n---\nbody\n",
  });
  const target = frontmatterTarget("SKILL.md", root);
  await assert.rejects(() => checkVersions([target]), /no "version:" line found/);
});
