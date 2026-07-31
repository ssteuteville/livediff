# livediff

A local, browser-based git diff **hub** that live-updates with your working tree and lets you leave
inline review comments that AI agents (Claude et al.) can read and answer. Built to sit in front of
a swarm of agents, each working in its own git worktree.

Runs entirely on `localhost` — no network, no telemetry. The only thing that touches your code is
`git`; comments are plain JSON inside each worktree.

## What it does

- **Live diff** of any registered worktree (worktree vs `HEAD`, plus staged and untracked; or diff
  against a base ref you type).
- **Multiple worktrees / repos at once.** A left rail lists every registered workspace with its
  branch, change count, and open-comment count. Click to switch.
- **Agent-driven registration.** Nothing shows up until you register it — `livediff add <path>` or
  ask Claude. Perfect for parallel agents: each registers its own worktree.
- **Inline review comments.** Click a line, leave a comment. Comments are scoped per workspace and
  stored centrally, outside your repos — never touched directly by agents, only through the
  `livediff` CLI or HTTP API — so the agent working in a worktree reads exactly the comments on
  *its* diff, no cross-talk, and no stray files in your repo. Threads update live in the browser.

## Install

Requires Node ≥ 18 and pnpm (or npm).

```bash
git clone <this-repo-url> livediff
cd livediff
./install.sh
```

`install.sh` installs deps, builds the UI, links the global `livediff` command, and copies the
Claude skill into `~/.claude/skills/` (loads in every project).

## Use

```bash
livediff                       # start the hub → http://localhost:4180
livediff add [path]            # register a worktree/repo (default: current dir)
livediff open [path]           # register (if needed) and open a focused single-workspace view
livediff rm  [path|id]         # unregister (does not touch the repo or its comments)
livediff list                  # list registered workspaces
livediff comments [path]       # print review comments for a worktree as JSON
livediff resolve <id> [text…]  # reply (optional) and mark a comment resolved
livediff reply <id> <text…>    # reply to a comment without resolving
```

Then open <http://localhost:4180>, or set `LIVEDIFF_OPEN=1 livediff` to open the browser for you.

**Focused mode.** Open straight to one workspace with the rail hidden via URL params:
`?ws=<id>&focus=1`, or `?path=<dir>&focus=1` (any directory inside the worktree resolves).
`livediff open [path]` builds that URL and opens it for you.

### With Claude

Say **"open a diff of my worktree"**. Claude registers the current worktree and shares the URL.
Leave inline comments in the browser, then say **"address my diff comments"** — Claude runs
`livediff comments` to read them, makes the edits, and replies/resolves each thread with
`livediff resolve`/`livediff reply`. Claude never reads or edits the comments file directly; it
only talks to livediff through the CLI/API.

Prefer the plugin system to the copied skill? From any machine:

```
/plugin marketplace add <this-repo-git-url>
/plugin install livediff@livediff
```

The plugin carries only the skill; the `livediff` CLI comes from `install.sh`.

## How it works

- **Hub** (`server/`): a tiny Node HTTP server (no framework) that shells out to `git`, serves the
  built UI, exposes a small JSON API, and pushes live updates over Server-Sent Events. A ~1s poll
  loop watches each workspace's `git status` and its comments file, plus the global registry.
- **Registry**: `~/.config/livediff/workspaces.json` — the list of registered workspaces, shared
  across every repo you launch the hub from. Written by the CLI and the API; watched by the hub.
- **Comments**: `~/.config/livediff/comments/<workspace-id>.json` — one file per workspace, outside
  any repo. Nothing is ever written into a registered worktree.
- **UI** (`src/`): Vite + React + Tailwind, rendering diffs with
  [`@git-diff-view/react`](https://github.com/MrWangJustToDo/git-diff-view) (side-by-side/unified,
  syntax highlighting, per-line comment widgets).

Toolchain is deliberately boring for portability and trust: **Vite 6 / esbuild, Tailwind 3 / PostCSS,
React 19** — no native-binding fragility, works on Node 18+.

See [DESIGN.md](DESIGN.md) for the full architecture, API surface, and data models.

## Config

| Env | Default | Meaning |
|---|---|---|
| `LIVEDIFF_PORT` | `4180` | hub port |
| `LIVEDIFF_OPEN` | – | `1` opens the browser on start |
| `LIVEDIFF_POLL_MS` | `1000` | live-update poll interval |
| `XDG_CONFIG_HOME` | `~/.config` | where the registry lives |

## Development

```bash
pnpm dev     # Vite dev server (5173) + auto-reloading hub (4180), proxied
pnpm build   # build the UI into dist/
pnpm serve   # run the hub against the current build
```

Comments are stored centrally (`~/.config/livediff/comments/`), not inside your repos — nothing to
gitignore. (Pre-0.3 versions wrote `<worktree>/.diff-review/comments.json`; that legacy file is
migrated in automatically and removed the first time the workspace's comments are read.)
