---
name: lens
description: Define the ways to read a change before handing it to the user for review.
when_to_use: "review with these lenses", "walk me through this", "split this diff up", or whenever you are about to hand a change back for review
allowed-tools: Bash(livediff *)
---

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

A lens narrows the diff to a set of files and marks the ranges inside them worth looking at.
A set of them turns a 3,000-line change into four passes a human can actually finish.

## Build the set once, at handoff

Do not maintain lenses while you work. That is a second artifact to keep in sync with the
first, and it will drift. Write the whole set when you stop working — the next handoff
replaces it.

Source the set in this order:

1. What the user just asked for. "review with these lenses: x, y, z" is the whole answer.
2. `.livediff` defaults, if the file exists.
3. The shape of the change.

## Emit exactly one command

```bash
livediff lens set <<'EOF'
{"lenses": [
  {"name": "retry", "why": "the actual change; everything else is fallout",
   "paths": ["src/retry.ts", "src/queue.ts"],
   "highlights": [{"path": "src/retry.ts", "start": 88, "end": 104}]},
  {"name": "tests", "why": "coverage I added for the above", "paths": ["test/**"]}
]}
EOF
```

`lens set` replaces the whole set from stdin. Use it. Never several `lens add` calls, and
never in parallel — one write cannot lose a lens, three racing writes can.

Then hand off:

```bash
livediff review .            # opens on the full diff
livediff review . --lens retry   # opens with one already applied
```

Every lens in the set appears in the picker either way.

## Field notes

`paths` takes globs (`*`, `**`, `?`) and literal paths in the same list. A pattern with no
metacharacter matches only itself, so `test/**` is a category that picks up files added
later while `src/retry.ts` is exactly one file.

`highlights` are new-side line numbers, 1-based and inclusive. A highlight must fall inside
a file the lens's own `paths` match, or the command fails — it could never render otherwise.

`why` is one line, shown next to the lens in the picker. Write it for someone who has not
read the diff yet.

`name` is kebab-case, 1–40 characters.

## What makes a lens worth having

A lens covering 90% of the diff is worthless — it is the diff. So is one covering a single
file the user could have named themselves.

Aim for the cut a reviewer would want and would not have thought to ask for: the change
itself separated from its fallout, a risky path separated from a mechanical rename, the
part that needs judgment separated from the part that needs a skim.

Three or four lenses is usually right. If you cannot say what each one is _for_ in one
line, you have too many.
