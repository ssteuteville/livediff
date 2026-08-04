# livediff v0.4 — CLI-first redesign

**Status:** approved design, not yet implemented
**Supersedes:** the lifecycle, CLI, and packaging sections of `DESIGN.md` (v0.3)

---

## 1. Problem

livediff v0.3 has two disjoint lifecycles: a long-lived hub the user must remember to start,
and a CLI that probes for it and silently degrades when it is absent.

`server/cli.js:12` defines `hubRunning()`, and nearly every command branches on it. `add` falls
back to writing the registry directly; `open` hard-fails with _"hub isn't running — start it with
`livediff`"_. The CLI detects the problem and reports it instead of fixing it.

Three defects follow from that structure:

1. **The user manages a daemon by hand.** Nothing works until `livediff` is running in some
   forgotten terminal.
2. **Two writers, no locking.** When the hub is up, mutations go over HTTP; when it is down, the
   CLI imports `registry.js`/`comments.js` and writes the JSON itself. Both do read-modify-write.
   Concurrent CLI calls, or a CLI call racing the hub, silently lose updates.
3. **Path normalization is inconsistent.** `addWorkspace` (`server/registry.js:48`) hashes the
   literal path, while `resolveWorkspace` (`:83`) walks up to ancestors. So `cd repo/src &&
livediff add .` registers a _second_ workspace for the same worktree — duplicate rail entry,
   separate comments file. Reads are subdirectory-tolerant; writes are not.

## 2. Goals

- `livediff .` works in any git worktree with no prior setup and no server to remember.
- One global hub, one stable URL, a rail listing every registered workspace.
- The CLI is the primary interface; the browser is where review happens.
- Migrating an existing v0.3 install is a single command with no silent leftovers.

**Non-goals for this version:** MCP server, agent-integration redesign, SQLite, UI work beyond
what the new surface requires.

## 3. Decisions

| Decision            | Choice                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Hub scope           | One global hub, shared across all repos                                                  |
| Hub lifecycle       | Auto-starts on first CLI use; never self-exits; `livediff stop` is the escape hatch      |
| Idle behavior       | Dormant — worktree polling suspends when no SSE client is attached                       |
| CLI ↔ hub           | Pure HTTP client. The hub is the single writer to all state                              |
| CLI surface         | Path-first flat verbs; `add` merges into `livediff . --no-open`                          |
| `--wait` completion | Explicit "Done reviewing" button in the UI                                               |
| Storage             | JSON files with atomic renames; SQLite deferred                                          |
| Rail lifecycle      | Auto-prune dead paths; explicit `rm` for everything live                                 |
| Watching            | In-process events primary; `fs.watch` as a safety net; 1s worktree poll gated on clients |
| Packaging           | npm semantics via `pnpm pack` + global tarball install; publishing deferred              |

---

## 4. Hub lifecycle

### 4.1 State file

Runtime state moves to `$XDG_STATE_HOME/livediff/hub.json` (default `~/.local/state/livediff/`).
It is runtime state, not configuration, and must not live beside the registry.

```json
{ "pid": 48213, "port": 4180, "version": "0.4.0", "startedAt": "2026-07-31T18:02:11.418Z" }
```

### 4.2 `ensureHub()`

Every command except `stop` begins here. It returns the base URL of a live, version-matched hub.

1. Read `hub.json`. Absent → **spawn**.
2. `GET /api/meta` on the recorded port, 500ms timeout. Connection refused → stale file; unlink
   it and **spawn**.
3. Compare `meta.version` to the CLI's own version. Mismatch → shut the old hub down
   (`POST /api/shutdown`, falling back to `SIGTERM` on the recorded pid), wait for exit,
   then **spawn**.
4. Otherwise return the URL.

A module-level `ensured` flag makes this run at most once per CLI process.

### 4.3 Spawning

```js
spawn(process.execPath, [serverEntry], {
  detached: true,
  stdio: ["ignore", logFd, logFd],
}).unref();
```

`logFd` is an append handle on `$XDG_STATE_HOME/livediff/hub.log`, so a hub that dies on startup
is diagnosable. The parent then polls for `hub.json` to appear, up to 5s. On timeout it fails with
the last 20 lines of `hub.log` rather than hanging.

**Single-flight.** Two agents running `livediff .` simultaneously would both observe no hub and
both spawn. The spawner acquires `$XDG_STATE_HOME/livediff/hub.lock` with `O_EXCL`; a process that
loses the race skips spawning and waits for `hub.json`. A lock file whose mtime is older than 30s
is treated as abandoned and broken.

### 4.4 Port discovery

`LIVEDIFF_PORT || 4180` is a **preference, not a contract**. On startup the hub binds that port;
if it is occupied, it probes the occupant's `/api/meta`:

- occupant is a livediff hub of the same version → exit, that hub wins
- occupant is anything else → bind the next free port

The bound port is written to `hub.json`, and **the CLI always reads the port from there**. This
closes the port-contention question left open in `DESIGN.md` §13.

### 4.5 Shutdown

`livediff stop` reads the pid, sends `SIGTERM`, waits for exit, unlinks `hub.json`. Once running,
the hub exits on no other condition. (The §4.4 case where a starting hub finds an equivalent hub
already bound is a startup abort, before it has begun serving.)

---

## 5. Dormancy and change detection

### 5.1 In-process events are the primary mechanism

Because the CLI is a pure HTTP client (§6), **the hub performs every mutation it needs to report**.
Comment writes, registry writes, and review-state changes emit their SSE frames synchronously,
in-process, with no filesystem round-trip. This is both faster and simpler than watching files for
changes the hub itself just made.

### 5.2 `fs.watch` as a safety net

Native `fs.watch` (non-recursive) on `workspaces.json` and `comments/`, debounced ~50ms, covers
only the case where a human hand-edits a JSON file. It is a ~20-line fallback, not the design's
backbone. If `fs.watch` throws — network mounts, exotic filesystems — the watcher degrades to
mtime polling of those two paths and logs once.

No `chokidar`. The watched paths are flat directories and a single file; native `fs.watch` is
sufficient for that shape.

### 5.3 Worktree polling, gated on clients

Detecting changes _inside_ a worktree still requires `git status --porcelain`, because a
filesystem event is not a git-status change: `node_modules` writes, `dist/` output, editor swap
files, and `.git` lock churn would all fire spuriously, and a hot build loop would trigger a
`git status` storm worse than the current 1s poll.

So the 1s poll stays, with one change — it runs only while at least one SSE client is attached:

```
clients 0 → 1   start the poll loop
clients 1 → 0   stop it
```

A hub with nobody watching costs ~50MB resident and ~0% CPU. This is what makes "never exits"
affordable, and it avoids the failure mode an idle timeout would introduce: a browser tab that
Chrome froze or discarded cannot restart the hub, so any timeout guarantees a window where an open
tab is dead on return.

### 5.4 Auto-prune

During each poll tick, a workspace whose path no longer exists or is no longer a git directory is
removed from the registry, and a `workspaces` SSE frame is emitted. Live workspaces are removed
only by explicit `livediff rm`.

---

## 6. CLI

### 6.1 Pure HTTP client

`cli.js` reduces to argument parsing plus a fetch wrapper. `registry.js` and `comments.js` become
server-internal modules that the CLI does not import.

```
CLI ──HTTP──> hub ──> workspaces.json, comments/
                      (single writer)
```

This makes the lost-update class of bug impossible by construction, collapses two code paths into
one, and gives every mutation an SSE broadcast for free. The only direct-filesystem exceptions are
lifecycle, not data: `ensureHub()` and `livediff stop` touch `hub.json`, `hub.lock`, and process
signals.

Accepted cost: `livediff list` spawns a hub if none is running (~200ms, once). This is the right
trade — `list` needs the hub regardless, since branch, changed-file count, and open-comment count
are computed live per request.

### 6.2 Surface

`<path>` below is any path to or inside a git worktree — `.` is simply the common case, and
`livediff ~/work/feat-a` is equivalent from anywhere.

```
livediff                      open the hub UI (all workspaces)
livediff <path>               register + open focused view
livediff <path> --no-open     register only, print URL
livediff <path> --wait        open, then block until "Done reviewing"
livediff list                 registered workspaces
livediff rm [path|id]         unregister
livediff comments [path]      read comments
livediff resolve <id> [text]  reply + resolve
livediff reply <id> <text>    reply only
livediff stop                 shut the hub down
livediff doctor               diagnose install and state problems
```

`add` is gone; it was only ever `.` with `--no-open`. Bare `livediff` no longer runs a foreground
server — it opens the hub UI.

**Global flags.** `--json` on every command, so nothing has to parse human-readable output. This
frees the default format to become friendlier.

**Exit codes.** `0` success, `1` error, `2` usage error. `--wait` returns `0` when the reviewer
clicks Done, regardless of how many comments remain open.

**Path normalization.** Every path argument resolves through `git rev-parse --show-toplevel`
before hashing, so any subdirectory of a worktree maps to exactly one workspace. Fixes defect (3)
in §1.

### 6.3 `--wait` and the Done button

```
$ livediff . --wait
opened feat-a → http://localhost:4180/?ws=a1b2c3d4&focus=1
waiting for review… (click "Done reviewing" in the browser)
review complete ✓ — 3 comments (2 open)
$ _
```

1. `--wait` opens a **review request** on the hub: `{ reviewId, ws, startedAt }`, held in memory.
   The hub no longer dies, so there is nothing to persist.
2. The UI renders a **"Done reviewing"** button in the header **only** while the selected workspace
   has an open review request, labelled with the comment count — _Done reviewing (3 comments)_.
   It never appears during ordinary browsing.
3. Clicking it `POST`s to the hub, which broadcasts a `review-done` frame carrying the `reviewId`.
4. The CLI does not poll. It holds an SSE connection to `/api/events` and exits on the matching
   `reviewId`, printing a summary.
5. `Ctrl-C` cancels the review request — so the button disappears — and exits non-zero.
6. `--timeout <sec>` is available for unattended use. Default: no timeout.
7. A second `--wait` on a workspace that already has an open review request **attaches to it**
   rather than creating a duplicate button.

Clicking Done with comments still open is expected and correct: open comments are the deliverable
for the agent. The summary reports both counts.

---

## 7. HTTP API changes

Additions to the surface in `DESIGN.md` §5:

| Method | Path                          | Purpose                                                |
| ------ | ----------------------------- | ------------------------------------------------------ |
| POST   | `/api/shutdown`               | graceful exit; used by `ensureHub` on version mismatch |
| POST   | `/api/reviews`                | `{ws}` → open a review request, returns `{reviewId}`   |
| DELETE | `/api/reviews/:reviewId`      | cancel (CLI `Ctrl-C`)                                  |
| POST   | `/api/reviews/:reviewId/done` | the Done button; broadcasts `review-done`              |

`GET /api/meta` gains `version`, read from `package.json` at startup, for the handshake in §4.2.

New SSE frame: `review` — `{ws, reviewId, state: "open" | "done" | "cancelled"}`.

---

## 8. Storage

**Decision: JSON files, unchanged locations.** SQLite is deferred.

The strongest argument for a database was concurrent writers, and §6.1 eliminates that. What
remains argues against it:

- `node:sqlite` requires Node 22.5+ and stabilized only recently; the project targets Node ≥18.
  `better-sqlite3` is a native module, which contradicts the "no native-binding fragility"
  principle in `DESIGN.md` §11 and is precisely what makes a global install fail on an unfamiliar
  machine.
- The data is tiny — dozens of comments across a handful of workspaces. There is no performance
  problem to solve.
- Plain JSON is greppable, diffable, and readable with `cat`. For a tool whose pitch is "nothing
  phones home and you can read everything it does," that is a feature.

**The one real weakness gets fixed directly:** `writeFile` is not atomic, so a crash mid-write can
truncate the registry. Both `registry.js` and `comments.js` switch to write-temp-then-`rename()`,
which is atomic on POSIX.

**Revisit when** cross-workspace queries become routine (today "every open comment everywhere"
means reading N files), comment volumes reach the thousands, or full-text search over comment
history is wanted. The migration stays cheap because the hub is the sole writer: the storage layer
sits behind an unchanged HTTP surface.

**Locations are deliberately unchanged.** `workspaces.json` and `comments/` stay in
`~/.config/livediff/`. Only the new `hub.json`, `hub.log`, and `hub.lock` go to
`~/.local/state/livediff/`. Moving existing data would be a migration that buys nothing.

---

## 9. UI scope

Minimal, and limited to what the new surface requires:

1. **"Done reviewing" button** — header, conditional on an open review request for the selected
   workspace, labelled with the comment count, wired to `POST /api/reviews/:id/done`.
2. **Handle the `review` SSE frame** to show and hide it.

Everything else falls out for free: auto-prune is a rail entry disappearing on a `workspaces`
frame; dormancy is invisible; port discovery never reaches the browser.

**Explicitly deferred:** any "hub unreachable / reconnecting" indicator. `EventSource` already
auto-reconnects, and with a hub that never self-exits the failure window is too small to earn UI.

---

## 10. Packaging and cutover

### 10.1 New install path

npm semantics without publishing:

```bash
pnpm pack                          # → livediff-0.4.0.tgz, honoring "files"
pnpm add -g ./livediff-0.4.0.tgz
```

This is byte-identical to what publishing will eventually do, so it validates the `files` allowlist
ahead of time. `install.sh` wraps both steps. `install.sh --dev` keeps `pnpm link --global` for
working on the tool, where edit-and-run beats an installed copy.

`package.json` changes: drop `"private": true`, add `"files": ["server", "dist"]` and
`"prepack": "vite build"`, keep the existing `bin`.

### 10.2 Cutover

The dangerous leftover is the v0.3 `pnpm link --global` symlink into the clone. Installed
alongside an npm-style package, which `livediff` runs depends on PATH ordering between pnpm's and
npm's global bin directories — so an "upgrade" can silently keep running old code.

| Leftover                                               | Handling                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm link --global` symlink                           | `install.sh` removes it first, then verifies `which -a livediff` resolves to exactly one path                               |
| Old hub running on 4180                                | Free — the §4.2 version handshake shuts it down and respawns                                                                |
| Duplicate registry entries from subdirectory `add`s    | Hub-side migration on startup: normalize each path to its toplevel, merge collapsed ids, concatenating their comments files |
| Pre-0.3 `<worktree>/.diff-review/`                     | Existing lazy migration in `comments.js` is retained                                                                        |
| Copied skill at `~/.claude/skills/open-worktree-diff/` | Refreshed by `install.sh` — it references `livediff add`, which no longer exists                                            |
| Plugin-installed skill                                 | Not reachable from a shell script; `doctor` detects it and prints the `/plugin` command                                     |

The registry migration is idempotent and runs inside the hub, consistent with single-writer.

### 10.3 `livediff doctor`

Reports, each with the command that fixes it:

- which `livediff` is on PATH, and whether anything shadows it (`which -a`)
- CLI version vs running hub version
- hub state: running / not running / stale `hub.json` / stale `hub.lock`
- duplicate or non-toplevel registry entries
- leftover `.diff-review/` directories in registered worktrees
- stale copied skill referencing removed commands

---

## 11. Documentation

`DESIGN.md` and `README.md` are **rewritten**, not patched. Both describe a hub the user starts by
hand and a CLI that degrades when it is absent; incremental edits would leave that model implied
throughout. The rewrite also drops the v0.1→v0.3 changelog narrative, which no longer helps anyone
reading for the first time.

`skills/open-worktree-diff/SKILL.md` is rewritten for the new surface: no `livediff add`, no
"ensure the hub is running" step.

---

## 12. Testing

The project currently has **no tests and no test script**. Lifecycle logic is exactly the kind that
fails silently, so it gets covered first, using `node:test` — built in, no dependency.

**Unit — `ensureHub` state machine**

- no state file → spawns
- state file with dead pid → cleans up, spawns
- version mismatch → shuts old hub down, spawns
- healthy matched hub → no spawn
- concurrent callers → exactly one spawn (lock held)
- abandoned lock (mtime > 30s) → broken and reacquired

**Unit — registry**

- subdirectory path normalizes to worktree toplevel
- duplicate-entry migration merges comments from collapsed ids
- atomic write leaves no partial file when interrupted

**Integration — real hub on an ephemeral port**

- poll loop starts on first SSE client and stops when the last disconnects
- hand-editing `comments/<ws>.json` emits a `comments` frame (the `fs.watch` fallback)
- review lifecycle: open → Done → `review-done` frame carries the right `reviewId`
- `--wait` exits 0 on Done and non-zero on cancel

**Manual**

- `pnpm pack` + global tarball install, then `livediff .` in a fresh worktree
- upgrade over a v0.3 `pnpm link --global` install, verified with `livediff doctor`

---

## 13. Implementation order

1. Atomic writes in `registry.js`/`comments.js`; toplevel path normalization; duplicate migration.
2. `server/hub-state.js` — `hub.json`, lock, port discovery, spawn/stop.
3. `ensureHub()` in the CLI; `/api/meta` version; `/api/shutdown`.
4. Rewrite `cli.js` as a pure HTTP client with the §6.2 surface, `--json`, exit codes.
5. Dormancy: client counting, gated poll loop, auto-prune.
6. In-process event emission; `fs.watch` safety net.
7. Review requests: API, SSE frame, `--wait`, Done button.
8. `livediff doctor`.
9. Packaging: `package.json`, `install.sh` rewrite with cutover.
10. Rewrite `DESIGN.md`, `README.md`, `SKILL.md`.
11. Tests alongside each step; `pnpm test` script.

---

## 14. Open questions

None blocking. Deferred by decision: MCP server, agent-integration redesign, SQLite migration,
launchd/systemd service (addable later as opt-in — `ensureHub()` would find the hub already
running and do nothing).
