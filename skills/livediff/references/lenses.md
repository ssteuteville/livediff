# Adding review context with lenses

A lens narrows the diff to a set of files and can mark line ranges inside them worth
looking at. A well-chosen set turns a large change into a handful of passes a reviewer can
actually get through, instead of one long scroll.

Build the set once, right before handing off — not incrementally while you work, since that
is a second artifact that can drift out of sync with the actual diff.

Source the lenses, in order of preference:

1. What the user asked for directly ("review with these lenses: x, y, z").
2. The shape of the change itself, if nothing more specific was asked for.

Replace the whole lens set in one call, piping JSON on stdin:

```
livediff lens set
```

with input shaped like:

```json
{
  "lenses": [
    {
      "name": "retry",
      "why": "the actual change; everything else is fallout",
      "paths": ["src/retry.ts", "src/queue.ts"],
      "highlights": [{ "path": "src/retry.ts", "start": 88, "end": 104 }]
    },
    { "name": "tests", "why": "coverage added for the above", "paths": ["test/**"] }
  ]
}
```

Use `lens set` for the whole set, not several `lens add` calls — one write can't lose a
lens partway through, but several racing writes can. (`lens add <name> --path <glob> [--why
<text>] [--highlight <path:start-end>]` exists for a single one-off addition, and `lens
list` / `lens rm <name>` / `lens clear` round out the set — run `livediff help lens` for the
full set of subcommands.)

Field notes:

- `paths` takes globs (`*`, `**`, `?`) and literal paths in the same list. A pattern with no
  metacharacter matches only itself.
- `highlights` are new-side line numbers, 1-based and inclusive, and must fall inside a file
  the same lens's `paths` already match — otherwise the command fails.
- `why` is one line, shown next to the lens in the picker; write it for someone who hasn't
  read the diff yet.
- `name` is kebab-case, 1-40 characters.

A lens covering nearly the whole diff is worthless — it is the diff. So is one covering a
single file the user could have named themselves. Aim for the cut a reviewer would want but
wouldn't have thought to ask for: the change itself separated from its fallout, a risky path
separated from a mechanical rename, the part that needs judgment separated from the part
that needs a skim. Three or four lenses is usually right; if you can't say what each one is
_for_ in one line, there are too many.

Hand off with one already applied if it makes sense to start there:

```
livediff review . --lens retry
```

Every lens in the set still appears in the picker either way.
