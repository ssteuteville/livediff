import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { withTempXdg, makeRepo } from "./helpers.js";
import { writeJsonAtomic } from "../server/atomic.js";
import { registryPath, readRegistry, idFor, configDir } from "../server/registry.js";
import { migrateRegistry } from "../server/migrations.js";
import { listComments } from "../server/comments.js";

/** Seed a pre-0.4 registry that recorded literal (un-normalized) paths. */
async function seedLegacy(entries) {
  await writeJsonAtomic(registryPath(), {
    workspaces: entries.map((p) => ({
      id: idFor(p),
      path: p,
      label: p.split("/").pop(),
      addedAt: "2026-01-01T00:00:00.000Z",
    })),
  });
}

test("collapses a subdirectory entry into its worktree root", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await seedLegacy([repo, join(repo, "src")]);

    const result = await migrateRegistry();

    const workspaces = await readRegistry();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].path, repo);
    assert.equal(result.merged, 1);
  });
});

test("moves comments from the collapsed entry onto the surviving one", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    const subId = idFor(join(repo, "src"));
    const rootId = idFor(repo);
    await seedLegacy([repo, join(repo, "src")]);
    await writeJsonAtomic(join(configDir(), "comments", `${rootId}.json`), {
      comments: [{ id: "aaaaaaaa", body: "from root", status: "open", replies: [] }],
    });
    await writeJsonAtomic(join(configDir(), "comments", `${subId}.json`), {
      comments: [{ id: "bbbbbbbb", body: "from subdir", status: "open", replies: [] }],
    });

    await migrateRegistry();

    const comments = await listComments(rootId, repo, { branch: "all" });
    assert.deepEqual(comments.map((c) => c.id).sort(), ["aaaaaaaa", "bbbbbbbb"]);
    await assert.rejects(() => readFile(join(configDir(), "comments", `${subId}.json`), "utf8"));
  });
});

test("drops entries whose path no longer exists", async () => {
  await withTempXdg(async ({ root }) => {
    await seedLegacy([join(root, "gone")]);
    await migrateRegistry();
    assert.deepEqual(await readRegistry(), []);
  });
});

test("is idempotent", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    await seedLegacy([repo, join(repo, "src")]);
    await migrateRegistry();
    const second = await migrateRegistry();
    assert.equal(second.merged, 0);
    assert.equal(second.normalized, 0);
    assert.equal((await readRegistry()).length, 1);
  });
});
