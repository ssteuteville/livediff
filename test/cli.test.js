import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withTempXdg, makeRepo } from "./helpers.js";
import { readState, probeMeta } from "../server/hub-state.js";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../server/cli.js", import.meta.url));

/** Run the CLI with the ambient temp XDG env. Never throws — returns the failure for assertions. */
async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, LIVEDIFF_PORT: "4197", NO_COLOR: "1", ...opts.env },
      cwd: opts.cwd,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function stopHub() {
  const state = await readState();
  if (!state) return;
  await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: "POST" }).catch(() => {});
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await probeMeta(state.port, 200))) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("registering a worktree auto-starts the hub", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      assert.equal(await readState(), null);
      const res = await cli([repo, "--no-open", "--json"]);
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.path, repo);
      assert.match(parsed.url, /^http:\/\/localhost:\d+\/\?ws=/);
      assert.ok((await readState()).pid);
    } finally {
      await stopHub();
    }
  });
});

test("registering from a subdirectory yields one workspace", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["src"]);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli([join(repo, "src"), "--no-open", "--json"]);
      const list = JSON.parse((await cli(["list", "--json"])).stdout);
      assert.equal(list.workspaces.length, 1);
      assert.equal(list.workspaces[0].path, repo);
    } finally {
      await stopHub();
    }
  });
});

test("a path that is not a git worktree exits 1 with a clear message", async () => {
  await withTempXdg(async ({ root }) => {
    try {
      const res = await cli([root, "--no-open"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /not a git worktree/);
    } finally {
      await stopHub();
    }
  });
});

test("stop shuts the hub down and clears state", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await cli([repo, "--no-open"]);
    assert.ok((await readState()).pid);
    const res = await cli(["stop"]);
    assert.equal(res.code, 0);
    assert.equal(await readState(), null);
  });
});

test("comments round-trip through the CLI without touching files", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const created = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "fix this" }),
      }).then((r) => r.json());

      const listed = JSON.parse((await cli(["comments", repo, "--json"])).stdout);
      assert.equal(listed.comments.length, 1);
      assert.equal(listed.comments[0].body, "fix this");

      const res = await cli(["resolve", created.id, "done", "--json"], { cwd: repo });
      assert.equal(res.code, 0);

      const after = JSON.parse((await cli(["comments", repo, "--json"])).stdout);
      assert.equal(after.comments[0].status, "resolved");
      assert.equal(after.comments[0].replies.length, 1);
    } finally {
      await stopHub();
    }
  });
});

test("--wait blocks until the review is marked done, then summarizes", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const waiting = cli([repo, "--no-open", "--wait"]);

      // Wait for the CLI to have registered the workspace and opened its review request.
      let review = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !review) {
        const state = await readState();
        if (state) {
          const ws = await fetch(
            `http://127.0.0.1:${state.port}/api/resolve?path=${encodeURIComponent(repo)}`
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (ws) {
            const body = await fetch(`http://127.0.0.1:${state.port}/api/reviews?ws=${ws.id}`)
              .then((r) => r.json())
              .catch(() => ({}));
            review = body.review;
          }
        }
        if (!review) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(review, "CLI never opened a review request");

      const state = await readState();
      await fetch(`http://127.0.0.1:${state.port}/api/reviews/${review.reviewId}/done`, {
        method: "POST",
      });

      const res = await waiting;
      assert.equal(res.code, 0);
      assert.match(res.stdout, /review complete/);
      assert.match(res.stdout, /0 comments \(0 open\)/);
      assert.doesNotMatch(res.stdout, /1 comments/);
    } finally {
      await stopHub();
    }
  });
});

test("bare livediff --no-open starts the hub and prints its URL", async () => {
  await withTempXdg(async () => {
    try {
      const res = await cli(["--no-open", "--json"]);
      assert.equal(res.code, 0);
      assert.match(JSON.parse(res.stdout).url, /^http:\/\/localhost:\d+\/$/);
      assert.ok((await readState()).pid);
    } finally {
      await stopHub();
    }
  });
});

test("reply text starting with a dash survives argument parsing", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const created = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "check offset" }),
      }).then((r) => r.json());

      const res = await cli(["reply", created.id, "-1", "is", "the", "right", "offset"], { cwd: repo });
      assert.equal(res.code, 0);

      const after = JSON.parse((await cli(["comments", repo, "--json"])).stdout);
      assert.equal(after.comments[0].replies[0].body, "-1 is the right offset");
    } finally {
      await stopHub();
    }
  });
});

test("a bare directory name is treated as a path, an unknown word is not", async () => {
  await withTempXdg(async ({ root }) => {
    await makeRepo(join(root, "bare"));
    try {
      const good = await cli(["bare", "--no-open", "--json"], { cwd: root });
      assert.equal(good.code, 0);
      assert.equal(JSON.parse(good.stdout).label, "bare");

      const bad = await cli(["frobnicate", "--no-open"], { cwd: root });
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /unknown command: frobnicate/);
    } finally {
      await stopHub();
    }
  });
});

test("--help prints usage to stdout and exits 0 without starting a hub", async () => {
  await withTempXdg(async () => {
    const res = await cli(["--help"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /USAGE/);
    assert.match(res.stdout, /COMMANDS/);
    assert.match(res.stdout, /EXAMPLES/);
    assert.equal(res.stderr, "");
    assert.equal(await readState(), null);
  });
});

test("per-command help works via both `help <cmd>` and `<cmd> --help`", async () => {
  await withTempXdg(async () => {
    const viaHelp = await cli(["help", "resolve"]);
    const viaFlag = await cli(["resolve", "--help"]);
    assert.equal(viaHelp.code, 0);
    assert.equal(viaFlag.code, 0);
    assert.equal(viaHelp.stdout, viaFlag.stdout);
    assert.match(viaHelp.stdout, /livediff resolve <id> \[text\.\.\.\]/);
    assert.equal(await readState(), null);
  });
});

test("--version prints the version and exits 0", async () => {
  await withTempXdg(async () => {
    const res = await cli(["--version"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
    assert.equal(await readState(), null);
  });
});

test("an unknown command exits 2 and suggests the nearest match", async () => {
  await withTempXdg(async () => {
    const res = await cli(["resolv"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /unknown command: resolv/);
    assert.match(res.stderr, /Did you mean `livediff resolve`\?/);
    assert.equal(res.stdout, "");
    assert.equal(await readState(), null);
  });
});

test("a wholly unrecognizable command exits 2 without a bogus suggestion", async () => {
  await withTempXdg(async () => {
    const res = await cli(["frobnicate"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /unknown command: frobnicate/);
    assert.doesNotMatch(res.stderr, /Did you mean/);
  });
});

test("resolve without an id exits 2 with the command usage", async () => {
  await withTempXdg(async () => {
    const res = await cli(["resolve"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /usage: livediff resolve <id>/);
    assert.equal(await readState(), null);
  });
});
