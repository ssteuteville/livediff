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

test("a Claude skill referencing removed commands is an error", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "skills", "open-worktree-diff");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "Run `livediff add \"$REPO\"` then share the URL.\n", "utf8");

    const findings = await diagnose("0.4.0");
    const skill = find(findings, "removed commands");
    assert.ok(skill, `expected a stale-skill finding, got ${JSON.stringify(findings)}`);
    assert.equal(skill.level, "error");
    assert.match(skill.detail, /livediff add/);
  });
});

test("a Claude skill using only current commands is clean", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "skills", "open-worktree-diff");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "Run `livediff \"$REPO\"` then `livediff comments`.\n", "utf8");

    const findings = await diagnose("0.4.0");
    assert.equal(findings.some((f) => f.level === "error"), false);
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
