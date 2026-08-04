# livediff — architecture

A local, browser-based git diff viewer that live-updates with the working tree and lets you leave
inline review comments that AI agents can read and answer. Runs entirely on `localhost`. Built to
sit in front of a swarm of agents, each in its own worktree.

This document is the architecture reference. See [README.md](README.md) for install and usage.

---

## 1. What it optimizes for

- **Nothing to start.** `livediff .` works in any worktree, with no prior setup and no daemon to
  remember. The lifecycle is the tool's problem, not the user's.
- **Many worktrees, one place to look.** Every registered worktree appears in one hub on one URL.
- **A two-way loop with agents.** The user comments in the browser; the agent reads, edits, and
  replies; threads update live.
- **Boring and inspectable.** Zero runtime dependencies in the server, no native modules, plain
  JSON on disk, nothing leaves the machine.

## 2. Shape of the system

```
livediff <path>          the CLI: argument parsing + an HTTP client, nothing more
      │
      │ ensureHub()      starts / replaces / reuses the hub, returns its URL
      ▼
  the hub                one process, one port, the single writer to all state
      │
      ├── git            shelled out to, per request and on a gated timer
      ├── ~/.config/livediff/       registry + comments  (durable)
      ├── ~/.local/state/livediff/  hub.json, hub.lock, hub.log  (runtime)
      └── SSE ──────────► browser
```

Three decisions carry most of the weight:

**The hub auto-starts and never exits on its own.** Every command begins with `ensureHub()`, so
there is no state in which the CLI works but the hub is missing. It shuts down only via
`livediff stop`, which means an open browser tab is never orphaned.

**The CLI is a pure HTTP client.** It has no filesystem fallback. That makes the hub the single
writer to the registry and comment stores, so lost updates between concurrent commands are
impossible by construction rather than merely unlikely.

**Idle costs nothing.** Change detection needs `git status` on a timer, which is real CPU. That
loop runs only while an SSE client is attached, so a hub nobody is watching is a resident process
doing nothing.

## 3. Files

```
server/
├── cli.ts         argument parsing, command implementations, output   (HTTP client only)
├── cli-help.ts    one command table driving dispatch, help, suggestions
├── ensure-hub.ts  the auto-start state machine
├── hub-state.ts   hub.json, spawn lock, liveness, port blocklist
├── index.ts       HTTP + SSE + routing + the gated poll loop
├── registry.ts    workspaces.json
├── comments.ts    comments/<ws-id>.json
├── reviews.ts     in-memory review requests
├── migrations.ts  one-time data migrations, run at hub startup
├── doctor.ts      install and state diagnostics
├── git.ts         git plumbing → structured diff
└── atomic.ts      write-temp-then-rename
src/               Vite + React + Tailwind frontend
test/              node:test suite
```

## 4. Hub lifecycle

### 4.1 State

`$XDG_STATE_HOME/livediff/hub.json` — runtime state, deliberately not beside the config:

```json
{ "pid": 48213, "port": 4180, "version": "0.4.0", "startedAt": "…" }
```

### 4.2 `ensureHub()`

1. No state file → **spawn**.
2. Probe `GET /api/meta` on the recorded port. Refused → stale file, clean up, **spawn**.
3. `meta.version` differs from the CLI's → shut the old hub down, **spawn**.
4. Otherwise use it.

Memoized per process, so only the first command in a CLI run pays the cost. The spawn is detached
with output appended to `hub.log`, so a hub that dies on startup is diagnosable rather than a hang;
failures surface the log's tail.

**Single-flight.** Concurrent agents would otherwise all spawn. The spawner takes
`hub.lock` with `O_EXCL`; losers wait for `hub.json`. A lock older than 30s is treated as
abandoned.

### 4.3 Port discovery

`LIVEDIFF_PORT || 4180` is a preference, not a contract. The hub tries to bind, and only on
`EADDRINUSE` probes the occupant — binding first keeps the happy path free of a probe, and the
probe gets a generous timeout because it is the first `fetch` in a cold process and pays undici's
one-time initialization.

An occupant that is an equivalent livediff hub means this process is redundant, and it exits.
Anything else and it moves to the next port.

**Ports on the WHATWG Fetch blocklist are skipped.** This is not theoretical: 4190 (ManageSieve)
sits inside the default scan range, is perfectly bindable via `net`, and is permanently unreachable
via `fetch`. Without the skip the hub could listen on a port its own CLI could never talk to.

## 5. Change detection

| Source                                | Mechanism                                                                     | Why                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comments, registry (hub's own writes) | in-process `broadcast()`                                                      | The hub performed the write; watching for it would be redundant and up to a second late.                                                                                                                         |
| Comments, registry (hand edits)       | `fs.watch` on the config dir, 50ms debounce                                   | Flat directories, exact semantics, no ignore rules. Degrades to nothing if unsupported.                                                                                                                          |
| Worktree contents                     | `git status --porcelain` every `LIVEDIFF_POLL_MS`, **only while clients > 0** | A filesystem event is not a git-status change: `node_modules` writes, build output, and `.git` lock churn would all fire spuriously, and a hot build loop would trigger a `git status` storm worse than polling. |

Workspaces whose worktree no longer exists are dropped during a poll tick and broadcast as
`workspaces` with `reason: "pruned"`, so deleted agent worktrees clean themselves up.

## 6. HTTP + SSE API

| Method       | Path                    | Purpose                                                                           |
| ------------ | ----------------------- | --------------------------------------------------------------------------------- |
| GET          | `/api/meta`             | `{name, port, version, clients, polling}` — identity, version handshake, liveness |
| POST         | `/api/shutdown`         | graceful exit                                                                     |
| GET          | `/api/workspaces`       | list with live `{branch, head, changedFiles, openComments, valid}`                |
| POST         | `/api/workspaces`       | `{path}` → normalize to worktree root, register                                   |
| DELETE       | `/api/workspaces/:id`   | unregister; touches neither repo nor comments                                     |
| GET          | `/api/resolve?path=`    | the workspace containing a path                                                   |
| GET          | `/api/diff?ws=&base=`   | structured diff                                                                   |
| GET/POST     | `/api/comments?ws=`     | read / add                                                                        |
| PATCH/DELETE | `/api/comments/:id?ws=` | edit, reply, resolve / delete                                                     |
| GET          | `/api/reviews?ws=`      | the open review request, or `null`                                                |
| POST         | `/api/reviews`          | `{ws}` → open (idempotent per workspace)                                          |
| POST         | `/api/reviews/:id/done` | the Done button                                                                   |
| DELETE       | `/api/reviews/:id`      | cancel (CLI `Ctrl-C`)                                                             |
| GET          | `/api/events`           | SSE: `diff`, `comments`, `workspaces`, `review`                                   |

Static `dist/` with SPA fallback. Binds `127.0.0.1` only; no auth, because there is no remote
surface.

## 7. Data

**Registry** — `$XDG_CONFIG_HOME/livediff/workspaces.json`:

```json
{
  "workspaces": [
    { "id": "a1b2c3d4", "path": "/abs/worktree", "label": "feature-x", "addedAt": "…" }
  ]
}
```

`id` is the first 8 hex of a hash of the path — stable and idempotent. Paths are normalized through
`git rev-parse --show-toplevel` before hashing, so any subdirectory maps to one workspace. Because
that command resolves symlinks, lookups canonicalize both sides: on macOS `/var` and `/tmp` are
symlinks, so a logical `cwd` would otherwise never match a stored physical path.

**Comments** — `$XDG_CONFIG_HOME/livediff/comments/<workspace-id>.json`:

```json
{ "comments": [{
  "id": "8hex", "file": "src/auth.ts", "side": "new", "line": 42,
  "lineContent": "  const token = signJwt(user)",
  "body": "use the refresh token here",
  "author": "user" | "claude", "status": "open" | "resolved",
  "replies": [{ "author", "body", "ts" }], "createdAt": "…", "updatedAt": "…"
}] }
```

`lineContent` is the anchor. Line numbers drift as the worktree changes under a comment; agents are
told to trust the quoted content. Same idea GitHub uses, scaled down.

**Reviews** are in-memory only. The hub no longer exits on its own, so there is nothing to survive
— and a request outliving the CLI waiting on it would render a button that does nothing.

**Writes are atomic.** Every JSON write goes through write-temp-then-`rename`, which is atomic on
POSIX, so a crash mid-write cannot truncate the registry.

### Why not SQLite

The strongest argument was concurrent writers, and the pure-HTTP CLI eliminated that. What remains
argues against it: `node:sqlite` needs Node 22.5+ against a Node ≥18 target, `better-sqlite3` is a
native module — exactly what makes a global install fail on an unfamiliar machine — and the data is
dozens of comments. Plain JSON is also greppable and diffable, which matters for a tool whose pitch
is that you can read everything it does.

Revisit if cross-workspace queries become routine, volumes reach thousands, or full-text search over
comment history is wanted. The migration stays cheap because the hub is the sole writer: the storage
layer sits behind an unchanged HTTP surface.

## 8. Review requests

`livediff <path> --wait` opens a review request, which is the only thing that makes the **Done
reviewing** button appear — so it is never a mystery control during ordinary browsing. The CLI holds
the SSE stream and exits when the matching `review-done` frame arrives; `Ctrl-C` cancels the request
so the button disappears. A second `--wait` on the same workspace attaches to the existing request
rather than duplicating it.

Clicking Done with comments still open is the expected case: open comments are the deliverable for
the agent, so the command still exits `0` and reports both counts.

## 9. CLI

`cli.js` is argument parsing plus a `fetch` wrapper. `registry.js` and `comments.js` are
server-internal; the CLI does not import them.

Help, dispatch, and did-you-mean suggestions all read one command table in `cli-help.js`, so a
command cannot appear in help without being runnable, or vice versa.

Exit codes: `0` success, `1` error, `2` usage. `--json` on every command. The CLI drains stdout and
exits explicitly, because undici's connection pool otherwise holds the process open for seconds
after a request.

## 10. Migration and diagnostics

`migrateRegistry()` runs at hub startup, idempotently: it normalizes paths to worktree roots,
merges the comment stores of entries that collapse together, and drops entries whose path is gone.
Pre-0.3 `<worktree>/.diff-review/comments.json` files are migrated lazily on first read and removed.

`livediff doctor` reports what the user cannot easily see: whether `livediff` resolves to more than
one binary (a stale global link shadowing an install is silent and nasty), CLI vs running hub
version, stale `hub.json` or `hub.lock`, unmigrated registry entries, leftover `.diff-review`
directories, and a Claude skill still referencing removed commands.

## 11. Security posture

Binds `127.0.0.1`. No auth — localhost, single user, no remote surface. Only `git` touches repo
contents. Comments are plain JSON under `~/.config/livediff/`, never inside a registered repo.
Server dependencies: none.

## 12. Testing

`node:test`, no framework. Tests set `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `HOME` to temp
directories — `HOME` included because `os.homedir()` honours it and `doctor` reads `~/.claude`.

`node --test` runs files in parallel, so any file that spawns a hub pins its own `LIVEDIFF_PORT`
band; two files racing for one port would make the second hub detect its twin and exit by design,
hanging the first file's test.

Coverage concentrates on what fails silently: the `ensureHub` state machine, port selection,
dormancy transitions, path normalization, the registry migration, and CLI exit codes.

## Agent integration

Five skills, shipped by the plugin, with no MCP server. An MCP tool definition costs
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

No skill mentions `doctor`, `list`, `stop`, ports, or hub state. The v0.4 skill told the model
not to check whether the hub was running and it checked anyway; a single negative instruction
loses to a strong prior, so the fix was removing the vocabulary rather than repeating the rule.

The plugin ships skills and no code. The CLI stays a global install, so the agent and the
human run the same binary; `doctor` reports the two-artifact version skew that buys.

## Comment lifecycle

A comment used to store nothing tying it to the change it was about — no branch, no commit,
no base ref — while the diff it was left on is entirely ephemeral. Two failures followed:
comments rendered on branches they were never left on, and comments outlived the diff, so an
`open` comment on committed work was handed to an agent as live work forever.

Comments now record their branch and are only shown on it. Orphaning — the file no longer
being in the diff — is computed, never stored, so it heals itself the moment a file comes
back. Archiving is stored, because it is a decision rather than an observation.

Nothing is deleted for 205 days: 5 days orphaned (or 30 resolved) to archive, then 200 more
before purge, with `livediff restore` available throughout. An orphaned comment that is still
`open` is an unaddressed loose end, so it is archived rather than deleted.

The sweep runs in the poll loop, throttled to once every 12 hours. It needs one `changedPaths`
spawn per workspace and the loop ticks every second, so sweeping every tick would double git
spawns per second to enforce thresholds measured in days. `livediff archive` and `livediff
prune` do the same work on demand, since the loop only runs while a browser is attached.

The store is keyed by comment id. Secondary indexes were rejected: the file is rewritten
wholesale on every write, so an index is state that can desync, and the failure mode is
comments silently disappearing — a poor trade against a scan over dozens of records.
