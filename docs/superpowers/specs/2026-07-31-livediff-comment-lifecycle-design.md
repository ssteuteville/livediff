# livediff Comment Lifecycle Design

**Status:** approved
**Version target:** 0.6.0

## Problem

A comment stores `file`, `side`, `line`, `lineContent`, `body`, `status`, `replies`, and
timestamps — and nothing that ties it to the change it was about. There is no branch, no
commit, no base ref. The diff it was left on is entirely ephemeral: working tree vs `HEAD`,
or `base...HEAD` when a `base` query parameter is passed, and that base is not persisted.

Two failures follow.

**Comments leak across branches.** A worktree has one registry entry regardless of what is
checked out, so comments left reviewing branch A render on branch B at the same `file:line`.
Nothing signals it. This is wrong output, not merely stale output.

**Comments outlive the diff.** Commit the work and the default diff empties, but the comments
persist pointing at hunks that are no longer under review. Observed in practice: two comments
on this repo survived the commit that resolved them, and thirteen comments from a
`stay-in-touch` review remain months after that work shipped. An `open` comment in that state
is handed to an agent as live work forever.

## Data model

The store moves to a keyed shape. Records are keyed by comment id, giving O(1) lookup for
every single-record operation — update, resolve, reply, restore — without introducing
redundant state.

```json
{
  "version": 2,
  "comments": {
    "f800282c": {
      "id": "f800282c",
      "file": "DESIGN.md",
      "side": "new",
      "line": 44,
      "lineContent": "impossible by construction rather than merely unlikely.\n",
      "body": "why not both?",
      "author": "user",
      "status": "open",
      "branch": "main",
      "archivedAt": null,
      "replies": [],
      "createdAt": "2026-07-31T23:44:29.010Z",
      "updatedAt": "2026-07-31T23:44:29.010Z"
    }
  }
}
```

Two new stored fields: `branch`, captured at creation from `currentBranch(repoPath)`, and
`archivedAt`, an ISO timestamp or `null`. Detached HEAD records `"(detached)"`.

Secondary indexes (`byBranch`, `byFile`) were considered and rejected. The store is rewritten
wholesale on every write, so a maintained index is state that must be updated on every add,
update, archive, and purge; if it desyncs, comments silently disappear from the UI. Files
currently hold two and thirteen records, so the scan being optimized away costs microseconds.
Grouping by file and filtering by branch or status are derived per read.

Partitioning into one file per branch was also considered. It makes branch selection free, but
branch names contain `/` and would need slugging, renames orphan files, and `--branch all`
becomes a directory read. Not worth it at this size.

## Branch scoping

`GET /api/comments?ws=<id>` returns only the current branch's comments. `?branch=all` and
`?branch=<name>` are escape hatches.

The SSE `comments` event is filtered identically. This works without per-client state because
a workspace has exactly one current branch at any moment, so the single broadcast payload is
already correct for every attached client. The UI needs no change: it keeps filtering by
status client-side and simply never receives another branch's comments.

A comment with no `branch` matches every branch. Nothing will have one after the wipe, but the
fallback costs one `||` and removes any path where a record silently vanishes.

## Lifecycle

Three states beyond `status`. Only `archivedAt` is stored; orphaning is always computed, so it
self-heals the moment a file returns to the diff.

| State | Determined by | Visible in |
| --- | --- | --- |
| live | file is among the current diff's changed paths | UI, `livediff comments` |
| orphaned | computed: file is not among changed paths | `livediff comments --stale` |
| archived | stored `archivedAt` is set | `livediff comments --archived` |
| purged | record deleted | nowhere |

### Archive triggers

A comment is archived when **either** holds:

- it is orphaned and `updatedAt` is more than **5 days** ago; or
- its status is `resolved` and `updatedAt` is more than **30 days** ago.

The first is the case observed in practice — work gets committed, its comments orphan, and
they should not linger. The second bounds the store under a workflow where the diff never
empties, such as a long-lived scratch worktree, where a resolved comment would otherwise never
orphan and never archive.

Age is measured from `updatedAt`, not `createdAt`: a thread replied to yesterday is alive
regardless of when it started. It is the comment's age, not the duration it has been orphaned
— tracking the latter would need a new field and a write on every poll that observes the
transition, for a difference that is small in practice.

Archiving deliberately ignores `status` in the first trigger. An orphaned comment that is
still `open` is an unaddressed loose end, so it is archived rather than deleted, and stays
restorable for 200 days.

### Purge

A record is deleted once `archivedAt` is more than **200 days** ago. One clock for everything,
regardless of how it was archived — the archive is kilobytes, so a shorter clock for resolved
comments would buy nothing and add a second rule to explain.

Nothing is destroyed less than 205 days after its last activity.

### Thresholds

`ORPHAN_ARCHIVE_DAYS = 5`, `RESOLVED_ARCHIVE_DAYS = 30`, `PURGE_DAYS = 200`, exported as
constants from `server/comment-lifecycle.js`. No environment overrides: three more
`LIVEDIFF_*` variables would be noise for values that are a one-line change, and tests control
time by passing an explicit `now` rather than by manipulating the environment.

## The sweep

Archiving and purging run inside the existing hub poll loop, which already computes per-workspace
git state for the rail. It needs the diff's changed paths, so `git.js` gains:

```js
/** Paths changed in the working tree vs HEAD, including untracked files. */
export async function changedPaths(cwd): Promise<string[]>
```

`summaryFor` currently derives its `changedFiles` count from nearly this exact command; both
must call `changedPaths` so a poll never runs git twice for the same information.

The sweep only evaluates the **current branch's** comments, because orphan detection is
meaningless against another branch's diff. Comments on a branch that is not checked out are
never evaluated and therefore can never be archived or purged — the safe behavior, and the
reason a branch you abandon does not quietly lose its review notes.

Because the poll loop suspends when no SSE client is attached, sweeps happen only while
someone is watching. That is acceptable: an unobserved store is not growing.

## CLI

```
livediff comments                    live, current branch, open
livediff comments --stale            orphaned, not yet archived
livediff comments --archived         archived, with days remaining before purge
livediff comments --branch <name>    a specific branch
livediff comments --branch all       every branch
livediff restore <id>                clear archivedAt, return to live
```

`restore` resolves its workspace from the current directory, the same way `resolve` and
`reply` do.

**`restore` also sets `updatedAt` to now.** Clearing `archivedAt` alone would be futile: a
comment archived for being orphaned and aged is still orphaned and still aged the instant it
returns, so the next sweep would archive it again and the command would appear to do nothing.
Resetting `updatedAt` restarts the clock, giving the restored comment a fresh 5 days (or 30 if
resolved) — which is exactly the reprieve someone asking to restore it wants.

`--stale` and `--archived` are mutually exclusive; passing both exits 2. `--branch` composes
with all of them and with the existing `--status`.

Orphaned comments are hidden from the default output so agents never chase dead work, and
`--stale` is the window into what is queued for archiving. `--archived` printing a countdown
is what makes the 200 days actionable rather than theoretical:

```
f800282c  DESIGN.md:44  (archived — purges in 194 days)
    | impossible by construction rather than merely unlikely.
    why not both?
```

## Maintenance commands

The sweep runs only while a browser is attached, so both operations also need to be
invocable on demand.

```
livediff archive [path] [--stale] [--resolved] [--dry-run]
livediff prune   [path] [--keep-days <n> | --all] [--dry-run] [--yes]
```

**These two default to every workspace, not the current one.** Every other command resolves
the cwd's workspace; these are maintenance, like `doctor`, and cleaning a single worktree
would reclaim little of what `doctor` reports globally. A positional `path` narrows them —
`livediff prune .` for the current worktree. Both `--help` entries state the global default
explicitly, because it is the surprising one.

### `archive`

Bare, it applies the normal gates — orphaned for more than 5 days, or resolved for more than
30 — to every registered workspace. This is the same work the sweep does, forced to run now.

`--stale` archives every orphaned comment regardless of age. `--resolved` archives every
resolved comment regardless of age. Both override only the age gate; neither invents a new
notion of what qualifies. They may be combined.

Archiving needs each workspace's changed paths, which is exactly what the poll loop already
computes for every workspace once per second, so a global run is routine work rather than a
new cost.

### `prune`

Bare, it applies the normal 200-day rule. `--keep-days <n>` deletes archived records older
than `n` days; `--all` deletes every archived record. The two are mutually exclusive; passing
both exits 2.

`--all` and `--keep-days` are separate flags rather than `--keep-days 0` because `--all` says
what it does at a glance, which matters most on the one command that destroys data.

Prune needs no git — it is timestamp arithmetic over stored `archivedAt` values — so a global
run costs one file read per workspace.

### Confirmation

Bare `prune` deletes exactly what the automatic sweep would have deleted anyway, so it does
not prompt. `--all`, or `--keep-days` below `PURGE_DAYS`, destroys records earlier than
automatic behavior and therefore prompts, unless `--yes` is passed. When stdin is not a TTY
and `--yes` is absent, it exits 2 with a message naming `--yes` rather than hanging on a
prompt nobody can answer.

`--dry-run` on both commands reports what would change and exits without writing. **It never
prompts**, whatever else is passed — there is nothing to confirm when nothing will be deleted,
and a prompt would make the safe preview annoying enough to skip. It is required on `prune` in
particular because the affected count is not visible anywhere else.

Both commands report counts on completion, and `--json` returns them structured:

```
archived 12 comments across 3 workspaces
pruned 47 archived comments (1.2 MB freed) across 3 workspaces
```

## `doctor` reports the archive

A `checkArchive` finding reports what is stored and what to do about it:

```
✓ comment archive
    3 workspaces, 47 archived comments, 1.2 MB
    oldest archived 183 days ago
    → livediff prune --keep-days 30
```

It is an `ok` finding under 5 MB and a `warn` above it. The suggested command is the point:
`doctor` already tells you how to fix everything else it reports, and archive growth is the
one thing it would otherwise only describe.

Byte size comes from `stat`; the archived count and oldest `archivedAt` require reading each
store, so the check is one stat plus one parse per workspace. That is the same work
`checkRegistry` already does per workspace, over files measured in kilobytes.

## The `/livediff:prune` skill

A fifth plugin skill, typed-only:

```markdown
---
name: prune
description: Show what livediff would delete from its comment archive, then clean it up.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

!`livediff prune --dry-run`

Report exactly what would be deleted. If nothing would be, say so and stop.
Otherwise ask what to keep before running anything — never prune without an answer.
```

This is the first skill capable of destroying data, so two properties are deliberate.
`disable-model-invocation: true` keeps it out of Claude's context entirely, so no path exists
where the model decides an archive looks large and acts on it. And the only automatic action
in the body is the dry-run; the real command requires the user to answer first.

Arguments are deliberately not forwarded to `--keep-days`. Argument substitution and
`` !`…` `` injection are both preprocessing passes over the skill file, and their relative
ordering is not documented — a destructive command should not depend on an unverified
ordering. The user states a window in conversation and Claude passes the flag.

There is no `/livediff:archive` counterpart. Archiving is reversible for 200 days, so it does
not need a preview ritual.

Resting context cost is unchanged at roughly 80 tokens: the three typed-only skills cost
nothing until invoked.

## UI

Minimal, consistent with the v0.5 constraint. Orphaned and archived comments are simply not
delivered to the browser, so no component learns a new state and the existing status filter is
untouched. The rail's open counts become branch-scoped automatically, since they are computed
from the same filtered payload.

## Modules

| File | Responsibility |
| --- | --- |
| `server/comment-lifecycle.js` (new) | Pure predicates and thresholds: `isOrphaned`, `shouldArchive`, `shouldPurge`. No I/O, no clock — `now` is a parameter. |
| `server/comments.js` | Keyed v2 store; `sweep`, `restoreComment`, branch filtering. |
| `server/git.js` | `changedPaths`, shared with `summaryFor`. |
| `server/index.js` | Branch filter on the comments route and the SSE payload; calls `sweep` from the poll loop. |
| `server/cli.js`, `server/cli-help.js` | `--stale`, `--archived`, `--branch`, `restore`, `archive`, `prune`, confirmation and `--dry-run`. |
| `server/comment-format.js` | Archived countdown in rendered output. |
| `server/doctor.js` | `checkArchive` — size, count, oldest, suggested prune command. |
| `skills/prune/SKILL.md` (new) | Typed-only dry-run-then-confirm skill. |

Putting the predicates in their own module keeps the decisions — what counts as orphaned, when
something archives — testable without a hub, a repo, or a fake clock library.

## The wipe

`~/.config/livediff/comments/` is backed up to the session scratchpad and then deleted, as a
one-time manual step. It is deliberately not installer code: it must never run twice.

This removes all migration code. Every comment created from 0.6.0 carries a `branch`, so the
v1 array shape never needs reading. The `version: 2` field exists so a future change has
somewhere to branch on, not because anything reads it now.

The 13 `stay-in-touch` comments and 2 `livediff` comments being discarded are all `resolved`;
no pending work is lost.

## Testing

`node --test test/*.test.js`.

### `test/comment-lifecycle.test.js` — pure, no hub

| Test | Asserts |
| --- | --- |
| a file in changed paths is not orphaned | `isOrphaned` false |
| a file absent from changed paths is orphaned | `isOrphaned` true |
| orphaned at 4 days does not archive | `shouldArchive` false |
| orphaned at 6 days archives | `shouldArchive` true |
| resolved at 29 days, in diff, does not archive | `shouldArchive` false |
| resolved at 31 days, in diff, archives | `shouldArchive` true |
| open at 31 days, in diff, does not archive | `shouldArchive` false |
| already archived does not re-archive | `shouldArchive` false |
| archived 199 days ago does not purge | `shouldPurge` false |
| archived 201 days ago purges | `shouldPurge` true |
| a non-archived comment never purges | `shouldPurge` false |

### `test/comments.test.js` — store

| Test | Asserts |
| --- | --- |
| a new comment records the current branch | `branch` equals the checked-out branch |
| a detached HEAD records "(detached)" | `branch` is `"(detached)"` |
| lookup by id is a key access | `comments[id]` resolves without scanning |
| sweep archives an orphaned aged comment | `archivedAt` set |
| sweep purges a long-archived comment | record absent |
| sweep leaves another branch's comments alone | untouched after checkout |
| restore clears archivedAt | comment returns to live |
| restore refreshes updatedAt | a sweep run immediately afterwards does not re-archive it |

### `test/cli.test.js` — surface

| Test | Asserts |
| --- | --- |
| comments are scoped to the current branch | a comment made on `main` is absent after checkout |
| `--branch all` returns both branches | both ids appear |
| default output hides orphaned comments | absent after its file leaves the diff |
| `--stale` shows exactly the orphaned ones | present under `--stale` |
| `--archived` prints a purge countdown | output matches `purges in \d+ days` |
| `--stale --archived` together exit 2 | exit code 2 with a usage message |
| `restore <id>` returns a comment to live | visible in default output afterwards |
| `archive` defaults to every workspace | a comment in an unrelated workspace is archived too |
| `archive .` narrows to the current worktree | the unrelated workspace is untouched |
| `archive --stale` ignores the age gate | an orphaned comment updated today is archived |
| `prune` bare applies the 200-day rule | a 201-day-old archived record goes, a 199-day one stays |
| `prune --keep-days 10 --yes` deletes older | an 11-day-old archived record goes |
| `prune --all --yes` empties the archive | no archived records remain |
| `prune --all` without `--yes`, non-TTY | exit 2, message names `--yes` |
| `prune --keep-days 10 --all` | exit 2, mutually exclusive |
| `--dry-run` writes nothing | counts reported, store byte-identical afterwards |

### `test/doctor.test.js`

| Test | Asserts |
| --- | --- |
| an empty archive reports ok with no suggestion | finding is `ok`, no `fix` |
| a populated archive suggests a prune command | `fix` matches `livediff prune` |

Time-dependent behavior is tested through `comment-lifecycle` with an explicit `now`, so the
store and CLI tests never sleep or manipulate clocks.

## Out of scope

- Persisting a base ref per workspace. `?base=` stays a per-request parameter.
- Re-anchoring `line` after a rebase. `lineContent` remains the anchor a reader trusts.
- A UI surface for archived comments. `livediff restore` is the recovery path.
- A `/livediff:archive` skill. Archiving is reversible, so it needs no preview ritual.
- Any mention of `archive`, `prune`, or `restore` in the model-invocable skills. Maintenance
  commands stay out of `open` and `comments`, for the same reason `doctor`, `list`, and `stop`
  do — naming a command in a skill is an invitation to run it.
- Migrating v1 stores. The wipe removes the need.
