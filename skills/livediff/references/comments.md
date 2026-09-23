# Retrieving and responding to comments

```
livediff comments [path] [--status open|resolved|all] [--branch <name>] [--base <ref>] [--stale|--archived]
```

`livediff comments --json` (with `--status open`, the default) prints comments as
structured data instead of a formatted list — an id, `file:line`, the quoted source line,
and the reviewer's note, for every comment matching the filters. Prefer `--json` when you
are going to parse the output rather than show it directly to a person.

**Trust the quoted source line over the line number.** Numbers drift as a file is edited
after a comment is left; the quoted text is the anchor that still points at the right spot.

## Responding

```
livediff resolve <id> [text...]   # reply and mark resolved, in one call
livediff reply   <id> <text...>   # reply without resolving
```

Use `reply` when you need the user to clarify something, or whenever you aren't certain the
comment is actually settled. `resolve` is a stronger claim: it tells the reviewer this
thread is done.

**Get the user's go-ahead before running `resolve` on their comments.** Resolving is
something you're doing on the user's behalf — closing a conversation they started — and it
is not automatically implied by "fix what was commented on." Confirmation can come from an
instruction that already covers it (a user who says "fix my comments and resolve them" has
already given it for that batch), or from telling them, as you go, exactly which comment
you're about to mark resolved and why, so they can object before it happens. When you're
not sure you have it, use `reply` with what you changed and let the user resolve it
themselves.

## Other views

- `livediff comments --stale` — comments whose file has left the diff entirely.
- `livediff comments --archived` — archived comments, and how many days remain before
  `livediff prune` deletes them for good (see
  [the destructive-actions note](../SKILL.md#destructive-actions)).
- `livediff archive [path] [--stale] [--resolved]` moves comments out of the live view.
  **Confirm with the user first** — archived comments are headed for eventual deletion by
  `livediff prune`, even though `livediff restore <id>` can bring one back before that
  happens.
