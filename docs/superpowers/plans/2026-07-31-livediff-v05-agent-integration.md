# livediff v0.5 Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single copied `SKILL.md` with four plugin-delivered skills, and change the CLI so those skills can be short, cheap, and single-turn.

**Architecture:** Comment filtering and rendering move into a pure `server/comment-format.js` module so they can be unit-tested without spawning a hub. The CLI gains a `--status` filter and honest browser-launch reporting. `doctor` swaps its skill-content check for a plugin-version check. `install.sh` stops copying the skill and instead removes the legacy copy.

**Tech Stack:** Node >= 18, ESM, `node:test`, no runtime dependencies in `server/`.

## Global Constraints

- Target version is **0.5.0** in both `package.json` and `.claude-plugin/plugin.json`.
- `package.json` keeps `"private": true`. Do not publish.
- No new runtime dependencies. `server/` uses only Node builtins.
- Node >= 18: do not use `fs.promises.glob` (Node 22+) or any newer API.
- Tests run with `pnpm test` (`node --test test/*.test.js`). Never `npm`.
- Shell rules: one command per invocation, no `&&`/`||`/`|`/`;`, never `git -C`.
- Commit style: `type(scope): subject`, scope `livediff`.
- `--json` output shape for comments keeps its existing fields; only filtering applies to it.
- No skill file may mention `doctor`, `list`, `stop`, ports, or hub state.

---

## File Structure

**Create:**
- `server/comment-format.js` — pure filtering/rendering of comments. No I/O.
- `test/comment-format.test.js` — unit tests for the above.
- `skills/open/SKILL.md`, `skills/comments/SKILL.md`, `skills/link/SKILL.md`, `skills/review/SKILL.md`

**Delete:**
- `skills/open-worktree-diff/SKILL.md` (and its directory)

**Modify:**
- `server/cli.js` — `cmdComments` filtering, `cmdOpen`/`cmdHubUi` open reporting
- `server/cli-help.js` — `VALUE_FLAGS`, `comments` entry, `doctor` details, `ENVIRONMENT`; remove `REMOVED_COMMANDS`
- `server/open-browser.js` — async, returns success, honours `LIVEDIFF_BROWSER`
- `server/doctor.js` — replace `checkSkill` with `checkPlugin`
- `test/cli.test.js` — existing round-trip test needs `--status all`
- `test/doctor.test.js` — replace the two stale-skill tests
- `install.sh`, `package.json`, `.claude-plugin/plugin.json`, `README.md`, `DESIGN.md`

---

### Task 1: Comment filtering and formatting

**Files:**
- Create: `server/comment-format.js`
- Test: `test/comment-format.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `COMMENT_STATUSES: string[]` — `["open", "resolved", "all"]`
  - `filterByStatus(comments: Comment[], status: string): Comment[]`
  - `formatComments(comments: Comment[]): string`
  - `emptyMessage(allComments: Comment[], status: string): string`

  A `Comment` has `{ id, file, line, lineContent, body, status, replies }`.

- [ ] **Step 1: Write the failing test**

Create `test/comment-format.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_STATUSES,
  filterByStatus,
  formatComments,
  emptyMessage,
} from "../server/comment-format.js";

const comment = (over = {}) => ({
  id: "aaaaaaaa",
  file: "src/app.js",
  line: 12,
  lineContent: "  const x = 1;\n",
  body: "rename this",
  status: "open",
  replies: [],
  ...over,
});

test("COMMENT_STATUSES lists exactly the accepted values", () => {
  assert.deepEqual(COMMENT_STATUSES, ["open", "resolved", "all"]);
});

test("filterByStatus selects by status, and 'all' passes everything", () => {
  const list = [comment(), comment({ id: "bbbbbbbb", status: "resolved" })];
  assert.deepEqual(filterByStatus(list, "open").map((c) => c.id), ["aaaaaaaa"]);
  assert.deepEqual(filterByStatus(list, "resolved").map((c) => c.id), ["bbbbbbbb"]);
  assert.equal(filterByStatus(list, "all").length, 2);
});

test("formatComments prints id, location, the quoted anchor, and the body", () => {
  const text = formatComments([comment()]);
  assert.equal(text, "aaaaaaaa  src/app.js:12\n    | const x = 1;\n    rename this");
});

test("formatComments truncates a long anchor to 120 characters", () => {
  const long = "x".repeat(300);
  const text = formatComments([comment({ lineContent: long })]);
  const anchorLine = text.split("\n").find((l) => l.startsWith("    | "));
  const anchor = anchorLine.slice("    | ".length);
  assert.equal(anchor.length, 120);
  assert.ok(anchor.endsWith("…"));
});

test("formatComments omits the anchor line when there is no line content", () => {
  const text = formatComments([comment({ lineContent: "   \n" })]);
  assert.doesNotMatch(text, /\|/);
});

test("formatComments counts replies, singular and plural", () => {
  const one = formatComments([comment({ replies: [{ body: "a" }] })]);
  assert.match(one, /\(1 reply\)/);
  const two = formatComments([comment({ replies: [{ body: "a" }, { body: "b" }] })]);
  assert.match(two, /\(2 replies\)/);
});

test("formatComments omits the reply line when there are none", () => {
  assert.doesNotMatch(formatComments([comment()]), /repl/);
});

test("emptyMessage reports a bare absence when there are no comments at all", () => {
  assert.equal(emptyMessage([], "open"), "no comments");
});

test("emptyMessage names the comments hidden by the filter", () => {
  const list = [comment({ status: "resolved" }), comment({ id: "b", status: "resolved" })];
  assert.equal(emptyMessage(list, "open"), "no open comments (2 resolved — see --status all)");
});

test("emptyMessage omits the count when the other status is also empty", () => {
  assert.equal(emptyMessage([comment()], "resolved"), "no resolved comments");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '.../server/comment-format.js'`

- [ ] **Step 3: Write the implementation**

Create `server/comment-format.js`:

```js
/** Filtering and rendering for review comments. Pure — no I/O, no hub, no process state. */

export const COMMENT_STATUSES = ["open", "resolved", "all"];

const MAX_ANCHOR = 120;

export function filterByStatus(comments, status) {
  return status === "all" ? comments : comments.filter((c) => c.status === status);
}

/**
 * The quoted source line an agent should anchor on. Line numbers drift as files are edited;
 * this text does not, so it is worth the extra line of output.
 */
function anchor(lineContent) {
  const text = String(lineContent ?? "").trim();
  if (!text) return null;
  return text.length > MAX_ANCHOR ? `${text.slice(0, MAX_ANCHOR - 1)}…` : text;
}

export function formatComments(comments) {
  return comments
    .flatMap((c) => {
      const lines = [`${c.id}  ${c.file}:${c.line}`];
      const quoted = anchor(c.lineContent);
      if (quoted) lines.push(`    | ${quoted}`);
      lines.push(`    ${c.body}`);
      const n = c.replies?.length ?? 0;
      if (n) lines.push(`    (${n} ${n === 1 ? "reply" : "replies"})`);
      return lines;
    })
    .join("\n");
}

/** Shown when the filter matched nothing, so a filtered-empty result never reads as breakage. */
export function emptyMessage(allComments, status) {
  if (!allComments.length) return "no comments";
  const other = status === "open" ? "resolved" : "open";
  const hidden = allComments.filter((c) => c.status === other).length;
  if (!hidden) return `no ${status} comments`;
  return `no ${status} comments (${hidden} ${other} — see --status all)`;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm test`
Expected: PASS — all 10 new tests, plus the existing 60.

- [ ] **Step 5: Commit**

```bash
git add server/comment-format.js test/comment-format.test.js
```

```bash
git commit -m "feat(livediff): add comment filtering and agent-readable formatting"
```

---

### Task 2: Wire `--status` into the CLI

**Files:**
- Modify: `server/cli-help.js:17` (`VALUE_FLAGS`), `server/cli-help.js:89-97` (`comments` entry)
- Modify: `server/cli.js:179-190` (`cmdComments`)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `COMMENT_STATUSES`, `filterByStatus`, `formatComments`, `emptyMessage` from `server/comment-format.js`.
- Produces: `livediff comments [path] [--status open|resolved|all]`, defaulting to `open`.

- [ ] **Step 1: Fix the existing test that the new default breaks**

`test/cli.test.js:110` currently reads a resolved comment back with no filter. With the new default of `open` it would find nothing. Change that one line:

```js
      const after = JSON.parse((await cli(["comments", repo, "--json", "--status", "all"])).stdout);
```

Leave the other `comments` calls in that file alone — they read open comments and stay correct.

- [ ] **Step 2: Write the failing tests**

Append to `test/cli.test.js`:

```js
test("comments filters by --status and defaults to open", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
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
    const repo = await makeRepo(join(root, "repo"));
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
    const repo = await makeRepo(join(root, "repo"));
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
    const repo = await makeRepo(join(root, "repo"));
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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm test`
Expected: FAIL — the default still shows resolved comments, and `--status pending` is accepted.

- [ ] **Step 4: Register the flag**

In `server/cli-help.js`, change line 17:

```js
export const VALUE_FLAGS = new Set(["--timeout", "--status"]);
```

Replace the `comments` entry (currently lines 89-97) with:

```js
  {
    id: "comments",
    name: "comments",
    usage: "livediff comments [path] [--status open|resolved|all]",
    summary: "print review comments for a worktree",
    details:
      "Defaults to the worktree containing the current directory, and to the open\n" +
      "comments only. Each comment prints the quoted source line it was left on —\n" +
      "trust that text over the line number, which drifts as the file is edited.",
    flags: [["--status <which>", "open (default), resolved, or all"]],
    examples: [
      ["livediff comments", "open comments on this worktree"],
      ["livediff comments --status all", "every comment, resolved included"],
      ["livediff comments --json", "machine-readable output"],
    ],
  },
```

- [ ] **Step 5: Apply the filter in the CLI**

In `server/cli.js`, add to the imports near the top:

```js
import { COMMENT_STATUSES, filterByStatus, formatComments, emptyMessage } from "./comment-format.js";
```

Replace `cmdComments` (currently lines 179-190) with:

```js
async function cmdComments(pathArg) {
  const status = values.get("--status") ?? "open";
  if (!COMMENT_STATUSES.includes(status)) {
    await die(`--status must be one of: ${COMMENT_STATUSES.join(", ")}`, EXIT_USAGE);
  }
  const base = await ensureHub();
  const ws = await resolveWs(base, pathArg);
  const { comments } = await api(base, `/api/comments?ws=${ws.id}`);
  const selected = filterByStatus(comments, status);
  if (JSON_OUT) return out("", { workspace: ws.id, comments: selected });
  if (!selected.length) return console.log(emptyMessage(comments, status));
  console.log(formatComments(selected));
}
```

Validating before `ensureHub()` is deliberate: a usage error must not start a server.

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/cli.js server/cli-help.js test/cli.test.js
```

```bash
git commit -m "feat(livediff): filter comments by status and print the source anchor"
```

---

### Task 3: Report browser launch failures honestly

**Files:**
- Modify: `server/open-browser.js` (whole file)
- Modify: `server/cli.js:120-155` (`cmdOpen`, `cmdHubUi`)
- Modify: `server/cli-help.js:190-195` (`ENVIRONMENT` block)
- Test: `test/cli.test.js`

**Interfaces:**
- Produces: `openBrowser(url: string): Promise<boolean>` — resolves `true` when a browser was launched. Replaces the previous synchronous, void version.
- Produces: `LIVEDIFF_BROWSER` env var overriding the opener command.
- Produces: `"opened": boolean` in the JSON output of the open and hub commands.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test("a failed browser launch is reported instead of claimed as success", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
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
    const repo = await makeRepo(join(root, "repo"));
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
    const repo = await makeRepo(join(root, "repo"));
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
```

`true` and `false` are real executables on macOS and Linux that exit 0 and 1 respectively, which makes both paths testable without a browser.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test`
Expected: FAIL — output says `opened` regardless, and `opened` is absent from JSON.

- [ ] **Step 3: Rewrite the opener**

Replace all of `server/open-browser.js`:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function opener() {
  if (process.env.LIVEDIFF_BROWSER) return process.env.LIVEDIFF_BROWSER;
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "explorer";
  return "xdg-open";
}

/**
 * Launch a browser, resolving to whether it worked. Never throws: a failed launch is worth
 * reporting but never worth failing a command over — the workspace is registered either way.
 */
export async function openBrowser(url) {
  const command = opener();
  try {
    await exec(command, [url]);
    return true;
  } catch {
    // `explorer` exits non-zero even when it succeeds, so its status carries no information.
    // An explicit LIVEDIFF_BROWSER is still reported honestly.
    return process.platform === "win32" && !process.env.LIVEDIFF_BROWSER;
  }
}
```

- [ ] **Step 4: Report the result in the CLI**

In `server/cli.js`, replace the body of `cmdOpen` between the `url` assignment and the `--wait` check (currently lines 128-131) with:

```js
  const url = `http://localhost:${new URL(base).port}/?ws=${ws.id}&focus=1`;
  const quiet = flags.has("--no-open");
  const opened = quiet ? false : await openBrowser(url);
  const human = quiet
    ? `registered ${ws.label} → ${url}`
    : opened
      ? `opened ${ws.label} → ${url}`
      : `registered ${ws.label} → ${url} (could not open a browser)`;
  out(human, { ...ws, url, opened });
```

In the same file, replace `cmdHubUi` (currently lines 149-155) with:

```js
async function cmdHubUi() {
  const base = await ensureHub();
  const url = `http://localhost:${new URL(base).port}/`;
  const quiet = flags.has("--no-open");
  const opened = quiet ? false : await openBrowser(url);
  const note = !quiet && !opened ? " (could not open a browser)" : "";
  out(`livediff → ${url}${note}`, { url, opened });
}
```

The `--wait` summary further down in `cmdOpen` also spreads `{ ...ws, url, ... }`; add `opened` to it so the JSON shape stays consistent:

```js
  out(`review complete ✓ — ${comments.length} ${plural} (${open} open)`, {
    ...ws,
    url,
    opened,
    review: "done",
    comments: comments.length,
    openComments: open,
  });
```

- [ ] **Step 5: Document the variable**

In `server/cli-help.js`, add a row to the `ENVIRONMENT` block in `renderMainHelp` (currently lines 190-195), after the `LIVEDIFF_POLL_MS` row:

```js
      ["LIVEDIFF_BROWSER", "command used to open URLs (default: the OS opener)"],
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/open-browser.js server/cli.js server/cli-help.js test/cli.test.js
```

```bash
git commit -m "fix(livediff): report browser launch failures instead of claiming success"
```

---

### Task 4: The four plugin skills

**Files:**
- Create: `skills/open/SKILL.md`, `skills/comments/SKILL.md`, `skills/link/SKILL.md`, `skills/review/SKILL.md`
- Delete: `skills/open-worktree-diff/SKILL.md`
- Modify: `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: `livediff comments --status open` from Task 2; the failure wording `could not open a browser` from Task 3.
- Produces: `/livediff:open`, `/livediff:comments`, `/livediff:link`, `/livediff:review`.

There is no unit test here — these are markdown read by a model. Step 6 is a manual check.

- [ ] **Step 1: Remove the old skill**

```bash
git rm -r skills/open-worktree-diff
```

- [ ] **Step 2: Create `skills/open/SKILL.md`**

```markdown
---
name: open
description: Show the user the current git worktree as a live browser diff they can comment on.
when_to_use: "show me the diff", "open a diff", "open livediff", "let me see your changes", "give me a link to the diff", "review my changes in the browser"
allowed-tools: Bash(livediff *)
---

# Show a worktree in livediff

Pick one row. Run it once. Do not check anything first — there is no server to start
and no state worth inspecting.

| The user wants | Run |
| --- | --- |
| to see the diff | `livediff .` |
| a link or URL, not a browser | `livediff . --no-open` |
| a specific worktree | `livediff <path>` |
| every registered worktree | `livediff` |

Each prints a URL. Give it to the user.

If the output says it could not open a browser, pass the URL along and say so — the
worktree is registered either way.
```

- [ ] **Step 3: Create `skills/comments/SKILL.md`**

The `` !`…` `` line runs before the model sees the file; its output replaces the placeholder.

````markdown
---
name: comments
description: Read the user's inline livediff review comments and act on them.
when_to_use: "address my comments", "what did I comment", "check the diff feedback", "handle my review notes", or after the user says they left comments
allowed-tools: Bash(livediff *)
---

# Open review comments

!`livediff comments --status open`

The comments above are already loaded. Do not run the command again.

Each entry gives an id, `file:line`, the quoted source line, and the user's note.
**Trust the quoted line over the line number** — numbers drift as you edit, the quoted
text is the anchor.

Work through them, then close each one:

```bash
livediff resolve <id> <what you did>   # replies and resolves in one call
livediff reply   <id> <your question>  # replies without resolving
```

Use `reply` when you need the user to clarify. The browser updates live.

If nothing is listed above, there are no open comments — say so and stop. If an error
appears instead, the current directory is not a registered worktree; tell the user.
````

- [ ] **Step 4: Create `skills/link/SKILL.md`**

```markdown
---
name: link
description: Print the livediff URL for this worktree without opening a browser.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

!`livediff . --no-open`

Give the user the URL above and nothing else.
```

- [ ] **Step 5: Create `skills/review/SKILL.md`**

```markdown
---
name: review
description: Open this worktree in livediff and wait until the user finishes reviewing.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

Run `livediff . --wait` as a **background** command. A review takes longer than any
foreground command timeout allows, and backgrounding keeps the session usable while
the user reads.

When it exits it prints a summary. Open comments in that summary are the work you are
being handed, not an error — load `/livediff:comments` and address them.
```

- [ ] **Step 6: Bump the plugin manifest**

Edit `.claude-plugin/plugin.json` — set `"version": "0.5.0"` and replace the description:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "livediff",
  "version": "0.5.0",
  "description": "Show a git worktree as a live browser diff and act on the review comments left on it",
  "author": { "name": "Shane" },
  "keywords": ["git", "diff", "review", "worktree", "code-review"]
}
```

Also update the plugin's `description` in `.claude-plugin/marketplace.json` to the same string, so the two manifests agree.

- [ ] **Step 7: Verify the frontmatter parses and no skill names a forbidden command**

Run: `grep -rn "doctor\|livediff list\|livediff stop" skills/`
Expected: no output. Any hit violates the global constraint and must be removed.

Run: `head -8 skills/open/SKILL.md`
Expected: the YAML block is delimited by `---` on the first and last lines, with no tabs.

- [ ] **Step 8: Commit**

```bash
git add -A skills .claude-plugin
```

```bash
git commit -m "feat(livediff): replace the copied skill with four plugin skills"
```

---

### Task 5: `doctor` checks the plugin, not skill contents

**Files:**
- Modify: `server/doctor.js:9` (import), `server/doctor.js:148-172` (`checkSkill`), `server/doctor.js:175-188` (`diagnose`)
- Modify: `server/cli-help.js:24` (delete `REMOVED_COMMANDS`), `server/cli-help.js:128-142` (`doctor` details)
- Test: `test/doctor.test.js:67-90`

**Interfaces:**
- Consumes: nothing new.
- Produces: a `checkPlugin(version)` finding titled `claude plugin`, `legacy skill directory`, or `plugin version differs from the CLI`.

- [ ] **Step 1: Replace the two stale-skill tests**

In `test/doctor.test.js`, delete both existing tests spanning lines 67-90 (`"a Claude skill referencing removed commands is an error"` and `"a Claude skill using only current commands is clean"`) and put these in their place:

```js
test("a leftover pre-0.5 skill directory is an error", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "skills", "open-worktree-diff");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "old\n", "utf8");

    const findings = await diagnose("0.5.0");
    const legacy = find(findings, "legacy skill directory");
    assert.ok(legacy, `expected a legacy-skill finding, got ${JSON.stringify(findings)}`);
    assert.equal(legacy.level, "error");
    assert.match(legacy.fix, /rm -rf/);
  });
});

test("a plugin at a different version is a warning", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "plugins", "cache", "local", "livediff", "0.4.0", ".claude-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "livediff", version: "0.4.0" }), "utf8");

    const findings = await diagnose("0.5.0");
    const skew = find(findings, "plugin version differs");
    assert.ok(skew, `expected a skew finding, got ${JSON.stringify(findings)}`);
    assert.equal(skew.level, "warn");
    assert.match(skew.detail, /CLI 0\.5\.0, plugin 0\.4\.0/);
  });
});

test("a matching plugin version is clean", async () => {
  await withTempXdg(async ({ home }) => {
    const dir = join(home, ".claude", "plugins", "cache", "local", "livediff", "0.5.0", ".claude-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "livediff", version: "0.5.0" }), "utf8");

    const findings = await diagnose("0.5.0");
    assert.equal(findings.some((f) => f.level === "error"), false);
    assert.match(find(findings, "claude plugin").detail, /0\.5\.0/);
  });
});

test("the newest cached plugin version wins", async () => {
  await withTempXdg(async ({ home }) => {
    for (const v of ["0.4.0", "0.10.0"]) {
      const dir = join(home, ".claude", "plugins", "cache", "local", "livediff", v, ".claude-plugin");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "plugin.json"), JSON.stringify({ name: "livediff", version: v }), "utf8");
    }
    const findings = await diagnose("0.10.0");
    assert.match(find(findings, "claude plugin").detail, /0\.10\.0/);
  });
});
```

The last test guards a real trap: `"0.10.0"` sorts before `"0.4.0"` as a string, so the version comparison must be numeric per segment.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test`
Expected: FAIL — no finding titled `legacy skill directory` or `plugin version differs`.

- [ ] **Step 3: Replace the check**

In `server/doctor.js`, delete line 9 (`import { REMOVED_COMMANDS } from "./cli-help.js";`) and delete `removedCommandPattern` and `checkSkill` (currently lines 148-172). Put this in their place:

```js
/** Numeric per-segment comparison: "0.10.0" is newer than "0.4.0", which string order gets wrong. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Highest livediff version present in the plugin cache, or null when it is not installed. */
async function installedPluginVersion() {
  const cache = join(homedir(), ".claude", "plugins", "cache");
  let marketplaces = [];
  try {
    marketplaces = await readdir(cache);
  } catch {
    return null;
  }
  const found = [];
  for (const marketplace of marketplaces) {
    const dir = join(cache, marketplace, "livediff");
    let versions = [];
    try {
      versions = await readdir(dir);
    } catch {
      continue;
    }
    for (const version of versions) {
      try {
        const raw = await readFile(join(dir, version, ".claude-plugin", "plugin.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.version) found.push(parsed.version);
      } catch {
        /* not a plugin directory */
      }
    }
  }
  return found.sort(compareVersions).pop() ?? null;
}

/**
 * Pre-0.5 installers copied the skill into ~/.claude/skills. The plugin now owns it, so that
 * copy is a second, stale answer to the same question — it never updates and its instructions
 * compete with the plugin's for the model's attention.
 */
async function checkPlugin(version) {
  const legacy = join(homedir(), ".claude", "skills", "open-worktree-diff");
  try {
    await access(legacy);
    return bad(
      "legacy skill directory left by a pre-0.5 install",
      `${legacy} is a stale copy of the skill; the plugin supplies it now.`,
      `rm -rf ${legacy}`
    );
  } catch {
    /* nothing to clean up */
  }

  const installed = await installedPluginVersion();
  if (!installed) return ok("claude plugin", "not installed (the CLI works without it)");
  if (installed !== version) {
    return warn(
      "plugin version differs from the CLI",
      `CLI ${version}, plugin ${installed}`,
      "Run `/plugin update livediff` in Claude Code."
    );
  }
  return ok("claude plugin", `v${installed}`);
}
```

In `diagnose`, replace `checkSkill()` with `checkPlugin(version)` in the `checks` array.

The existing imports at the top of `doctor.js` already include `access`, `readFile`, `readdir`, `homedir`, and `join`, so no import changes are needed beyond deleting line 9.

- [ ] **Step 4: Drop the now-unused export**

In `server/cli-help.js`, delete the `REMOVED_COMMANDS` export and its comment (lines 19-24). `doctor.js` was its only consumer.

Verify nothing else references it:

Run: `grep -rn "REMOVED_COMMANDS" server test`
Expected: no output.

- [ ] **Step 5: Correct the `doctor` help text**

In `server/cli-help.js`, replace the `details` string of the `doctor` entry:

```js
    details:
      "Checks that livediff resolves to exactly one binary, that the running hub\n" +
      "matches this CLI's version, that no stale state or unmigrated registry\n" +
      "entries remain, and that the Claude plugin is at a matching version.\n" +
      "Exits non-zero if anything is actually broken.",
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/doctor.js server/cli-help.js test/doctor.test.js
```

```bash
git commit -m "feat(livediff): check the plugin version instead of skill contents"
```

---

### Task 6: Installer migration, version bump, and docs

**Files:**
- Modify: `install.sh:104-129`
- Modify: `package.json:5`
- Modify: `README.md`, `DESIGN.md`

**Interfaces:**
- Consumes: the `doctor` finding from Task 5 (the installer's `livediff doctor` run surfaces it).
- Produces: an installer that removes the legacy skill copy rather than creating one.

- [ ] **Step 1: Bump the package version**

In `package.json`, change `"version": "0.4.0"` to `"version": "0.5.0"`. Leave `"private": true` alone.

- [ ] **Step 2: Replace the skill-install block in `install.sh`**

Delete lines 104-111 (the `SKILL_SRC` / `SKILL_DST` block) and put this in their place:

```bash
# --- Migrate off the copied skill ---
# Pre-0.5 installs copied the skill into ~/.claude/skills. The plugin owns it now; leaving the
# copy behind means two stale-able answers to the same question.
LEGACY_SKILL="$HOME/.claude/skills/open-worktree-diff"
if [ -d "$LEGACY_SKILL" ]; then
  info "Removing the pre-0.5 skill copy → $LEGACY_SKILL"
  rm -rf "$LEGACY_SKILL"
  ok "Legacy skill removed"
fi
```

- [ ] **Step 3: Point the closing message at the plugin**

Replace the closing `cat <<EOF` block (currently lines 121-129) with:

```bash
cat <<EOF

$(ok "Done.")

  cd <any git worktree> && livediff .

That registers the worktree, starts the hub if it isn't running, and opens the
diff.

For Claude Code, install the plugin once — it supplies the skills and the
/livediff:link and /livediff:review commands:

  /plugin marketplace add $SCRIPT_DIR
  /plugin install livediff

Then say "show me the diff", or type /livediff:link for just the URL.
EOF
```

- [ ] **Step 4: Run the installer and confirm the migration**

Run: `./install.sh`
Expected: reports `✓ livediff v0.5.0`, prints `Legacy skill removed` (the directory exists on this machine), and `livediff doctor` finishes without an error-level finding.

- [ ] **Step 5: Update `README.md`**

Line 34 currently claims the installer "installs the Claude skill into `~/.claude/skills/`". Replace that sentence with:

```markdown
then removes any skill copy left by a pre-0.5 install. Run `./install.sh --dev` instead to link
```

Add a section after the install instructions:

````markdown
## Claude Code

Install the plugin once; it supplies the skills and commands:

```
/plugin marketplace add /path/to/livediff
/plugin install livediff
```

| You say or type | What happens |
| --- | --- |
| "show me the diff" | registers this worktree and opens it |
| "address my comments" | reads your open comments and works through them |
| `/livediff:link` | prints the URL, opens nothing |
| `/livediff:review` | opens the diff and waits for you to finish reviewing |

The last two are typed-only on purpose: both have side effects whose timing you should own.
````

- [ ] **Step 6: Update `DESIGN.md`**

Add this section at the end:

````markdown
## Agent integration

Four skills, shipped by the plugin, with no MCP server. An MCP tool definition costs
context in every conversation whether or not it is used; livediff is a local binary on
`PATH` with no auth, so MCP would charge permanently to wrap a 240ms subprocess — and would
drop every agent that speaks shell but not MCP.

`open` and `comments` are model-invocable, matching the two things users ask for in prose.
`link` and `review` set `disable-model-invocation: true`, which removes them from the model's
context entirely and leaves them typable as `/livediff:link` and `/livediff:review`.

`comments` and `link` use `` !`…` `` injection, so the CLI runs before the model reads the
skill and the output arrives already rendered. That removes two model turns from the
address-my-comments loop, which is where the latency actually was — the CLI itself answers
in 240ms.

The plugin ships skills and no code. The CLI stays a global install, so the agent and the
human run the same binary; `doctor` reports the two-artifact version skew that buys.
````

- [ ] **Step 7: Run the full suite one last time**

Run: `pnpm test`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
git add install.sh package.json README.md DESIGN.md
```

```bash
git commit -m "chore(livediff): migrate off the copied skill and release 0.5.0"
```

---

## Manual verification

Automated tests cannot exercise model behaviour. After Task 6, install the plugin and check
the four reported failures are gone:

1. `/plugin marketplace add <repo>` then `/plugin install livediff`, and restart Claude Code.
2. Say **"show me the diff"** → exactly one `livediff .` call, no pre-flight check.
3. Say **"just give me a link to the diff"** → a URL, no browser.
4. Type **`/livediff:link`** → a URL and nothing else.
5. Leave a comment in the browser, then say **"address my comments"** → the comment is already
   in context with no visible tool call.
6. Type **`/livediff:review`** → runs in the background, and the session stays usable.
7. Run `livediff doctor` → `claude plugin  v0.5.0`, no error findings.
