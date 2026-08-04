# livediff Agent Integration Design

**Status:** approved
**Version target:** 0.5.0

## Problem

The v0.4 agent integration is a single 800-token `SKILL.md` copied into `~/.claude/skills/`
by `install.sh`, alongside a stale `.claude-plugin/` manifest that also claims to provide it.
Four failures were reported from real use:

1. The agent checks whether livediff is running before every command.
2. Asking for "just a link" opens a browser instead.
3. The diff sometimes does not open.
4. The whole interaction is slow.

Measurement disproves the obvious reading of (4). A warm `livediff comments --json` completes
in **240ms**. The latency is model turns, not the subprocess: the current flow costs a skill
activation, a pre-flight check, the real command, and a report — four round trips at seconds
each. The fix is removing turns, not shaving milliseconds.

Cause of (1) is instructive. The v0.4 skill already says _"There is no server to start first."_
The agent checks anyway. A single negative instruction loses to a strong prior about localhost
servers, especially when the same document advertises `doctor` and `list` as things one could
check with.

Cause of (2) is a missing mapping: `--no-open` is documented as _"when the user is not at the
machine"_, which never matches the phrasing "give me a link".

Cause of (3) is partly confirmed and partly not. `openBrowser` discards the opener's exit
status, so `cmdOpen` prints `opened <label>` whether or not a browser launched. That guarantees
a genuine failure is reported as success. Whether the launch itself also fails intermittently is
unconfirmed, and this design does not assume it does — it makes the failure visible so the next
occurrence produces evidence.

## Decision: skills, not MCP

Each MCP tool definition costs 100–500 tokens of context permanently, loaded before the user
types anything; a skill costs ~30–50 tokens until it triggers. MCP earns that cost when it
supplies something a shell cannot — authentication, transport, a persistent connection.
livediff is a local binary on `PATH` with no auth, so an MCP server would wrap a 240ms
subprocess and charge for it in every unrelated conversation. It would also drop Codex, Gemini,
and Antigravity, all of which run shell.

**No MCP server. Skills only, delivered by the plugin.**

## Delivery: the plugin is the only path

Plugin skills load in place from a versioned cache directory. Nothing is copied into
`~/.claude/skills/`, so nothing there can go stale — the failure mode `doctor`'s current
skill check exists to detect.

The plugin ships **skills and no code**. The CLI continues to come from `install.sh` /
pnpm global, so the agent and the human invoke the identical binary. The alternative —
bundling `server/` in the plugin and invoking `node $CLAUDE_PLUGIN_ROOT/server/cli.js` —
removes version skew but puts two copies of the code on disk and stops the skills from
simply saying `livediff`. Skew is instead handled by a `doctor` check.

`install.sh` gains a migration step that deletes the legacy `~/.claude/skills/open-worktree-diff/`
directory and prints the marketplace command.

## Skills

Four skills replace the one. Two are model-invocable because they correspond to natural prose
requests; two are typed-only, which removes them from Claude's context entirely.

| Skill    | Command              | Invocation      | Resting cost |
| -------- | -------------------- | --------------- | ------------ |
| open     | `/livediff:open`     | Claude or typed | ~40 tokens   |
| comments | `/livediff:comments` | Claude or typed | ~40 tokens   |
| link     | `/livediff:link`     | typed only      | 0            |
| review   | `/livediff:review`   | typed only      | 0            |

Total resting cost is roughly 80 tokens, against ~800 paid on every activation today.

`disable-model-invocation: true` on `link` and `review` is deliberate: both have side effects
whose timing the user should own — one bypasses the browser, one blocks.

### `skills/open/SKILL.md`

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

| The user wants               | Run                    |
| ---------------------------- | ---------------------- |
| to see the diff              | `livediff .`           |
| a link or URL, not a browser | `livediff . --no-open` |
| a specific worktree          | `livediff <path>`      |
| every registered worktree    | `livediff`             |

Each prints a URL. Give it to the user.

If the output says the browser could not be opened, pass the URL along and say so —
the worktree is registered either way.
```

The decision table is the fix for failure (2): intent on the left, exactly one command on the
right, at the top of the body rather than buried in prose.

### `skills/comments/SKILL.md`

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
````

Use `reply` when you need the user to clarify. The browser updates live.

If nothing is listed above, there are no open comments — say so and stop. If the command
reported an error instead, the current directory is not a registered worktree; tell the user.

````

The `` !`…` `` line is the fix for failure (4). Output is substituted before Claude reads
anything, so the flow becomes *activate → work* instead of *activate → call → read → work*.

### `skills/link/SKILL.md`

```markdown
---
name: link
description: Print the livediff URL for this worktree without opening a browser.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

!`livediff . --no-open`

Give the user the URL above and nothing else.
````

### `skills/review/SKILL.md`

```markdown
---
name: review
description: Open this worktree in livediff and wait until the user finishes reviewing.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

Run `livediff . --wait` as a **background** command. A review takes longer than any
foreground command timeout allows, and backgrounding means the session stays usable
while the user reads.

When it exits it prints a summary. Open comments in that summary are the work you are
being handed, not an error — load `/livediff:comments` and address them.
```

Backgrounding is required, not stylistic: `--wait` blocks until a human clicks a button,
which routinely exceeds the foreground Bash timeout ceiling.

### What the skills must never mention

No skill names `doctor`, `list`, `stop`, ports, or hub state. Failure (1) persisted despite an
explicit instruction not to check; removing the vocabulary removes the affordance. `doctor`
remains a CLI command for human use.

## CLI changes

### `comments --status open|resolved|all`

Default `open`. An unrecognized value exits 2 with the accepted values. Added to `VALUE_FLAGS`
in `cli-help.js` so the parser consumes its argument.

When the filter yields nothing but other comments exist, the empty state names them, so a
filtered-empty result is never mistaken for breakage:

```
no open comments (2 resolved — see --status all)
```

With no comments at all: `no comments`.

### Text output carries `lineContent`

Today's text format omits `lineContent` while the skill instructs the agent to trust it over
`line`. That contradiction is the only reason the agent reaches for `--json`, which costs
~150 tokens per comment in timestamps, resolved threads, and full reply history.

New format, two lines per comment:

```
f800282c  DESIGN.md:44
    | impossible by construction rather than merely unlikely.
    just commenting to test the feature
    (1 reply)
```

`lineContent` is trimmed of surrounding whitespace and truncated to 120 characters with `…`.
The `(n replies)` line is omitted when there are none. `--json` keeps its current shape —
the UI and existing tests read it.

### Browser launch is reported honestly

`openBrowser` becomes async, awaits the opener, and resolves to a boolean. `cmdOpen` prints
`opened <label> → <url>` on success and `registered <label> → <url> (could not open a browser)`
on failure. The exit code stays 0 in both cases: registration succeeded, and failing the
command would break headless and SSH use where registration is the entire point.

JSON output gains `"opened": true | false`.

A `LIVEDIFF_BROWSER` environment variable overrides the opener command. It makes the failure
path testable by pointing at `false`, and lets users choose a specific browser.

### `doctor`

`checkSkill` is replaced by `checkPlugin`, which:

- reports an **error** if `~/.claude/skills/open-worktree-diff/` still exists, with
  `rm -rf` as the fix — this is the legacy copy that shadows the plugin;
- reports a **warning** if the installed plugin's version differs from the CLI's, with
  `/plugin update livediff` as the fix;
- reports **ok** otherwise, naming the plugin version or noting it is not installed.

It locates the plugin by globbing `~/.claude/plugins/cache/*/livediff/*/plugin.json` and
reading the `version` field, taking the highest version found. If no match exists the plugin
is simply not installed, which is an **ok** finding, not a problem — the CLI works without it.

The current hedge — _"If it came from the plugin system, run `/plugin update livediff`"_ —
is removed. With one delivery path the check no longer has to guess.

## Versioning

`package.json` and `.claude-plugin/plugin.json` both move to `0.5.0`. `plugin.json` is
currently `0.3.0` against a `0.4.0` package; the new `doctor` check makes that class of drift
visible rather than relying on discipline.

## Testing

`node --test test/*.test.js`, extending the existing helpers.

| Test                           | Asserts                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `--status open` hides resolved | only unresolved ids appear                                      |
| `--status resolved` hides open | only resolved ids appear                                        |
| `--status all` shows both      | every id appears                                                |
| default is `open`              | bare `comments` matches `--status open`                         |
| filtered-empty names the rest  | output contains `2 resolved`                                    |
| no comments at all             | output is `no comments`, without a count                        |
| bad `--status` value           | exit 2, message lists open/resolved/all                         |
| text carries the anchor        | output contains the `lineContent` text                          |
| long `lineContent` truncates   | output line is ≤ 120 chars plus prefix, ends `…`                |
| failed open is reported        | `LIVEDIFF_BROWSER=false`, output says it could not open, exit 0 |
| successful open is reported    | `LIVEDIFF_BROWSER=true`, output says `opened`, exit 0           |
| `--json` gains `opened`        | field is a boolean                                              |
| doctor flags the legacy dir    | seeded dir under temp `HOME` produces an `error` finding        |
| doctor flags version skew      | plugin.json at a different version produces a `warn` finding    |

The existing `withTempXdg` helper already overrides `HOME`, which the two `doctor` tests
depend on.

Skill files are markdown and are not unit-tested. They are verified by installing the plugin
and running the four flows by hand — the failure modes here are model-behavioral, and only
real invocation exercises them.

## Out of scope

- An MCP server, now or as a later addition.
- Bundling the CLI inside the plugin.
- A portable fallback document for non-Claude agents. They get the CLI, which is
  self-documenting through `--help`.
- Publishing to npm. `package.json` stays `private: true`.
