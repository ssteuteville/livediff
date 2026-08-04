import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTempXdg, makeRepo } from "./helpers.js";
import {
  addComment,
  listComments,
  getComment,
  updateComment,
  sweep,
  restoreComment,
  purgeArchived,
  type Comment,
} from "../server/comments.js";
import { configDir } from "../server/registry.js";
import { writeJsonAtomic } from "../server/atomic.js";

const exec = promisify(execFile);
const input = { file: "README.md", side: "new", line: 1, lineContent: "# test\n", body: "fix" };

test("a new comment records the branch it was left on", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    assert.equal(c.branch, "main");
    assert.equal(c.archivedAt, null);
  });
});

test("a comment made on a detached HEAD records (detached)", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["checkout", "-q", head], { cwd: repo });
    const c = await addComment("ws1", repo, input);
    assert.equal(c.branch, "(detached)");
  });
});

test("the store is written keyed by comment id", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    const raw = JSON.parse(await readFile(join(configDir(), "comments", "ws1.json"), "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.comments[c.id].body, "fix");
  });
});

test("getComment finds a record by key", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    const stored = await getComment("ws1", c.id);
    assert.ok(stored);
    assert.equal(stored.id, c.id);
    assert.equal(await getComment("ws1", "nosuchid"), null);
  });
});

test("listComments filters by branch, and 'all' returns everything", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const onMain = await addComment("ws1", repo, input);
    await exec("git", ["checkout", "-qb", "feat"], { cwd: repo });
    const onFeat = await addComment("ws1", repo, input);

    const feat = await listComments("ws1", repo, { branch: "feat" });
    assert.deepEqual(
      feat.map((c) => c.id),
      [onFeat.id],
    );

    const main = await listComments("ws1", repo, { branch: "main" });
    assert.deepEqual(
      main.map((c) => c.id),
      [onMain.id],
    );

    assert.equal((await listComments("ws1", repo, { branch: "all" })).length, 2);
  });
});

test("a comment with no branch matches every branch", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const c = await addComment("ws1", repo, input);
    await updateComment("ws1", repo, c.id, { branch: null });
    assert.equal((await listComments("ws1", repo, { branch: "anything" })).length, 1);
  });
});

test("a v1 array store is read without loss", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeJsonAtomic(join(configDir(), "comments", "ws1.json"), {
      comments: [
        { id: "old00001", file: "a.js", line: 1, body: "legacy", status: "open", replies: [] },
      ],
    });
    const all = await listComments("ws1", repo, { branch: "all" });
    assert.deepEqual(
      all.map((c) => c.id),
      ["old00001"],
    );
  });
});

const DAY = 86_400_000;

/** Seed one record directly, so aged states are testable without waiting days. */
async function seed(over: Partial<Comment> = {}) {
  const { __writeForTest } = await import("../server/comments.js");
  const id = "aaaaaaaa";
  const comment: Comment = {
    id,
    file: "README.md",
    side: "new",
    line: 1,
    lineContent: "# test\n",
    body: "note",
    author: "user",
    status: "open",
    branch: "main",
    archivedAt: null,
    replies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  await __writeForTest("ws1", {
    [id]: comment,
  });
  return id;
}

test("sweep archives an orphaned comment older than 5 days", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed({ updatedAt: new Date(now - 6 * DAY).toISOString() });
    assert.equal((await sweep("ws1", repo, [], { now })).archived, 1);
    const comment = await getComment("ws1", id);
    assert.ok(comment);
    assert.ok(comment.archivedAt);
  });
});

test("sweep leaves an orphaned comment younger than 5 days alone", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed({ updatedAt: new Date(now - 2 * DAY).toISOString() });
    assert.equal((await sweep("ws1", repo, [], { now })).archived, 0);
    const comment = await getComment("ws1", id);
    assert.ok(comment);
    assert.equal(comment.archivedAt, null);
  });
});

test("sweep --stale ignores the age gate", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed();
    assert.equal((await sweep("ws1", repo, [], { now, force: { stale: true } })).archived, 1);
    const comment = await getComment("ws1", id);
    assert.ok(comment);
    assert.ok(comment.archivedAt);
  });
});

test("sweep leaves a comment whose file is still in the diff alone", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed({ updatedAt: new Date(now - 90 * DAY).toISOString() });
    assert.equal((await sweep("ws1", repo, ["README.md"], { now })).archived, 0);
    const comment = await getComment("ws1", id);
    assert.ok(comment);
    assert.equal(comment.archivedAt, null);
  });
});

test("sweep purges a record archived more than 200 days ago", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed({ archivedAt: new Date(now - 201 * DAY).toISOString() });
    assert.equal((await sweep("ws1", repo, [], { now })).purged, 1);
    assert.equal(await getComment("ws1", id), null);
  });
});

test("sweep does not evaluate another branch's comments", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed({
      branch: "other",
      updatedAt: new Date(now - 90 * DAY).toISOString(),
    });
    assert.equal((await sweep("ws1", repo, [], { now })).archived, 0);
    const comment = await getComment("ws1", id);
    assert.ok(comment);
    assert.equal(comment.archivedAt, null);
  });
});

test("restore clears archivedAt and refreshes updatedAt so a sweep does not re-archive", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const now = Date.now();
    const id = await seed({
      updatedAt: new Date(now - 90 * DAY).toISOString(),
      archivedAt: new Date(now - 10 * DAY).toISOString(),
    });
    const restored = await restoreComment("ws1", id);
    assert.ok(restored);
    assert.equal(restored.archivedAt, null);
    assert.equal((await sweep("ws1", repo, [], { now })).archived, 0);
    const comment = await getComment("ws1", id);
    assert.ok(comment);
    assert.equal(comment.archivedAt, null);
  });
});

test("purgeArchived deletes by an explicit window", async () => {
  await withTempXdg(async () => {
    const now = Date.now();
    const id = await seed({ archivedAt: new Date(now - 11 * DAY).toISOString() });
    assert.equal(await purgeArchived("ws1", { olderThanDays: 10, now }), 1);
    assert.equal(await getComment("ws1", id), null);
  });
});
