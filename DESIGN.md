# livediff — architecture & design

A local, browser-based git diff viewer that live-updates with the working tree and lets
you leave inline review comments that AI agents (Claude et al.) can read and answer.
Runs entirely on `localhost`, no network, no telemetry. Built to sit in front of a swarm
of agents each working in its own worktree.

Status: **v0.3.** v0.2 shipped the multi-workspace hub (registry, hub API, CLI, workspaces rail,
install script, Claude plugin/skill, focused single-workspace URLs). v0.3 moved comment storage out
of the worktree into a central store (§4, §12) with automatic legacy migration, and added
`livediff open`/`comments`/`resolve`/`reply` so agents never touch storage directly. This doc is the
architecture reference; see README.md for install/usage.

---

## 1. Goals

- Ask Claude to "open a diff of my worktree" → a browser view appears and stays live.
- Leave GitHub-style inline comments on any line; agents read them and reply/resolve; the
  threads update live in the browser (two-way loop).
- Work well with **many parallel agents**, each in its own git worktree.
- **Agent-driven registration**: a worktree only shows up in the UI once Claude (or the user)
  explicitly registers it. Nothing auto-appears.
- Trustworthy: small, readable, boring dependencies; nothing phones home.
- Easy to install on another machine (e.g. work) from the repo.

## 2. Chosen model (decisions locked)

- **Single hub server** on one stable URL (`http://localhost:4180`). Not one-process-per-worktree.
- A **workspace** = `{ id, path, label? }` where `path` is any git working directory (a repo
  or an individual worktree). Branch/head are derived live, not stored.
- Workspaces are **registered explicitly** — via `livediff add <path>` (CLI) or `POST /api/workspaces`
  (so a running agent can register its own cwd with one curl). No auto-discovery of worktrees.
- **Comments are stored per-workspace**, centrally at `~/.config/livediff/comments/<workspace-id>.json`
  — never inside the worktree. This is the key property that makes the multi-agent case clean: the
  agent working in a worktree reads/writes exactly the comments left on *its* diff, with zero
  cross-talk, and livediff never leaves files in a registered repo. (v0.1 stored this
  `<worktree>/.diff-review/comments.json`; v0.3 moved it out and migrates any legacy file in
  automatically — see §4.)

## 3. Component map

```
livediff/
├── server/
│   ├── index.js      # hub: HTTP + SSE + poll loop + routing   (REWORK for multi-ws)
│   ├── registry.js   # persisted workspace list                (NEW)
│   ├── git.js        # git plumbing → structured diff           (REUSE, small additions)
│   ├── comments.js   # read/write ~/.config/livediff/comments/<ws-id>.json (REWORK: centralized)
│   └── cli.js        # `livediff` / `add` / `rm` / `list`       (REWORK into dispatcher)
├── src/              # Vite + React + Tailwind frontend
│   ├── App.jsx       # layout + data + SSE                      (REWORK: add ws selection)
│   ├── api.js        # fetch/SSE helpers                        (REWORK: ws-aware)
│   └── components/
│       ├── WorkspaceRail.jsx  # far-left rail of workspaces     (NEW)
│       ├── FileDiff.jsx       # one file's DiffView + comments  (REUSE as-is)
│       ├── CommentThread.jsx  # persistent thread               (REUSE as-is)
│       └── CommentComposer.jsx# add-comment input              (REUSE as-is)
├── skills/open-worktree-diff/SKILL.md   # REWORK for register flow
├── .claude-plugin/                       # NEW: plugin + marketplace manifests
├── install.sh                            # NEW
└── DESIGN.md
```

What already works in v0.1 and carries over unchanged: `git.js` (diff building, `.diff-review`
exclusion via `:(exclude)` pathspec — kept as a defensive no-op for any pre-migration legacy dirs,
untracked-via-`--no-index`, numstat counts, lang detection, worktree signature), and all three
comment UI components wired to `@git-diff-view/react` (`extendData` + `renderExtendLine` for
threads, `diffViewAddWidget` + `renderWidgetLine` for the composer, `SplitSide` old=1/new=2).
`comments.js` was reworked in v0.3 to store centrally instead of in the worktree (see §4).

## 4. Data models

**Registry** — `~/.config/livediff/workspaces.json` (respect `$XDG_CONFIG_HOME`; fall back to
`~/.config`). Global so it's shared across every repo you launch the hub from.
```json
{ "workspaces": [
  { "id": "a1b2c3d4", "path": "/abs/path/to/worktree", "label": "feature-x", "addedAt": "ISO" }
] }
```
- `id` = first 8 hex of a hash of the absolute `path` → stable and idempotent (re-adding the same
  path is a no-op / update, never a duplicate).
- Source of truth on disk. Both the CLI and the API write here; the running hub watches the file
  (poll mtime) so an `add` from any process shows up live.

**Comment** — `~/.config/livediff/comments/<workspace-id>.json` (moved out of the worktree in v0.3;
same schema as v0.1):
```json
{ "comments": [ {
  "id": "8hex", "file": "src/auth.ts", "side": "new", "line": 42,
  "lineContent": "  const token = signJwt(user)",   // anchor: trust over line number
  "body": "use the refresh token here",
  "author": "user" | "claude", "status": "open" | "resolved",
  "replies": [ { "author", "body", "ts" } ], "createdAt": "ISO", "updatedAt": "ISO"
} ] }
```
**Migration**: on first read/write for a workspace whose central file doesn't exist yet, check
`<workspace-path>/.diff-review/comments.json` (the pre-v0.3 location); if present, copy its content
into the central file, delete the legacy file, and remove the `.diff-review/` dir if now empty. This
runs lazily (inside `readComments`/`addComment`/etc, given the workspace's `path`) rather than as a
separate migration step, so it self-heals the first time any registered workspace's comments are
touched — including just loading the workspaces rail, which reads every workspace's open-comment
count. No action needed for workspaces that never had a legacy file.

**Workspace (API view)** — computed live per request, never stored:
`{ id, path, label, branch, head, valid, changedFiles, openComments }`.

## 5. HTTP + SSE API (hub)

All state-changing calls broadcast an SSE event tagged with the workspace id.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/workspaces` | list workspaces with live `{branch, head, changedFiles, openComments, valid}` |
| POST | `/api/workspaces` | `{path, label?}` → resolve abs path, verify git repo, add to registry |
| DELETE | `/api/workspaces/:id` | unregister (does not touch the repo or its comments) |
| GET | `/api/diff?ws=<id>&base=<ref?>` | structured diff for one workspace |
| GET | `/api/comments?ws=<id>` | comments for one workspace |
| POST | `/api/comments?ws=<id>` | add comment |
| PATCH | `/api/comments/:id?ws=<id>` | edit / reply / resolve |
| DELETE | `/api/comments/:id?ws=<id>` | delete |
| GET | `/api/events` | SSE stream; frames: `diff`/`comments`/`workspaces`, each `{ws, reason}` |
| GET | `/api/meta` | `{port, version}` — also used by CLI to detect a running hub |

Static: serve `dist/` with SPA fallback (as v0.1).

## 6. Live-update mechanism

Single poll loop, default 1 s. For **each registered workspace**:
- worktree signature = `git status --porcelain=v1 -uall -z -- . :(exclude).diff-review`; on change → `diff` event for that ws.
- central comments file mtime+size (`~/.config/livediff/comments/<ws-id>.json`); on change →
  `comments` event for that ws. This also covers migration: the first read of a workspace's
  comments creates the central file (see §4), which the next poll tick reports as a normal update.
- Also watch the registry file mtime → `workspaces` event (new/removed workspaces appear live).

Frontend: on any SSE event, refetch `/api/workspaces` (cheap, refreshes all rail badges); if the
event's `ws` is the selected one, refetch its diff/comments. Flash the "updated" badge.

Scale note: polling is O(workspaces) git calls/sec — fine for a handful to a couple dozen. If it
ever needs to scale, switch to a per-workspace `fs.watch`/chokidar. Keep polling for v0.2 (zero deps).

## 7. Frontend layout

```
Header:  livediff | <selected ws> branch@head | ●live | [base ref input] | [Split|Unified] | [All|Open|Resolved]
Body:    [ Workspaces rail ] [ Files sidebar ] [ Diff main (scroll) ]
```
- **Workspaces rail** (far left, ~200px, collapsible): one row per workspace — label/branch, a change
  count, an open-comment badge, a remove (×). Click to select. Small "＋ add path" input (POST) and an
  empty state: *"No workspaces yet. Ask Claude to register a worktree, or run `livediff add <path>`."*
- Files sidebar + Diff main are exactly v0.1, now scoped to the selected workspace.

Theme follows `prefers-color-scheme`. `@git-diff-view/react` handles split/unified + syntax highlight.

## 8. CLI (`livediff`)

`server/cli.js` becomes a small dispatcher. If a hub is already running (probe `GET /api/meta` on the
port) mutating commands hit the API so the UI updates instantly; otherwise they write the registry
directly (the hub reads it on next start / via file watch).

| Command | Behavior |
|---|---|
| `livediff` | start the hub (serve `dist/` + API) on `LIVEDIFF_PORT` (default 4180). Opens browser if `LIVEDIFF_OPEN=1`. |
| `livediff add [path]` | register `path` (default `$PWD`) |
| `livediff rm [path]` | unregister |
| `livediff list` | print registered workspaces |

Env: `LIVEDIFF_PORT`, `LIVEDIFF_OPEN`, `LIVEDIFF_POLL_MS`, `XDG_CONFIG_HOME`.

## 9. Agent workflow (the point of it all)

1. User: "show me your diff" → Claude runs `livediff open "$PWD"` (registers the worktree if needed,
   ensures the hub is running, opens a focused single-workspace view — rail hidden); shares the URL.
2. User leaves inline comments in the browser on that workspace.
3. User: "address my diff comments" → Claude runs `livediff comments` (cwd-resolved, no ids or file
   access), uses each comment's `file` + `lineContent` (anchor) + `body`, makes the edits.
4. Claude runs `livediff resolve <id> <reply text>` for each — posts a threaded reply and marks it
   resolved in one call. User watches threads resolve and the diff refresh live. Because comments
   are keyed per workspace and stored centrally, parallel agents never see each other's comments,
   and none of this ever reads or writes a file inside the worktree.

This is the existing `skills/open-worktree-diff/SKILL.md`, to be updated so the "open" step becomes
"register this worktree" and it references `livediff` on `PATH` rather than a hardcoded install path.

## 10. Comment anchoring

Store `lineContent` (and the hunk it sat in) with every comment. Line numbers drift as the worktree
changes under the comment; the agent trusts the quoted content over the number. Same approach GitHub
uses (anchor to content + blob), scaled down. No re-anchoring logic needed for v0.2.

## 11. Distribution / install

Target: clone the repo on a work machine and be running + skill-installed in one step. Node ≥ 18
(toolchain is deliberately boring: **Vite 6 / esbuild, Tailwind v3 / PostCSS, React 19** — no Vite 8
rolldown native-binding fragility, no Node 20.12 requirement).

**Global CLI**: `package.json` already declares `bin.livediff → server/cli.js`. `install.sh` runs
`pnpm install && pnpm build && pnpm link --global`, so `livediff` works from any repo.

**Skill / plugin** — two supported paths (schemas below verified against current docs):

1. *Simplest — personal skill.* `install.sh` copies `skills/open-worktree-diff/` into
   `~/.claude/skills/open-worktree-diff/`. A `~/.claude/skills/<name>/SKILL.md` with no manifest is a
   personal skill loaded in **every** project. Zero Claude-Code config.

2. *Plugin via marketplace* (nicer updates, shareable with teammates). Add `.claude-plugin/plugin.json`
   at the repo root and a `.claude-plugin/marketplace.json`. Then on any machine:
   ```
   /plugin marketplace add <git-url-or-owner/repo>
   /plugin install livediff@<marketplace-name>
   ```

   `.claude-plugin/plugin.json` (manifest schema confirmed):
   ```json
   {
     "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
     "name": "livediff",
     "description": "Live worktree diff viewer with agent-readable review comments",
     "version": "0.2.0",
     "author": { "name": "Shane" },
     "keywords": ["git", "diff", "review", "worktree"]
   }
   ```
   Skills auto-discover from the plugin's `skills/` dir — no `skills` field needed. (Omit `version`
   while iterating so every commit is treated as an update; set it once releasing.)

   `.claude-plugin/marketplace.json` (confirm exact shape with `claude plugin validate` at build time):
   ```json
   {
     "name": "livediff",
     "owner": { "name": "Shane" },
     "plugins": [
       { "name": "livediff", "source": "./",
         "description": "Live worktree diff viewer with agent-readable review comments" }
     ]
   }
   ```

   Note: the plugin only carries the **skill**; the actual `livediff` server/CLI is installed by
   `install.sh` (global bin). The skill calls `livediff` on `PATH`. Keep those two concerns separate.

`install.sh` outline: check `node -v` ≥ 18 → `pnpm install` → `pnpm build` → `pnpm link --global`
→ copy skill to `~/.claude/skills/` (or print the `/plugin` commands) → print the hub URL and a
one-line "you're set" with `livediff add .`.

## 12. Security posture

- Server binds `127.0.0.1` only. No auth needed (localhost, single user).
- Only `git` (already trusted) touches repo contents; comments are plain JSON stored centrally
  under `~/.config/livediff/`, never written into a registered repo — nothing to gitignore.
- `.diff-review/` exclusion in `git.js` is kept only as a defensive no-op for any pre-v0.3 legacy
  dir that hasn't been migrated/removed yet.
- Dependencies are all mainstream, widely-audited packages, installed and read by the user.

## 13. Open questions to settle at implementation time

- **Rail vs tabs** for workspaces when there are many (>~15): vertical rail scrolls; revisit if it
  gets cramped alongside the files sidebar (could make the files sidebar collapsible).
- **Removing a workspace**: confirm it only unregisters and never deletes the central comments file
  or repo files (comments for a removed-then-re-added workspace persist, since the id is stable).
- **Port contention** across multiple hubs: single hub is the design; if a second `livediff` starts
  and 4180 is busy, either attach to the existing hub (preferred: just `add` to it) or pick the next port.
- **marketplace.json** exact field names — validate with `claude plugin validate --strict` before publishing.
- **Stale workspaces** (worktree deleted on disk): mark `valid:false` in the rail with a quick "remove".

## 14. Implementation order (backlog)

1. `server/registry.js` — persisted workspace list (add/rm/list, path-hash ids, file-watch friendly).
2. `server/index.js` — multi-workspace routing, registry watch, per-ws poll + tagged SSE.
3. `server/cli.js` — dispatcher (`add`/`rm`/`list`/serve) with running-hub detection.
4. Frontend — `WorkspaceRail.jsx` + `App.jsx`/`api.js` ws-awareness; empty state.
5. Packaging — `install.sh`, `.claude-plugin/*`, SKILL.md register-flow rewrite, README.
```
