import { test } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { withTempXdg, makeRepo } from "./helpers.js";
import {
  registryPath,
  readRegistry,
  addWorkspace,
  setWorkspaceBase,
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

test("a workspace defaults to no base, and remembers one once set", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    assert.equal((await addWorkspace(repo)).base, null);

    const updated = await setWorkspaceBase(idFor(repo), "main");
    assert.equal(updated?.base, "main");
    assert.equal((await readRegistry())[0]?.base, "main");
  });
});

test("re-registering a worktree does not clear the base it already has", async () => {
  // `livediff .` is run constantly and must be safe. Silently reverting to HEAD would make every
  // comment on a committed branch look stale again, which is the bug this whole field exists for.
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await addWorkspace(repo);
    await setWorkspaceBase(idFor(repo), "main");

    await addWorkspace(repo);
    await addWorkspace(join(repo, "src"), "relabelled");
    assert.equal((await readRegistry())[0]?.base, "main");
  });
});

test("addWorkspace with an explicit base overwrites, and an empty one clears", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await addWorkspace(repo, undefined, "main");
    assert.equal((await readRegistry())[0]?.base, "main");

    await addWorkspace(repo, undefined, "develop");
    assert.equal((await readRegistry())[0]?.base, "develop");

    await addWorkspace(repo, undefined, null);
    assert.equal((await readRegistry())[0]?.base, null);
  });
});

test("setWorkspaceBase returns null for a workspace that is not registered", async () => {
  await withTempXdg(async () => {
    assert.equal(await setWorkspaceBase("deadbeef", "main"), null);
  });
});

test("a registry written before base existed reads as no base", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const legacy = {
      workspaces: [
        { id: idFor(repo), path: repo, label: "repo", addedAt: new Date().toISOString() },
      ],
    };
    await mkdir(dirname(registryPath()), { recursive: true });
    await writeFile(registryPath(), JSON.stringify(legacy), "utf8");

    const [ws] = await readRegistry();
    assert.equal(ws?.base, null);
    assert.equal(ws?.id, idFor(repo));
  });
});

test("a worktree reached through a symlink resolves to the same workspace", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    const link = join(root, "link");
    await symlink(repo, link);

    const ws = await addWorkspace(repo);
    const linkedWorkspace = await resolveWorkspace({ path: link });
    const linkedSubdirectory = await resolveWorkspace({ path: join(link, "src") });
    assert.ok(linkedWorkspace);
    assert.ok(linkedSubdirectory);
    assert.equal(linkedWorkspace.id, ws.id);
    assert.equal(linkedSubdirectory.id, ws.id);
    assert.equal(await removeWorkspace(link), true);
  });
});
