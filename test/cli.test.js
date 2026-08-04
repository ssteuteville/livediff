import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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

/**
 * A repo with an actual working-tree change. A comment is only live while its file is in the
 * diff, so a test that posts one on an untouched committed file would see it hidden as orphaned.
 */
async function dirtyRepo(root, name = "repo") {
  const repo = await makeRepo(join(root, name));
  await writeFile(join(repo, "README.md"), "# test\nedited\n", "utf8");
  return repo;
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
    const repo = await dirtyRepo(root);
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
    const repo = await dirtyRepo(root);
    await cli([repo, "--no-open"]);
    assert.ok((await readState()).pid);
    const res = await cli(["stop"]);
    assert.equal(res.code, 0);
    assert.equal(await readState(), null);
  });
});

test("comments round-trip through the CLI without touching files", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
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

      const after = JSON.parse((await cli(["comments", repo, "--json", "--status", "all"])).stdout);
      assert.equal(after.comments[0].status, "resolved");
      assert.equal(after.comments[0].replies.length, 1);
    } finally {
      await stopHub();
    }
  });
});

test("--wait blocks until the review is marked done, then summarizes", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const waiting = cli([repo, "--no-open", "--wait"]);

      // Wait for the CLI to have registered the workspace and opened its review request.
      let review = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !review) {
        const state = await readState();
        if (state) {
          const ws = await fetch(
            `http://127.0.0.1:${state.port}/api/resolve?path=${encodeURIComponent(repo)}`,
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
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const created = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "check offset" }),
      }).then((r) => r.json());

      const res = await cli(["reply", created.id, "-1", "is", "the", "right", "offset"], {
        cwd: repo,
      });
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

test("a failed browser launch is reported instead of claimed as success", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const res = await cli([repo], { env: { LIVEDIFF_BROWSER: "false" } });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /could not open a browser/);
      assert.match(res.stdout, /http:\/\/localhost:\d+/);
    } finally {
      await stopHub();
    }
  });
});

test("a successful browser launch reports opened, and JSON carries the flag", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const res = await cli([repo, "--json"], { env: { LIVEDIFF_BROWSER: "true" } });
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.stdout).opened, true);

      const failed = await cli([repo, "--json"], { env: { LIVEDIFF_BROWSER: "false" } });
      assert.equal(JSON.parse(failed.stdout).opened, false);
    } finally {
      await stopHub();
    }
  });
});

test("--no-open never claims a browser was opened", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const res = await cli([repo, "--no-open", "--json"]);
      assert.equal(JSON.parse(res.stdout).opened, false);
      const text = await cli([repo, "--no-open"]);
      assert.match(text.stdout, /^registered /);
      assert.doesNotMatch(text.stdout, /could not open/);
    } finally {
      await stopHub();
    }
  });
});

test("comments filters by --status and defaults to open", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const post = (body) =>
        fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: "README.md", side: "new", line: 1, body }),
        }).then((r) => r.json());

      const kept = await post("still open");
      const closed = await post("will be resolved");
      await cli(["resolve", closed.id, "done"], { cwd: repo });

      const dflt = (await cli(["comments", repo])).stdout;
      assert.match(dflt, /still open/);
      assert.doesNotMatch(dflt, /will be resolved/);

      const resolved = (await cli(["comments", repo, "--status", "resolved"])).stdout;
      assert.match(resolved, /will be resolved/);
      assert.doesNotMatch(resolved, /still open/);

      const all = (await cli(["comments", repo, "--status", "all"])).stdout;
      assert.match(all, /still open/);
      assert.match(all, /will be resolved/);

      assert.ok(kept.id);
    } finally {
      await stopHub();
    }
  });
});

test("comments prints the quoted source line as an anchor", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      // The server stores lineContent as given and defaults it to "" (server/comments.js) —
      // the browser is what supplies it, so a test posting directly must send it too.
      await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file: "README.md",
          side: "new",
          line: 1,
          lineContent: "# test\n",
          body: "fix",
        }),
      });
      const text = (await cli(["comments", repo])).stdout;
      assert.match(text, /\| # test/);
    } finally {
      await stopHub();
    }
  });
});

test("an empty filter result names the comments it hid", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const state = await readState();
      const made = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "fix" }),
      }).then((r) => r.json());
      await cli(["resolve", made.id, "done"], { cwd: repo });

      const text = (await cli(["comments", repo])).stdout;
      assert.match(text, /no open comments \(1 resolved — see --status all\)/);
    } finally {
      await stopHub();
    }
  });
});

test("a worktree with no comments at all says so without a count", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const text = (await cli(["comments", repo])).stdout;
      assert.match(text, /^no comments$/m);
    } finally {
      await stopHub();
    }
  });
});

test("an invalid --status exits 2 without starting a hub", async () => {
  await withTempXdg(async () => {
    const res = await cli(["comments", "--status", "pending"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--status must be one of: open, resolved, all/);
    assert.equal(await readState(), null);
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

/** Post a comment straight to the hub, as the browser would. */
async function post(port, wsId, body, file = "README.md") {
  return fetch(`http://127.0.0.1:${port}/api/comments?ws=${wsId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, side: "new", line: 1, lineContent: "# test\n", body }),
  }).then((r) => r.json());
}

test("comments are scoped to the branch they were left on", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      await post((await readState()).port, ws.id, "on main");
      assert.match((await cli(["comments", repo])).stdout, /on main/);

      await exec("git", ["checkout", "-qb", "feat"], { cwd: repo });
      assert.doesNotMatch((await cli(["comments", repo])).stdout, /on main/);
      assert.match((await cli(["comments", repo, "--branch", "all"])).stdout, /on main/);
    } finally {
      await stopHub();
    }
  });
});

test("a comment whose file left the diff is hidden, and --stale shows it", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      await post((await readState()).port, ws.id, "orphan me", "gone.txt");

      assert.doesNotMatch((await cli(["comments", repo])).stdout, /orphan me/);
      assert.match((await cli(["comments", repo, "--stale"])).stdout, /orphan me/);
    } finally {
      await stopHub();
    }
  });
});

test("archive then restore round-trips a comment through the archive", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      const made = await post((await readState()).port, ws.id, "keep me", "gone.txt");

      await cli(["archive", repo, "--stale"]);
      assert.match((await cli(["comments", repo, "--archived"])).stdout, /purges in \d+ days/);

      const res = await cli(["restore", made.id], { cwd: repo });
      assert.equal(res.code, 0);
      assert.match((await cli(["comments", repo, "--stale"])).stdout, /keep me/);
    } finally {
      await stopHub();
    }
  });
});

test("archive defaults to every workspace and a path narrows it", async () => {
  await withTempXdg(async ({ root }) => {
    const a = await makeRepo(join(root, "a"));
    const b = await makeRepo(join(root, "b"));
    try {
      for (const repo of [a, b]) {
        const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
        await post((await readState()).port, ws.id, "note", "gone.txt");
      }

      await cli(["archive", a, "--stale"]);
      assert.match((await cli(["comments", a, "--archived"])).stdout, /note/);
      assert.doesNotMatch((await cli(["comments", b, "--archived"])).stdout, /note/);

      await cli(["archive", "--stale"]);
      assert.match((await cli(["comments", b, "--archived"])).stdout, /note/);
    } finally {
      await stopHub();
    }
  });
});

test("prune --dry-run reports without deleting and never prompts", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      await post((await readState()).port, ws.id, "note", "gone.txt");
      await cli(["archive", repo, "--stale"]);

      const dry = await cli(["prune", repo, "--all", "--dry-run"]);
      assert.equal(dry.code, 0);
      assert.match(dry.stdout, /would delete 1 archived comment/);
      assert.match((await cli(["comments", repo, "--archived"])).stdout, /note/);
    } finally {
      await stopHub();
    }
  });
});

test("prune --all refuses to prompt without a terminal", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      await post((await readState()).port, ws.id, "note", "gone.txt");
      await cli(["archive", repo, "--stale"]);

      const res = await cli(["prune", repo, "--all"]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /--yes/);
    } finally {
      await stopHub();
    }
  });
});

test("prune --all --yes empties the archive", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      await post((await readState()).port, ws.id, "note", "gone.txt");
      await cli(["archive", repo, "--stale"]);

      const res = await cli(["prune", repo, "--all", "--yes"]);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /pruned 1 archived comment/);
      assert.doesNotMatch((await cli(["comments", repo, "--archived"])).stdout, /note/);
    } finally {
      await stopHub();
    }
  });
});

test("prune rejects --keep-days together with --all", async () => {
  await withTempXdg(async () => {
    const res = await cli(["prune", "--keep-days", "10", "--all"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--keep-days and --all/);
    assert.equal(await readState(), null);
  });
});

test("--stale and --archived together exit 2 without starting a hub", async () => {
  await withTempXdg(async () => {
    const res = await cli(["comments", "--stale", "--archived"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--stale and --archived/);
    assert.equal(await readState(), null);
  });
});

test("a subdirectory registers the worktree root and scopes the view with dir", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"), ["apps/expo"]);
    try {
      const res = JSON.parse((await cli([join(repo, "apps/expo"), "--no-open", "--json"])).stdout);
      assert.equal(res.path, repo, "should register the worktree root, not the subdirectory");
      assert.equal(res.dir, "apps/expo");
      assert.match(res.url, /&dir=apps%2Fexpo$/);

      const list = JSON.parse((await cli(["list", "--json"])).stdout);
      assert.equal(list.workspaces.length, 1, "a subdirectory must not create a second workspace");
    } finally {
      await stopHub();
    }
  });
});

test("the worktree root itself carries no dir scope", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const res = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);
      assert.equal(res.dir, null);
      assert.doesNotMatch(res.url, /dir=/);
    } finally {
      await stopHub();
    }
  });
});

test("LIVEDIFF_BROWSER accepts a command with arguments", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      // `echo` alone succeeds; the point is that a command *with* args also resolves and runs,
      // which is what an opener like `cmux open-window` or `code --open-url` needs.
      const res = await cli([repo, "--json"], { env: { LIVEDIFF_BROWSER: "echo opening" } });
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.stdout).opened, true);
    } finally {
      await stopHub();
    }
  });
});

test("a multi-word LIVEDIFF_BROWSER that fails is still reported honestly", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const res = await cli([repo, "--json"], { env: { LIVEDIFF_BROWSER: "false --ignored" } });
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.stdout).opened, false);
    } finally {
      await stopHub();
    }
  });
});
