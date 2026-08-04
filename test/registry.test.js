import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { withTempXdg, makeRepo } from "./helpers.js";
import {
  registryPath,
  readRegistry,
  addWorkspace,
  idFor,
  resolveWorkspace,
  removeWorkspace,
} from "../server/registry.js";

test("registryPath follows XDG_CONFIG_HOME set after import", async () => {
  await withTempXdg(async ({ config }) => {
    assert.equal(registryPath(), join(config, "livediff", "workspaces.json"));
  });
});

test("readRegistry returns an empty list when no registry exists", async () => {
  await withTempXdg(async () => {
    assert.deepEqual(await readRegistry(), []);
  });
});

test("a subdirectory registers as the worktree root, not itself", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src/deep"]);
    const ws = await addWorkspace(join(repo, "src", "deep"));
    assert.equal(ws.path, repo);
    assert.equal(ws.id, idFor(repo));
  });
});

test("registering root then a subdirectory yields one workspace", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await addWorkspace(repo);
    await addWorkspace(join(repo, "src"));
    assert.equal((await readRegistry()).length, 1);
  });
});

test("addWorkspace rejects a path that is not a git worktree", async () => {
  await withTempXdg(async ({ root }) => {
    await assert.rejects(() => addWorkspace(root), /not a git worktree/);
  });
});

test("a worktree reached through a symlink resolves to the same workspace", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    const link = join(root, "link");
    await symlink(repo, link);

    const ws = await addWorkspace(repo);
    assert.equal((await resolveWorkspace({ path: link })).id, ws.id);
    assert.equal((await resolveWorkspace({ path: join(link, "src") })).id, ws.id);
    assert.equal(await removeWorkspace(link), true);
  });
});
