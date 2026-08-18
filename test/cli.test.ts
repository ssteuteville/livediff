import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFile, writeFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { withTempXdg, makeRepo } from "./helpers.js";
import { readState, probeMeta } from "../server/hub-state.js";
import { parseHighlightArg } from "../server/cli-args.js";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist-server/server/cli.js", import.meta.url));

/** Run the CLI with the ambient temp XDG env. Never throws — returns the failure for assertions. */
type CliOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
};

type CliResult = {
  code: number;
  stderr: string;
  stdout: string;
};

function isProcessError(
  error: unknown,
): error is { code?: unknown; stderr?: unknown; stdout?: unknown } {
  return typeof error === "object" && error !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("config commands initialize, validate, and update JSONC settings", async () => {
  await withTempXdg(async ({ config }) => {
    const initialized = await cli(["config", "init"]);
    assert.equal(initialized.code, 0);

    const path = join(config, "livediff", "config.jsonc");
    assert.match(await readFile(path, "utf8"), /\$schema/);

    const set = await cli(["config", "set", "retention.archiveWarningBytes", "8000000"]);
    assert.equal(set.code, 0);
    const get = await cli(["config", "get", "retention.archiveWarningBytes"]);
    assert.equal(get.stdout.trim(), "8000000");
    const valid = await cli(["config", "validate"]);
    assert.equal(valid.code, 0);

    const schema = await cli(["config", "schema", "--update"]);
    assert.equal(schema.code, 0);
    assert.match(schema.stdout, /updated/);
  });
});

test("config commands explain and unset typed overrides", async () => {
  await withTempXdg(async () => {
    const set = await cli(["config", "set", "retention.archiveWarningBytes", "10MiB"]);
    assert.equal(set.code, 0);
    assert.match(set.stdout, /set retention\.archiveWarningBytes/);

    const explained = await cli(["config", "explain", "retention.archiveWarningBytes"]);
    assert.equal(explained.code, 0);
    assert.match(explained.stdout, /value: 10485760/);
    assert.match(explained.stdout, /source: file/);

    const unset = await cli(["config", "unset", "retention.archiveWarningBytes"]);
    assert.equal(unset.code, 0);
    assert.match(unset.stdout, /unset retention\.archiveWarningBytes/);
    const current = await cli(["config", "get", "retention.archiveWarningBytes"]);
    assert.equal(current.stdout.trim(), "5242880");
  });
});

test("config edit creates a schema-linked config through the selected editor", async () => {
  await withTempXdg(async ({ config }) => {
    const edited = await cli(["config", "edit"], { env: { LIVEDIFF_EDITOR: "true" } });
    assert.equal(edited.code, 0);
    assert.match(edited.stdout, /updated/);
    assert.match(await readFile(join(config, "livediff", "config.jsonc"), "utf8"), /\$schema/);
  });
});

test("explicit commands and nested config help are discoverable without starting a hub", async () => {
  await withTempXdg(async () => {
    const openHelp = await cli(["help", "open"]);
    assert.equal(openHelp.code, 0);
    assert.match(openHelp.stdout, /livediff open \[path\]/);

    const configSetHelp = await cli(["config", "set", "--help"]);
    assert.equal(configSetHelp.code, 0);
    assert.match(configSetHelp.stdout, /livediff config set <key> <value\.\.\./);
    assert.equal(await readState(), null);
  });
});

test("unknown and incomplete options fail before starting a hub", async () => {
  await withTempXdg(async () => {
    const unknown = await cli(["comments", "--sttaus", "open"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown option '--sttaus' for 'livediff comments'/);

    const incomplete = await cli(["comments", "--status"]);
    assert.equal(incomplete.code, 2);
    assert.match(incomplete.stderr, /--status requires a value/);

    const extra = await cli(["list", "unexpected"]);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /unexpected argument 'unexpected' for 'livediff list'/);
    assert.equal(await readState(), null);
  });
});

test("status reports state without starting a hub", async () => {
  await withTempXdg(async () => {
    const result = await cli(["status", "--json"]);
    assert.equal(result.code, 0);
    const status: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(status));
    assert.deepEqual(status["hub"], { status: "stopped" });
    assert.equal(typeof status["configPath"], "string");
    assert.equal(await readState(), null);
  });
});

test("completion validates its shell without starting a hub", async () => {
  await withTempXdg(async () => {
    const result = await cli(["completion", "powershell"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown completion action/);
    assert.equal(await readState(), null);
  });
});

test("completion actions have strict nested help and arguments", async () => {
  await withTempXdg(async () => {
    const help = await cli(["completion", "install", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /livediff completion install/);

    const extra = await cli(["completion", "zsh", "unexpected"]);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /unexpected argument 'unexpected'/);
    assert.equal(await readState(), null);
  });
});

test("completion installs, reports, and removes an opt-in script", async () => {
  await withTempXdg(async () => {
    const installed = await cli(["completion", "install", "fish", "--json"]);
    assert.equal(installed.code, 0);
    const installBody: unknown = JSON.parse(installed.stdout);
    assert.ok(isRecord(installBody));
    assert.equal(installBody["installed"], true);
    assert.equal(installBody["activated"], false);

    const status = await cli(["completion", "status", "fish", "--json"]);
    assert.equal(status.code, 0);
    const statusBody: unknown = JSON.parse(status.stdout);
    assert.ok(isRecord(statusBody));
    assert.equal(statusBody["installed"], true);

    const removed = await cli(["completion", "uninstall", "fish", "--json"]);
    assert.equal(removed.code, 0);
    const removedBody: unknown = JSON.parse(removed.stdout);
    assert.ok(isRecord(removedBody));
    assert.equal(removedBody["installed"], false);
    assert.equal(await readState(), null);
  });
});

test("completion activation changes only LiveDiff's marked shell block", async () => {
  await withTempXdg(async ({ root }) => {
    const env = { HOME: root };
    const installed = await cli(["completion", "install", "zsh", "--activate"], { env });
    assert.equal(installed.code, 0);
    const startup = join(root, ".zshrc");
    assert.match(await readFile(startup, "utf8"), />>> livediff completion >>>/);

    const removed = await cli(["completion", "uninstall", "zsh", "--deactivate"], { env });
    assert.equal(removed.code, 0);
    assert.doesNotMatch(await readFile(startup, "utf8"), />>> livediff completion >>>/);
  });
});

test("help honors the global JSON output contract", async () => {
  await withTempXdg(async () => {
    const result = await cli(["config", "edit", "--help", "--json"]);
    assert.equal(result.code, 0);
    const body: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(body));
    const help = body["help"];
    assert.equal(typeof help, "string");
    if (typeof help !== "string") throw new Error("expected help output");
    assert.match(help, /livediff config edit/);
    assert.equal(await readState(), null);
  });
});

test("help --json emits a full CLI introspection descriptor", async () => {
  await withTempXdg(async () => {
    const result = await cli(["help", "--json"]);
    assert.equal(result.code, 0);
    const body: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(body));
    assert.equal(body["schemaVersion"], 1);
    assert.equal(typeof body["version"], "string");
    const commands = body["commands"];
    assert.ok(Array.isArray(commands));
    const configSet = (commands as unknown[]).find(
      (c) => isRecord(c) && c["name"] === "config set",
    );
    assert.ok(isRecord(configSet));
    const configSetArgs = configSet["arguments"];
    assert.ok(Array.isArray(configSetArgs));
    const key = (configSetArgs as unknown[]).find((a) => isRecord(a) && a["name"] === "key");
    assert.ok(isRecord(key));
    assert.equal(key["required"], true);
    assert.equal(await readState(), null);
  });
});

test("resolve still requires an id", async () => {
  await withTempXdg(async () => {
    // `resolve <id>` with no reply text is now valid, but running it here would start a hub —
    // its arity is asserted from the registry instead. This covers the remaining boundary.
    const res = await cli(["resolve"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /missing required argument/);
    assert.equal(await readState(), null);
  });
});

test("help config renders the top-level command, not a nested action", async () => {
  await withTempXdg(async () => {
    const config = await cli(["help", "config"]);
    assert.equal(config.code, 0);
    assert.match(config.stdout, /^livediff config —/);

    const completion = await cli(["help", "completion"]);
    assert.equal(completion.code, 0);
    assert.match(completion.stdout, /^livediff completion —/);
    assert.equal(await readState(), null);
  });
});

test("help resolve --json includes the rendered help text and structured arguments", async () => {
  await withTempXdg(async () => {
    const result = await cli(["help", "resolve", "--json"]);
    assert.equal(result.code, 0);
    const body: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(body));
    assert.equal(typeof body["help"], "string");
    const args = body["arguments"];
    assert.ok(Array.isArray(args));
    const text = (args as unknown[]).find((a) => isRecord(a) && a["name"] === "text");
    assert.ok(isRecord(text));
    assert.equal(text["required"], false);
    assert.equal(text["variadic"], true);
    assert.equal(await readState(), null);
  });
});

async function cli(args: readonly string[], opts: CliOptions = {}): Promise<CliResult> {
  try {
    const child = exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, LIVEDIFF_PORT: "4197", NO_COLOR: "1", ...opts.env },
      cwd: opts.cwd,
    });
    child.child.stdin?.end(opts.input);
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (!isProcessError(err)) return { code: 1, stdout: "", stderr: "" };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
    };
  }
}

/**
 * A repo with an actual working-tree change. A comment is only live while its file is in the
 * diff, so a test that posts one on an untouched committed file would see it hidden as orphaned.
 */
async function dirtyRepo(root: string, name = "repo") {
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

async function hubPort(): Promise<number> {
  const state = await readState();
  assert.ok(state);
  return state.port;
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
      const state = await readState();
      assert.ok(state);
      assert.ok(state.pid);
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

test("list --json keeps the live fields the hub adds, not just the registry record", async () => {
  // These come from the hub's summary, not the registry, and agents parse them. Naming only the
  // fields the CLI itself reads when parsing a workspace would silently drop them.
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      await cli([repo, "--no-open", "--json"]);
      const list = JSON.parse((await cli(["list", "--json"])).stdout);
      const ws = list.workspaces[0];
      for (const field of ["valid", "branch", "head", "changedFiles", "openComments", "addedAt"]) {
        assert.ok(field in ws, `list --json lost ${field}`);
      }
      assert.equal(ws.base, null);
    } finally {
      await stopHub();
    }
  });
});

test("--base is refused when it does not name a ref, instead of being stored", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    try {
      const res = await cli([repo, "--no-open", "--base", "mian"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /not a ref in this worktree/);

      const good = await cli([repo, "--no-open", "--base", "main", "--json"]);
      assert.equal(good.code, 0);
      const list = JSON.parse((await cli(["list", "--json"])).stdout);
      assert.equal(list.workspaces[0].base, "main");
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
    const state = await readState();
    assert.ok(state);
    assert.ok(state.pid);
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
      assert.ok(state);
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

test("state-aware completion prints nothing when no hub is running", async () => {
  await withTempXdg(async () => {
    assert.equal(await readState(), null);
    const workspaces = await cli(["__complete-workspaces"]);
    assert.equal(workspaces.code, 0);
    assert.equal(workspaces.stdout, "");
    const comments = await cli(["__complete-comments", "open"]);
    assert.equal(comments.code, 0);
    assert.equal(comments.stdout, "");
  });
});

test("state-aware completion lists workspaces and comment ids from a running hub", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      const ws = JSON.parse((await cli([repo, "--no-open", "--json"])).stdout);

      const workspaces = await cli(["__complete-workspaces"]);
      assert.equal(workspaces.code, 0);
      assert.ok(workspaces.stdout.includes(`${repo}\t${ws.label}`));

      const state = await readState();
      assert.ok(state);
      const created = await fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "README.md", side: "new", line: 1, body: "fix this please" }),
      }).then((r) => r.json());

      const openComments = await cli(["__complete-comments", "open"], { cwd: repo });
      assert.ok(openComments.stdout.includes(`${created.id}\tfix this please`));

      const resolved = await cli(["resolve", created.id, "done"], { cwd: repo });
      assert.equal(resolved.code, 0);

      // Resolved but not yet archived: it must leave the `open` candidates immediately, rather
      // than lingering there until a sweep runs.
      const afterResolve = await cli(["__complete-comments", "open"], { cwd: repo });
      assert.equal(afterResolve.stdout.includes(created.id), false);

      const archived = await cli(["archive", repo, "--resolved"]);
      assert.equal(archived.code, 0);

      const archivedComments = await cli(["__complete-comments", "archived"], { cwd: repo });
      assert.ok(archivedComments.stdout.includes(created.id));

      const openAfter = await cli(["__complete-comments", "open"], { cwd: repo });
      assert.equal(openAfter.stdout.includes(created.id), false);
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
      assert.ok(state);
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
      const state = await readState();
      assert.ok(state);
      assert.ok(state.pid);
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
      assert.ok(state);
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
      assert.ok(state);
      const addComment = (body: string) =>
        fetch(`http://127.0.0.1:${state.port}/api/comments?ws=${ws.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: "README.md", side: "new", line: 1, body }),
        }).then((r) => r.json());

      const kept = await addComment("still open");
      const closed = await addComment("will be resolved");
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
      assert.ok(state);
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
      assert.ok(state);
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
async function post(port: number, wsId: string, body: string, file = "README.md") {
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
      await post(await hubPort(), ws.id, "on main");
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
      await post(await hubPort(), ws.id, "orphan me", "gone.txt");

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
      const made = await post(await hubPort(), ws.id, "keep me", "gone.txt");

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
        await post(await hubPort(), ws.id, "note", "gone.txt");
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
      await post(await hubPort(), ws.id, "note", "gone.txt");
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
      await post(await hubPort(), ws.id, "note", "gone.txt");
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
      await post(await hubPort(), ws.id, "note", "gone.txt");
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

test("parseHighlightArg accepts a well-formed path:start-end", () => {
  assert.deepEqual(parseHighlightArg("src/retry.ts:88-104"), {
    path: "src/retry.ts",
    start: 88,
    end: 104,
  });
});

test("parseHighlightArg keeps a colon that belongs to the path", () => {
  assert.deepEqual(parseHighlightArg("C:/repo/a.ts:1-2"), {
    path: "C:/repo/a.ts",
    start: 1,
    end: 2,
  });
});

test("parseHighlightArg rejects a value with no colon", () => {
  assert.throws(() => parseHighlightArg("nope"), /path:start-end/);
});

test("parseHighlightArg rejects a value with no range", () => {
  assert.throws(() => parseHighlightArg("src/a.ts"), /path:start-end/);
});

test("parseHighlightArg rejects a non-numeric range", () => {
  assert.throws(() => parseHighlightArg("src/a.ts:one-two"), /path:start-end/);
});

test("parseHighlightArg rejects a start of 0", () => {
  assert.throws(() => parseHighlightArg("src/a.ts:0-5"), /start must be 1 or more/);
});

test("parseHighlightArg rejects an end before start", () => {
  assert.throws(() => parseHighlightArg("src/a.ts:9-4"), /end must not be before start/);
});

test("parseHighlightArg rejects an empty path", () => {
  assert.throws(() => parseHighlightArg(":1-2"), /path:start-end/);
});

test("lens add writes a lens, and lens list --json shows it", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const added = await cli(["lens", "add", "tests", "--path", "test/**", "--why", "coverage"], {
        cwd: repo,
      });
      assert.equal(added.code, 0);

      const listed = await cli(["lens", "list", "--json"], { cwd: repo });
      assert.equal(listed.code, 0);
      const body = JSON.parse(listed.stdout);
      assert.equal(body.lenses.length, 1);
      assert.equal(body.lenses[0].name, "tests");
      assert.equal(body.lenses[0].why, "coverage");
    } finally {
      await stopHub();
    }
  });
});

test("lens add with no --path exits non-zero mentioning --path", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["lens", "add", "tests"], { cwd: repo });
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /--path/);
    } finally {
      await stopHub();
    }
  });
});

test("lens add with a name that fails the naming pattern exits non-zero mentioning the rule", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["lens", "add", "BAD", "--path", "a"], { cwd: repo });
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /lowercase/);
    } finally {
      await stopHub();
    }
  });
});

test("lens add with a malformed --highlight exits non-zero showing the path:start-end form", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["lens", "add", "t", "--path", "test/**", "--highlight", "nope"], {
        cwd: repo,
      });
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /path:start-end/);
    } finally {
      await stopHub();
    }
  });
});

test("lens add with --highlight end before start exits non-zero mentioning end", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(
        ["lens", "add", "t", "--path", "test/**", "--highlight", "test/a.ts:9-4"],
        { cwd: repo },
      );
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /end/);
    } finally {
      await stopHub();
    }
  });
});

test("lens set fed valid JSON on stdin replaces the whole set", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli(["lens", "add", "old", "--path", "old/**"], { cwd: repo });

      const setBody = JSON.stringify({
        lenses: [{ name: "fresh", paths: ["src/**"] }],
      });
      const res = await cli(["lens", "set"], { cwd: repo, input: setBody });
      assert.equal(res.code, 0);

      const listed = await cli(["lens", "list", "--json"], { cwd: repo });
      const body = JSON.parse(listed.stdout);
      assert.deepEqual(
        body.lenses.map((l: { name: string }) => l.name),
        ["fresh"],
      );
    } finally {
      await stopHub();
    }
  });
});

test("lens set fed invalid JSON exits non-zero", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["lens", "set"], { cwd: repo, input: "{ not json" });
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /invalid JSON/);
    } finally {
      await stopHub();
    }
  });
});

test("lens set fed a bad lens shape exits non-zero naming the offending lens index", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const badShape = JSON.stringify({ lenses: [{ name: "Bad Name!", paths: ["a"] }] });
      const res = await cli(["lens", "set"], { cwd: repo, input: badShape });
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /lens 0/);
    } finally {
      await stopHub();
    }
  });
});

test("lens rm on an absent name exits non-zero", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["lens", "rm", "absent"], { cwd: repo });
      assert.notEqual(res.code, 0);
    } finally {
      await stopHub();
    }
  });
});

test("lens clear empties the set", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli(["lens", "add", "a", "--path", "a/**"], { cwd: repo });
      await cli(["lens", "add", "b", "--path", "b/**"], { cwd: repo });

      const cleared = await cli(["lens", "clear"], { cwd: repo });
      assert.equal(cleared.code, 0);

      const listed = await cli(["lens", "list", "--json"], { cwd: repo });
      assert.deepEqual(JSON.parse(listed.stdout).lenses, []);
    } finally {
      await stopHub();
    }
  });
});

test("lens list on an empty set prints a human line and exits 0", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      const res = await cli(["lens", "list"], { cwd: repo });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /no lenses/);
    } finally {
      await stopHub();
    }
  });
});

test("a lens command outside a registered worktree exits non-zero", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "unregistered"));
    try {
      const res = await cli(["lens", "list"], { cwd: repo });
      assert.notEqual(res.code, 0);
    } finally {
      await stopHub();
    }
  });
});

test("open --lens puts the lens in the focused url", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli(["lens", "add", "tests", "--path", "test/**"], { cwd: repo });

      const res = await cli(["open", ".", "--no-open", "--json", "--lens", "tests"], { cwd: repo });
      assert.equal(res.code, 0);
      const body = JSON.parse(res.stdout);
      assert.match(body.url, /[?&]lens=tests(&|$)/);
      assert.equal(body.lens, "tests");
    } finally {
      await stopHub();
    }
  });
});

test("open without --lens leaves lens out of the url entirely", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli(["lens", "add", "tests", "--path", "test/**"], { cwd: repo });

      const res = await cli(["open", ".", "--no-open", "--json"], { cwd: repo });
      assert.equal(res.code, 0);
      const body = JSON.parse(res.stdout);
      assert.doesNotMatch(body.url, /lens=/);
      assert.equal(body.lens, null);
    } finally {
      await stopHub();
    }
  });
});

test("open --lens with an unknown name fails and lists the names that do exist", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli(["lens", "add", "tests", "--path", "test/**"], { cwd: repo });

      const res = await cli(["open", ".", "--no-open", "--lens", "nope"], { cwd: repo });
      assert.notEqual(res.code, 0, "a silently unfiltered diff is worse than a stopped command");
      const output = res.stderr + res.stdout;
      assert.match(output, /unknown lens: nope/);
      assert.match(output, /tests/);
    } finally {
      await stopHub();
    }
  });
});

test("open --lens against an empty set says so rather than printing an empty list", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);

      const res = await cli(["open", ".", "--no-open", "--lens", "nope"], { cwd: repo });
      assert.notEqual(res.code, 0);
      assert.match(res.stderr + res.stdout, /no lenses/);
    } finally {
      await stopHub();
    }
  });
});

test("a lens name is url-encoded in the emitted url", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);
      await cli(["lens", "add", "a-b-c", "--path", "src/**"], { cwd: repo });

      const res = await cli(["open", ".", "--no-open", "--json", "--lens", "a-b-c"], { cwd: repo });
      const body = JSON.parse(res.stdout);
      assert.match(body.url, /[?&]lens=a-b-c(&|$)/);
    } finally {
      await stopHub();
    }
  });
});

test("the cli still runs when invoked through a symlink, as every global install does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "livediff-symlink-"));
  const link = join(dir, "livediff");
  try {
    await symlink(CLI, link);
    const { stdout } = await exec(process.execPath, [link, "--version"]);
    assert.ok(
      stdout.trim().length > 0,
      "stdout must not be empty — an empty stdout with code 0 is the silent no-op bug",
    );
    assert.match(stdout.trim(), /\d+\.\d+\.\d+/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lens writes register an unregistered worktree", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "unregistered"));
    try {
      const added = await cli(["lens", "add", "tests", "--path", "test/**"], { cwd: repo });
      assert.equal(added.code, 0);

      const listed = await cli(["lens", "list", "--json"], { cwd: repo });
      assert.equal(listed.code, 0);
      const body = JSON.parse(listed.stdout);
      assert.equal(body.lenses.length, 1);
      assert.equal(body.lenses[0].name, "tests");
    } finally {
      await stopHub();
    }
  });
});

test('the plural of "lens" is "lenses"', async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await dirtyRepo(root);
    try {
      await cli([repo, "--no-open", "--json"]);

      const setBody = JSON.stringify({
        lenses: [
          { name: "one", paths: ["a/**"] },
          { name: "two", paths: ["b/**"] },
        ],
      });
      const res = await cli(["lens", "set"], { cwd: repo, input: setBody });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /2 lenses/);
      assert.doesNotMatch(res.stdout, /lenss/);
    } finally {
      await stopHub();
    }
  });
});
