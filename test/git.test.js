import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTempXdg, makeRepo } from "./helpers.js";
import { changedPaths, currentBranch, summary } from "../server/git.js";

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
