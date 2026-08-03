import { test } from "vitest";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTempXdg, makeRepo } from "./helpers.js";
import { changedPaths, currentBranch, getDiff, summary, worktreeSignature } from "../server/git.js";

const exec = promisify(execFile);

test("changedPaths reports modified tracked files and untracked ones", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    assert.deepEqual(await changedPaths(repo), []);

    await writeFile(join(repo, "README.md"), "# changed\n", "utf8");
    await writeFile(join(repo, "new.txt"), "hello\n", "utf8");

    const paths = (await changedPaths(repo)).sort();
    assert.deepEqual(paths, ["README.md", "new.txt"]);
  });
});

test("summary's changedFiles count agrees with changedPaths", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "a.txt"), "a\n", "utf8");
    await writeFile(join(repo, "b.txt"), "b\n", "utf8");
    const info = await summary(repo);
    assert.equal(info.changedFiles, (await changedPaths(repo)).length);
  });
});

test("currentBranch reports the branch, and (detached) when detached", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    assert.equal(await currentBranch(repo), "main");

    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["checkout", "-q", head], { cwd: repo });
    assert.equal(await currentBranch(repo), "(detached)");
  });
});

test("the whole-tree split produces the same patches as per-file diffs", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src", "vendor/src"]);
    const files = ["src/a.ts", "vendor/src/a.ts", "with space.ts", "plain.ts"];
    for (const f of files) await writeFile(join(repo, f), "one\ntwo\nthree\n", "utf8");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "base"], { cwd: repo });
    for (const f of files) await writeFile(join(repo, f), "one\nCHANGED\nthree\n", "utf8");

    const diff = await getDiff(repo, null);
    assert.equal(diff.files.length, files.length);

    // Every patch must match what a dedicated per-file spawn returns.
    for (const file of diff.files) {
      const { stdout } = await exec("git", ["diff", "HEAD", "--", file.path], { cwd: repo });
      assert.equal(file.patch, stdout, `patch mismatch for ${file.path}`);
    }
  });
});

test("a path that is a suffix of another is not mis-attributed", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["vendor/src"]);
    await writeFile(join(repo, "a.ts"), "short\n", "utf8");
    await writeFile(join(repo, "vendor/src/a.ts"), "long\n", "utf8");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "base"], { cwd: repo });
    await writeFile(join(repo, "a.ts"), "short changed\n", "utf8");
    await writeFile(join(repo, "vendor/src/a.ts"), "long changed\n", "utf8");

    const diff = await getDiff(repo, null);
    const shallow = diff.files.find((f) => f.path === "a.ts");
    const deep = diff.files.find((f) => f.path === "vendor/src/a.ts");
    assert.match(shallow.patch, /short changed/);
    assert.doesNotMatch(shallow.patch, /long changed/);
    assert.match(deep.patch, /long changed/);
  });
});

test("a deleted file still produces its patch", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "doomed.ts"), "bye\n", "utf8");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "base"], { cwd: repo });
    await rm(join(repo, "doomed.ts"));

    const diff = await getDiff(repo, null);
    const gone = diff.files.find((f) => f.path === "doomed.ts");
    assert.ok(gone, "deleted file missing from the diff");
    assert.equal(gone.status, "deleted");
    assert.match(gone.patch, /-bye/);
  });
});

test("a synthesized untracked patch matches git's own --no-index output", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "new.ts"), "alpha\nbeta\ngamma\n", "utf8");

    const diff = await getDiff(repo, null);
    const added = diff.files.find((f) => f.path === "new.ts");
    assert.equal(added.status, "added");
    assert.equal(added.additions, 3);

    // Compare the parts a diff viewer actually renders: the hunk header and the body.
    const { stdout } = await exec(
      "git",
      ["diff", "--no-index", "--", "/dev/null", "new.ts"],
      { cwd: repo }
    ).catch((e) => ({ stdout: e.stdout }));
    const hunkOf = (p) => p.slice(p.indexOf("@@"));
    assert.equal(hunkOf(added.patch), hunkOf(stdout));
  });
});

test("an untracked file with no trailing newline is marked as such", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "bare.txt"), "no newline here", "utf8");

    const diff = await getDiff(repo, null);
    const added = diff.files.find((f) => f.path === "bare.txt");
    assert.equal(added.additions, 1);
    assert.match(added.patch, /\\ No newline at end of file/);
  });
});

test("an untracked binary file is reported as binary, not as text", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    const diff = await getDiff(repo, null);
    const added = diff.files.find((f) => f.path === "blob.bin");
    assert.equal(added.binary, true);
    assert.equal(added.additions, 0);
  });
});

test("an empty untracked file produces a zero-line patch", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "empty.txt"), "", "utf8");

    const diff = await getDiff(repo, null);
    const added = diff.files.find((f) => f.path === "empty.txt");
    assert.equal(added.additions, 0);
    assert.equal(added.binary, false);
  });
});

test("the worktree signature notices an edit to an already-modified file", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    const file = join(repo, "README.md");

    const clean = await worktreeSignature(repo, null);

    // The easy case: a file joins the changed set, so status alone would catch it.
    await writeFile(file, "# one\n", "utf8");
    const firstEdit = await worktreeSignature(repo, null);
    assert.notEqual(firstEdit, clean);

    // The case livediff exists for, and the one status alone misses: editing it again. The set of
    // changed files is identical, so only size and mtime can tell these apart.
    await writeFile(file, "# two, a different length entirely\n", "utf8");
    const secondEdit = await worktreeSignature(repo, null);
    assert.notEqual(secondEdit, firstEdit, "a second edit must move the signature");
  });
});

test("the worktree signature is stable when nothing changes", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await writeFile(join(repo, "a.txt"), "a\n", "utf8");
    const first = await worktreeSignature(repo, null);
    assert.equal(await worktreeSignature(repo, null), first, "a poll must not report phantom changes");
  });
});

test("a rename's origin path is not stat'd as a changed file of its own", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await exec("git", ["mv", "README.md", "RENAMED.md"], { cwd: repo });
    const sig = await worktreeSignature(repo, null);
    assert.ok(sig.includes("RENAMED.md"));
    assert.ok(!sig.includes("|-"), "a missing stat would mean the origin path was treated as real");
  });
});
