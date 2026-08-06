# livediff

A local git diff viewer that live-updates with your working tree and lets you leave inline review
comments that AI agents can read and answer.

```bash
cd any-git-worktree
livediff .
```

That registers the worktree, starts the hub if it isn't already running, and opens the diff in your
browser. There is no server to remember to start.

Runs entirely on `localhost` — no network, no telemetry. The only thing that touches your code is
`git`.

## Why

It is built for working alongside a swarm of agents, each in its own worktree. Every worktree you
register shows up in one hub at `http://localhost:4180`, with its branch, change count, and open
comment count. You review in the browser; the agent reads your comments through the CLI and replies.

## Install

Requires Node ≥ 24. If Claude Code or Codex is installed, the installer also configures LiveDiff
as a native plugin for it.

```bash
git clone <this-repo-url> livediff
cd livediff
./install.sh
```

This builds a real package, installs it globally, and installs the shared LiveDiff plugin in any
available Claude Code and Codex CLIs. Run `./install.sh --dev` instead to link the working tree if
you are hacking on livediff itself.

Upgrading later is the same command. It removes the previous install first, so you can never end up
with two `livediff` binaries racing on `PATH`.

## Claude Code and Codex

`./install.sh` registers this clone as a native marketplace and installs the LiveDiff plugin for
each installed agent. Restart the agent after installation to load its skills. Re-running the
installer refreshes the local marketplace and plugin after a pull.

| You say or type       | What happens                                               |
| --------------------- | ---------------------------------------------------------- |
| "show me the diff"    | registers this worktree and opens it                       |
| "address my comments" | reads your open comments and works through them            |
| `/livediff:link`      | prints the URL, opens nothing                              |
| `/livediff:review`    | opens the diff and waits for you to finish reviewing       |
| `/livediff:prune`     | previews what would be deleted from the archive, then asks |

The typed-only ones are deliberate: each has side effects whose timing you should own.

## Comment lifecycle

A comment records the branch it was left on and is only shown on that branch.

Once its file leaves the diff it is _orphaned_ — hidden from the browser and from
`livediff comments`, but visible with `--stale`. After 5 days orphaned, or 30 days
resolved, it is archived: still restorable, no longer in the way. Archived comments are
deleted after 200 days.

```
livediff comments --stale       what is hidden and heading for the archive
livediff comments --archived    what is archived, and when it will be deleted
livediff restore <id>           pull one back
livediff prune --dry-run        what would be deleted right now
```

Nothing is destroyed less than 205 days after a comment's last activity, and
`/livediff:prune` always previews before it deletes.

## Use

```
livediff                       open the hub UI (all workspaces)
livediff hub                   explicit name for the hub command
livediff open [path]           register a worktree and open its focused view
livediff <path>                shorthand for `livediff open <path>`
                               (a subdirectory scopes the view to it)
livediff link [path]           register only, print the URL
livediff review [path]         open, then block until "Done reviewing" is clicked
livediff list                  list registered workspaces
livediff rm [path|id]          unregister
livediff comments [path]       open comments on the current branch
                               (--status open|resolved|all, --branch, --stale, --archived)
livediff restore <id>          return an archived comment to the live view
livediff archive [path]        archive comments that are no longer live (all workspaces)
livediff prune [path]          delete archived comments (all workspaces)
livediff resolve <id> [text…]  reply and mark resolved
livediff reply <id> <text…>    reply without resolving
livediff restart               restart the hub with current settings
livediff status                check hub and configuration state without starting anything
livediff stop                  shut the hub down
livediff doctor                diagnose install and state problems
livediff config edit           edit settings in your preferred editor
livediff config explain <key>  show a setting's value and where it came from
```

Every command takes `--json` for machine-readable output. Exit codes are `0` success, `1` error,
`2` usage mistake. `livediff help <command>` documents any of them; see
[docs/CLI.md](docs/CLI.md) for the full generated reference.

`livediff help --json` prints a versioned description of the whole command tree — every command,
nested action, argument, and option — so an agent can read the installed version's contract instead
of guessing. `livediff help <command> --json` prints one command's entry.

For shell completion, run `livediff completion install`. It detects bash, zsh, or fish and writes
a generated completion file under LiveDiff's XDG configuration directory. Add `--activate` only
when you want it to append LiveDiff's clearly marked source block to your shell startup file:
`livediff completion install zsh --activate`. Use `livediff completion status` to inspect it or
`livediff completion uninstall zsh --deactivate` to remove it. You can still source a one-off
script directly with `source <(livediff completion zsh)`. Tab completion is state-aware: it
suggests registered workspace paths for commands like `open` and `comments`, and open or archived
comment IDs for `resolve`, `reply`, and `restore` — by querying the running hub, never starting one.

Any subdirectory works — `livediff .` from `src/components` registers the worktree root, so a
worktree never registers twice.

### With Claude

Say **"open a diff of my worktree"**. Claude runs `livediff .` and shares the URL. Leave inline
comments in the browser, then say **"address my diff comments"** — Claude reads them with
`livediff comments`, makes the edits, and closes each thread with `livediff resolve`.

Claude never reads or writes livediff's storage directly; it only talks to the CLI.

### Reviewing on demand

`livediff <path> --wait` blocks until you click **Done reviewing** in the browser. The button only
appears while something is actually waiting on you. Leaving comments open is expected — they are
the output of the review, so the command still exits `0` and reports the count.

## How it works

**The hub** is a small Node HTTP server with no framework. It shells out to `git`, serves the built
UI, exposes a JSON API, and pushes updates over Server-Sent Events. The first CLI command starts it
automatically and records its port in `~/.local/state/livediff/hub.json`; later commands read the
port from there. It replaces itself when the CLI is a different version, and it never exits on its
own — `livediff stop` is the off switch.

**It costs nothing while idle.** Watching a worktree means running `git status` on a timer, so that
loop runs only while a browser is attached. With nobody looking, the hub is a resident process at
roughly zero CPU. That is what makes "never exits" affordable, and it avoids the trap an idle
timeout would create: a browser tab can't restart a hub that shut itself down.

**The CLI is a pure HTTP client.** It never writes livediff's files — the hub is the single writer,
so concurrent commands can't lose each other's updates, and every change broadcasts to the browser
for free.

**State lives outside your repos.** The registry is `~/.config/livediff/workspaces.json` and
comments are `~/.config/livediff/comments/<workspace-id>.json`. Nothing is ever written into a
registered worktree — nothing to gitignore. Comments are keyed per worktree, so parallel agents
never see each other's.

**Comments anchor to content, not line numbers.** Each stores the exact text of the line it was
left on. Line numbers drift as the worktree changes underneath; the quoted content is what an agent
should trust.

**The UI** is Vite + React + Tailwind, rendering diffs with
[`@git-diff-view/react`](https://github.com/MrWangJustToDo/git-diff-view) — side-by-side or unified,
syntax highlighted, with per-line comment widgets.

The toolchain is deliberately boring for portability: Vite 6 / esbuild, Tailwind 3 / PostCSS,
React 19, zero runtime dependencies in the server, and no native modules.

See [DESIGN.md](DESIGN.md) for architecture and the API surface.

## Config

See [Configuration](docs/CONFIGURATION.md) for the JSONC config file, precedence rules, schema,
and `livediff config` commands.

| Env                 | Default          | Meaning                                                          |
| ------------------- | ---------------- | ---------------------------------------------------------------- |
| `LIVEDIFF_PORT`     | `4180`           | preferred hub port; the hub takes the next free one if it's busy |
| `LIVEDIFF_POLL_MS`  | `1000`           | live-update poll interval                                        |
| `LIVEDIFF_BROWSER`  | OS opener        | executable and arguments used to open LiveDiff URLs              |
| `LIVEDIFF_RENDERER` | `fast`           | default diff renderer (`fast` or `classic`)                      |
| `LIVEDIFF_OPEN`     | –                | `1` opens the browser when the hub starts                        |
| `NO_COLOR`          | –                | disable colored CLI output                                       |
| `XDG_CONFIG_HOME`   | `~/.config`      | where the registry and comments live                             |
| `XDG_STATE_HOME`    | `~/.local/state` | where hub runtime state lives                                    |

## Development

```bash
pnpm dev     # Vite dev server (5173) + auto-reloading hub (4180), proxied
pnpm build   # build the UI into dist/
pnpm test    # run the test suite
pnpm serve   # run the hub against the current build
```

`./install.sh --dev` links the working tree globally so `livediff` reflects your edits.
