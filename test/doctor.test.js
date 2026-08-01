import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempXdg, makeRepo } from "./helpers.js";
import { writeJsonAtomic } from "../server/atomic.js";
import { registryPath, idFor } from "../server/registry.js";
import { writeState } from "../server/hub-state.js";
import { diagnose } from "../server/doctor.js";

const find = (findings, title) => findings.find((f) => f.title.includes(title));

test("a clean install reports no errors", async () => {
  await withTempXdg(async () => {
    const findings = await diagnose("0.4.0");
    assert.equal(findings.some((f) => f.level === "error"), false);
    assert.ok(find(findings, "hub"));
    assert.ok(find(findings, "registry"));
  });
});

test("state pointing at a dead pid is reported as stale", async () => {
  await withTempXdg(async () => {
    await writeState({
      pid: 0x7ffffffe,
      port: 4203,
      version: "0.4.0",
      startedAt: new Date().toISOString(),
    });
    const findings = await diagnose("0.4.0");
    const hub = find(findings, "stale hub state");
    assert.ok(hub, `expected a stale-state finding, got ${JSON.stringify(findings)}`);
    assert.equal(hub.level, "warn");
    assert.match(hub.detail, /dead pid/);
  });
});

test("a non-toplevel registry entry is reported as needing migration", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    const sub = join(repo, "src");
    await writeJsonAtomic(registryPath(), {
      workspaces: [{ id: idFor(sub), path: sub, label: "src", addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const findings = await diagnose("0.4.0");
    const registry = find(findings, "registry needs migration");
    assert.ok(registry, `expected a migration finding, got ${JSON.stringify(findings)}`);
    assert.match(registry.detail, /not a worktree root/);
  });
});

test("a leftover .diff-review directory is reported", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await mkdir(join(repo, ".diff-review"), { recursive: true });
    await writeFile(join(repo, ".diff-review", "comments.json"), '{"comments":[]}', "utf8");
    await writeJsonAtomic(registryPath(), {
      workspaces: [{ id: idFor(repo), path: repo, label: "repo", addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const findings = await diagnose("0.4.0");
    const legacy = find(findings, ".diff-review");
    assert.ok(legacy, `expected a legacy-dir finding, got ${JSON.stringify(findings)}`);
    assert.equal(legacy.level, "warn");
  });
});

test("a leftover pre-0.5 skill directory is an error", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "skills", "open-worktree-diff");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "old\n", "utf8");

    const findings = await diagnose("0.5.0");
    const legacy = find(findings, "legacy skill directory");
    assert.ok(legacy, `expected a legacy-skill finding, got ${JSON.stringify(findings)}`);
    assert.equal(legacy.level, "error");
    assert.match(legacy.fix, /rm -rf/);
  });
});

test("a plugin at a different version is a warning", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "plugins", "cache", "local", "livediff", "0.4.0", ".claude-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "livediff", version: "0.4.0" }), "utf8");

    const findings = await diagnose("0.5.0");
    const skew = find(findings, "plugin version differs");
    assert.ok(skew, `expected a skew finding, got ${JSON.stringify(findings)}`);
    assert.equal(skew.level, "warn");
    assert.match(skew.detail, /CLI 0\.5\.0, plugin 0\.4\.0/);
  });
});

test("a matching plugin version is clean", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "plugins", "cache", "local", "livediff", "0.5.0", ".claude-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "livediff", version: "0.5.0" }), "utf8");

    const findings = await diagnose("0.5.0");
    assert.equal(findings.some((f) => f.level === "error"), false);
    assert.match(find(findings, "claude plugin").detail, /0\.5\.0/);
  });
});

test("the newest cached plugin version wins", async () => {
  await withTempXdg(async ({ home }) => {
    for (const v of ["0.4.0", "0.10.0"]) {
      const dir = join(home, ".claude", "plugins", "cache", "local", "livediff", v, ".claude-plugin");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "livediff", version: v }), "utf8");
    }
    const findings = await diagnose("0.10.0");
    assert.match(find(findings, "claude plugin").detail, /0\.10\.0/);
  });
});

test("every finding carries a level and a title", async () => {
  await withTempXdg(async () => {
    for (const f of await diagnose("0.4.0")) {
      assert.ok(["ok", "warn", "error"].includes(f.level), `bad level: ${f.level}`);
      assert.ok(f.title, "finding is missing a title");
    }
  });
});
