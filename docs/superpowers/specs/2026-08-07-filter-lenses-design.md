# Filter-only lenses

Design spec. Written 2026-08-07.

The first slice of the lens concept from [`../../AI-REVIEW-UX.md`](../../AI-REVIEW-UX.md): a lens
that narrows the diff to a set of files and marks line ranges inside them. No annotations, no
diagram rendering, no walkthroughs. Those land later and will extend `Lens` rather than replace it.

## Why

A 3,000-line change written overnight is unreviewable in one pass — past roughly 400 lines review
quality collapses. It is reviewable as four narrow passes, if something tells you where the cuts
are. The agent that wrote it knows where they are at the moment it finishes, and today that
knowledge is thrown away.

A lens is the agent saying _"here are the four ways to read this."_

## Scope

**In:** a named, file-level filter with optional line-range highlights; a CLI to write and read
them; storage; the browser filtering and highlighting; a `.livediff` instructions file; agent
skills to drive it.

**Out, deliberately:** inline annotations and annotation buttons, non-diff rendering, walkthroughs,
questions, notes, lens staleness detection, glob negation, saved/reusable lenses across reviews.

## Model

```ts
interface Highlight {
  path: string; // repo-relative, matching DiffFile.path
  start: number; // new-side line number, inclusive
  end: number; // new-side line number, inclusive; >= start
}

interface Lens {
  name: string; // kebab-case handle, unique per workspace
  why: string | null; // one line of human phrasing, shown in the picker
  paths: string[]; // globs; non-empty
  highlights: Highlight[];
  createdAt: string; // ISO 8601
}
```

### Lifetime

A lens set belongs to a handoff, not to the repository. The agent builds it once, when it stops
working and asks for review, and the next handoff replaces it wholesale. Nothing maintains it in
between.

This is deliberate. An agent that keeps a lens set current while it works is maintaining two
artifacts instead of one, and the second will drift from the first.

The corollary is that **drift is self-correcting and needs no machinery**. Comments carry
`lineContent` because they outlive edits; lenses do not outlive edits, so highlights store plain
line numbers and a range that no longer lands inside a hunk is dropped at render time.

### Membership

`paths` holds glob patterns. A pattern with no metacharacter is a literal path that matches only
itself. That one field covers both selection styles:

- `test/**` — a category. A test file added after the lens was written joins it.
- `src/retry.ts` — a specific file the agent chose by reading the code. Nothing else joins it.

A lens matching zero files in the current diff is **shown with a count of zero, not hidden**. "The
thing I was told about is no longer in the diff" is information.

#### Glob syntax

Hand-rolled, because the server has zero runtime dependencies and `path.matchesGlob` is still
experimental. Supported, and nothing else:

| Token         | Matches                                                        |
| ------------- | -------------------------------------------------------------- |
| `*`           | any run of characters within one path segment, including empty |
| `**`          | any number of segments, including zero                         |
| `?`           | exactly one character within a segment                         |
| anything else | itself, literally                                              |

Patterns match against the repo-relative `DiffFile.path` with forward slashes. Matching is
case-sensitive. No braces, no character classes, no negation — `!test/**` is a literal pattern
that matches a file named `!test/…` and therefore nothing. Deferred, not forgotten.

`**` collapses correctly at the edges: `**/foo.ts` matches `foo.ts` as well as `a/b/foo.ts`.

### Name

`^[a-z0-9][a-z0-9-]{0,39}$`. Kebab-case, so it is predictable to type, safe in a URL, and
completable. Human phrasing goes in `why`, which is unconstrained.

Uniqueness is per workspace. Writing a lens whose name already exists replaces it.

## Storage

`$XDG_CONFIG_HOME/livediff/lenses/<workspace-id>.json`, a sibling of `comments/`, written through
the existing `writeJsonAtomic`.

```json
{
  "version": 1,
  "lenses": [
    {
      "name": "retry",
      "why": "the actual change; everything else is fallout",
      "paths": ["src/retry.ts", "src/queue.ts"],
      "highlights": [{ "path": "src/retry.ts", "start": 88, "end": 104 }],
      "createdAt": "2026-08-07T18:22:04.117Z"
    }
  ]
}
```

An **ordered array**, not a keyed object. Comments are keyed because `getComment` is O(1) against a
store holding hundreds; a workspace holds a handful of lenses, always read as a whole set. The
array preserves the order the agent chose, which is the order the picker shows — and the seed of
walkthrough step order later.

No retention policy, no archive, no purge. The file is replaced or deleted, never appended to. A
workspace removed from the registry leaves its lens file behind exactly as it leaves its comments;
`livediff prune` gains no new responsibility.

### SQLite

No. `DESIGN.md` names three triggers to revisit — routine cross-workspace queries, volumes in the
thousands, full-text search over history. Lenses hit none: a few KB per workspace, read whole,
never queried.

One standing argument in that section has rotted and is corrected as part of this work: it cites
`node:sqlite` needing Node 22.5+ "against a Node ≥18 target," but `package.json` now requires
`>=24`. That objection is dead. The two that remain are not — `better-sqlite3` is a native module,
which is the failure mode that breaks a global install on an unfamiliar machine, and greppable JSON
is load-bearing for a tool whose pitch is that you can read everything it does.

## Concurrency

**This is a real bug being fixed, not a hypothetical.**

`addComment` (`server/comments.ts:253–274`) reads the store, awaits `currentBranch()`, then writes.
The hub is one process but not one thread of execution: two in-flight requests interleave at those
awaits, both read the same snapshot, and the second write silently drops the first.

It has never manifested because comments arrive from a human clicking in a browser, one at a time.
An agent issuing lens writes concurrently would hit it immediately and get no error — just fewer
lenses than it wrote.

Two changes:

**A per-key async mutex**, new in `server/locks.ts`:

```ts
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
```

A `Map<string, Promise<unknown>>` of tail promises; each call chains onto the tail for its key and
replaces it, and the entry is deleted when its chain drains so the map cannot grow without bound. A
rejecting `fn` must not poison the chain for subsequent callers. Roughly fifteen lines, no
dependency.

Every read-modify-write against a workspace store — lenses **and** comments — runs inside
`withLock(wsId, …)`. Fixing comments is in scope: it is the same defect in code this work touches,
and leaving a known race in place next to a fixed one is worse than either.

**A whole-set write path**, so the common case never contends at all. `livediff lens set` replaces
the entire set in one request. For a handoff that is one round trip instead of N, atomic by
construction, and it makes "replaced at handoff" literal rather than emergent.

The skills are instructed never to issue lens writes in parallel. Parallelism is the right instinct
aimed at the wrong seam: one write beats three safe ones.

## HTTP

One path, four methods, following the existing `?ws=<id>` convention.

| Method                                | Body                | Effect                               | CLI                      |
| ------------------------------------- | ------------------- | ------------------------------------ | ------------------------ |
| `GET /api/lenses?ws=<id>`             | —                   | `{ lenses: [...] }`                  | `lens list`              |
| `PUT /api/lenses?ws=<id>`             | `{ lenses: [...] }` | replace the whole set                | `lens set`               |
| `POST /api/lenses?ws=<id>`            | one lens            | upsert by name, appending if new     | `lens add`               |
| `DELETE /api/lenses?ws=<id>&name=<n>` | —                   | remove one; omit `name` to clear all | `lens rm` / `lens clear` |

Every mutation broadcasts `lenses` over SSE with `{ reason, ws }`, matching the existing
`comments` and `workspaces` events, so an open browser updates without a reload.

The file watcher at `server/index.ts:585` gains a `lenses/<ws>.json` case alongside the comments
one, so hand-editing the file on disk is visible.

The CLI remains a pure HTTP client with no filesystem fallback.

## CLI

```
livediff lens set                                              read the whole set from stdin
livediff lens add <name> --path <glob>... [--why <text>]
                        [--highlight <path>:<start>-<end>]...
livediff lens list [--json]
livediff lens rm <name>
livediff lens clear
livediff open|review [path] [--lens <name>]
```

`lens` joins `config` and `completion` as a command with subcommands in the `COMMANDS` table in
`cli-help.ts`, which drives dispatch, help, completion, and did-you-mean in one place.

`lens set` reads JSON from stdin — `{ "lenses": [...] }`, or a bare array. `createdAt` is optional
on input and filled by the hub. This is the path the agent uses.

`--lens <name>` on `open` and `review` chooses which lens is _applied_ on arrival; every lens in
the set appears in the picker regardless. With no `--lens`, the browser opens on the full diff,
matching the wireframe's default.

A new `"lens"` completion kind in `cli-completion.ts` completes names for `lens rm` and `--lens`.

### Worked example

```bash
livediff lens set <<'EOF'
{"lenses": [
  {"name": "retry", "why": "the actual change; everything else is fallout",
   "paths": ["src/retry.ts", "src/queue.ts"],
   "highlights": [{"path": "src/retry.ts", "start": 88, "end": 104}]},
  {"name": "tests", "why": "coverage I added for the above", "paths": ["test/**"]}
]}
EOF
livediff review .
```

### Errors

All of these fail loudly and exit non-zero. Silence would mean reviewing the wrong thing while
believing otherwise, which is worse than a stopped command.

| Condition                                         | Behavior                                                |
| ------------------------------------------------- | ------------------------------------------------------- |
| `--lens <name>` naming a lens that does not exist | usage error, listing the names that do exist            |
| `lens add` with no `--path`                       | usage error — a lens matching nothing is never intended |
| name failing the pattern                          | usage error quoting the pattern                         |
| malformed `--highlight`                           | usage error showing the expected `path:start-end` form  |
| `end < start`, or either < 1                      | usage error                                             |
| `lens set` given invalid JSON or a bad shape      | usage error naming the offending lens index and field   |
| `lens rm <name>` for an absent name               | exit non-zero, say so                                   |
| any lens command outside a registered worktree    | the existing not-a-worktree error                       |

A `--highlight` whose `path` is not matched by that lens's own `paths` is a usage error. It would
otherwise silently never render.

## Browser

**Filtering.** `App.tsx:366` already narrows `diff.files` for the `?dir=` subdirectory filter. The
active lens composes with it as an intersection: `dir` **and** lens. The applied lens travels in
the URL as `&lens=<name>` next to `&dir=`, so a focused URL is still the whole shareable state.
Definitions come from `GET /api/lenses`.

The header gains a lens control per the wireframes: it reads out the applied lens, reads `Full
diff` when none is applied, and is visually inverted while a lens is active — a filtered diff must
never look like an unfiltered one. Opening it lists the set with `why` and a file count each.
Selecting the full-diff entry clears the filter. This slice does **not** build the full-screen
overlay; it is a dropdown from the header control.

Empty state: a lens matching zero files renders the existing "no changes" panel, worded for the
lens, with the control still offering the way back to the full diff.

**Highlights.** Each diff row already computes its own background class
(`src/components/FastDiff.tsx:216`), so a range renders as a tint on the rows it covers, with the
top corners rounded on its first row and the bottom corners on its last. That reads as a translucent
bubble over the region without introducing an element spanning rows, which is what would fight
virtualization.

Highlights render only for the applied lens, only on the new side, and only where the range
intersects lines actually present in the diff. In split mode the tint applies to the right-hand
column. A highlight in a file the lens filters out is unreachable by construction.

The tint is a distinct hue from the add/delete backgrounds and composes over them rather than
replacing them, so a highlighted addition still reads as an addition. It must clear a 3:1 contrast
ratio against both, in both themes.

## `.livediff`

A single markdown file at the worktree root, holding prose instructions that apply to every
livediff skill.

**livediff never parses it.** No schema, no validation, no version, nothing that can break. It is
read by the agent, and it is exactly as expressive as prose. Lens defaults live there as
instructions — _"always separate tests into their own lens"_, _"never lens-filter the lockfile"_ —
and so does anything else the user wants true of every livediff interaction.

The entire mechanism is one line added to each existing `SKILL.md`:

> If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

`livediff doctor` reports whether one is present. That is the only place the CLI acknowledges it.

## Skills

**New: `plugins/livediff/skills/lens/SKILL.md`.** Triggers on "review with these lenses", "walk me
through this", and on the agent's own handoff for review. It instructs:

- Build the set once, at handoff. Do not maintain lenses while working.
- Source it in order: what the user just asked for → `.livediff` defaults → the shape of the change.
- Emit exactly one `livediff lens set`. Never several calls, never in parallel.
- Then `livediff review . [--lens <name>]`.
- What makes a lens worth having: a lens covering 90% of the diff is worthless, and so is one
  covering a single file the user could have named. Aim for the cut a reviewer would want and
  would not have thought to ask for.

**Updated:** all six existing skills gain the `.livediff` line. `review/SKILL.md` additionally
learns that a handoff is two steps — set lenses, then review.

## Testing

Following the existing split.

**Unit (`test/`, node:test):**

- Glob matching — segment boundaries, `**` collapsing to zero segments at both edges, `?`,
  literals, case sensitivity, patterns with no metacharacters, and that `!`-prefixed patterns are
  literal rather than negating.
- Lens → file resolution against a fixture diff, including the zero-match case.
- `--highlight` parsing, valid and every malformed form in the error table.
- Name validation at both boundaries of the length range.
- Highlight → row-range resolution, including a range partly outside the available hunks and one
  entirely outside.
- `withLock`: serialization of interleaved writers, that a rejecting task does not poison the key,
  and that the map does not retain drained keys.
- A regression test for the comment race — two concurrent `addComment` calls, both must survive.
  It fails against today's code.

**Integration (`test/`, against a live hub):** each CLI verb round-tripping through HTTP; `lens
set` replacing rather than merging; `lens add` upserting by name; SSE `lenses` frames on every
mutation.

**E2E (`e2e/`, Playwright):** applying a lens narrows the file tree and diff; the header control
reflects the applied lens and inverts; clearing returns to the full diff; `&lens=` in the URL
applies on load; an unknown `&lens=` falls back to the full diff rather than an empty screen;
highlights render on the right rows with rounded ends; a zero-match lens shows the empty state with
a way out.

## Deferred

Named here so they are decisions rather than oversights: glob negation; old-side highlights;
lenses that persist across handoffs; staleness detection; hunk-level _filtering_ as opposed to
highlighting; the full-screen overlay; and everything in the lens concept beyond filtering —
annotations, buttons, diagram rendering, walkthroughs.
