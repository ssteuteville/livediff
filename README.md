# LiveDiff

A live diff of your git worktree in the browser, with inline review comments your AI agent can
read and answer.

Your agent works; you watch the diff update as it goes, leave comments on the lines you care
about, and the agent picks them up, fixes things, and replies — without you copying anything
between windows. It runs entirely on `localhost`: no account, no network, no telemetry.

## Get started

You need Node.js 22.12 or newer and git.

```bash
npx livediff@latest setup
```

Setup installs the `livediff` command, asks which of your agents to connect, and wires each one
up. It never opens a repository or starts a review on its own. Then open a repository in your
agent and say:

> **"Use LiveDiff to review my changes."**

Prefer to skip the questions?

```bash
npx livediff@latest setup --agent claude                  # Claude Code
npx livediff@latest setup --agent codex --browser cmux    # Codex, opening diffs in cmux
npx livediff@latest setup --agent cursor --agent gemini   # several agents at once
npx livediff@latest setup --cli-only                      # just the command, no agents
```

| Agent          | `--agent`  | Installed as         |
| -------------- | ---------- | -------------------- |
| Claude Code    | `claude`   | native plugin        |
| Codex          | `codex`    | native plugin        |
| Cursor         | `cursor`   | skill (experimental) |
| GitHub Copilot | `copilot`  | skill (experimental) |
| Gemini CLI     | `gemini`   | skill (experimental) |
| OpenCode       | `opencode` | skill (experimental) |

Run `livediff setup` again any time to add an agent or repair an install; it keeps what is
already there. `livediff setup --update` updates the CLI and every connected agent.

## Working with your agent

Ask in plain words:

| You say                                | What happens                                                   |
| -------------------------------------- | -------------------------------------------------------------- |
| "show me the diff"                     | registers this worktree and opens it in your browser           |
| "use LiveDiff to review my changes"    | opens the diff and waits until you click **Done reviewing**    |
| "address my comments"                  | reads your open comments, makes the fixes, and replies to each |
| "review PR 482 in LiveDiff"            | checks the PR out into its own worktree and opens it           |
| "split this change into lenses for me" | groups the diff into named views, like "the fix" and "tests"   |

In Claude Code and Codex, a few actions are also commands you type, because you should own when
they happen:

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `/livediff:link`   | prints the URL, opens nothing                                        |
| `/livediff:review` | opens the diff and waits for you to finish reviewing                 |
| `/livediff:pr`     | fetches a PR or branch into a worktree, registers it, and reviews it |
| `/livediff:prune`  | previews what would be deleted from the archive, then asks           |

Agents never touch LiveDiff's storage; everything goes through the CLI, and anything that deletes
or checks out code asks you first.

## Using the CLI

```bash
livediff .                               # open this worktree's diff
livediff                                 # the hub: every registered worktree at once
livediff review . --timeout 900          # open, then wait for "Done reviewing"
livediff . --base origin/main            # review against main instead of the last commit
livediff comments                        # open comments on this branch
livediff reply 3f9a2c1b "good catch"     # answer a comment
livediff resolve 3f9a2c1b "fixed"        # answer and close it
```

Any subdirectory works: `livediff .` from `src/components` registers the worktree root, and every
worktree shows up in one hub at `http://localhost:4180` with its branch, change count, and open
comments. That is the point when several agents each work in their own worktree.

<details>
<summary>All commands</summary>

```
livediff                       open the hub UI (all workspaces)
livediff open [path]           register a worktree and open its focused view
livediff <path>                shorthand for `livediff open <path>`
livediff link [path]           register only, print the URL
livediff review [path]         open, then block until "Done reviewing" is clicked
livediff list                  list registered workspaces
livediff rm [path|id]          unregister
livediff comments [path]       open comments on the current branch
                               (--status open|resolved|all, --branch, --stale, --archived)
livediff lens <action>         define, list, or clear named filters over the diff
livediff restore <id>          return an archived comment to the live view
livediff archive [path]        archive comments that are no longer live
livediff prune [path]          delete archived comments
livediff resolve <id> [text…]  reply and mark resolved
livediff reply <id> <text…>    reply without resolving
livediff setup                 install or repair the CLI and agent integrations
livediff doctor                diagnose install and state problems
livediff status                check hub and configuration state without starting anything
livediff restart               restart the hub with current settings
livediff stop                  shut the hub down
livediff config edit           edit settings in your preferred editor
livediff completion install    install shell completion (bash, zsh, fish)
```

Every command takes `--json`. Exit codes are `0` success, `1` error, `2` usage mistake.
`livediff help <command>` documents each one, and [docs/CLI.md](docs/CLI.md) is the full
reference. `livediff help --json` describes the whole command tree for agents.

</details>

## Lenses

A big change is easier to read a few files at a time. A **lens** is a named filter over the diff:
the files it covers, why it exists, and optionally the line ranges worth looking at. Agents write
them as they hand work back:

```bash
livediff lens set <<'EOF'
{"lenses": [
  {"name": "retry", "why": "the actual change; everything else is fallout",
   "paths": ["src/retry.ts", "src/queue.ts"],
   "highlights": [{"path": "src/retry.ts", "start": 88, "end": 104}]},
  {"name": "tests", "why": "coverage I added for the above", "paths": ["test/**"]}
]}
EOF
livediff review . --lens retry
```

To steer your agent, put a **`.livediff`** file at your worktree root: plain markdown with whatever
should be true of every review (_"always put tests in their own lens"_). LiveDiff never parses it;
agents read it and follow it.

## Comments

A comment belongs to the branch it was left on and quotes the line it was left on, so it stays
meaningful as line numbers shift. When its file leaves the diff it is hidden (`--stale` shows it).
After 5 days hidden, or 30 days resolved, it is archived, where it can still be restored. Archived
comments are deleted after 200 days, and `livediff prune --dry-run` shows what would go.

## How it works

The first command starts a small local hub and every later command reuses it; there is no server to
remember to start. The hub only polls git while a browser tab is watching, so it costs nothing
while idle. State lives in `~/.config/livediff`; nothing is ever written into your repositories.
See [DESIGN.md](DESIGN.md) for the architecture and API, and
[Configuration](docs/CONFIGURATION.md) for settings and environment variables.

## Contributing

To build from source, run the test suite, or send a change, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
