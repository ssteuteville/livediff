---
name: livediff
description: >-
  Open the current git worktree (or a GitHub pull request or branch) as a live browser
  diff for human review, add lenses and highlights that focus a reviewer on what matters,
  and retrieve and respond to the inline comments a reviewer leaves. Use this whenever
  someone asks to review changes, review a PR, open a diff, show a diff in the browser,
  hand off a change for review, check review comments, see what was commented on, address
  livediff feedback, or resolve or reply to livediff comments. Requires the livediff CLI.
license: MIT
compatibility: >-
  Requires the livediff CLI on PATH (install with `npx livediff@latest setup`). Opens a
  local browser-based review hub; agents without access to the user's local machine and
  browser (for example, fully remote or cloud-hosted agents) cannot use the review or
  comment workflows described here.
metadata:
  version: "0.11.2"
---

# LiveDiff

LiveDiff shows a git worktree as a live, browser-based diff. A human reviews it there and
leaves inline comments; this skill is how an agent hands work off for review and then acts
on what comes back — all through the `livediff` CLI.

## Before you start

- **The `livediff` CLI must be on PATH.** If a `livediff` command fails with "command not
  found" or similar, tell the user to run `npx livediff@latest setup` once, then retry. Do
  not attempt to install it yourself.
- **This only works with local access.** LiveDiff opens a hub on the user's machine and a
  real browser. If you are running as a fully remote or cloud-hosted agent with no access
  to the user's local machine and browser, say so and skip these workflows — running the
  CLI would register a worktree the user can never open.
- **Every command has help.** `livediff help <command>` or `livediff <command> --help`
  covers anything below in more detail, including flags not listed here.

## Quick reference

| The user wants                      | Run                                                     |
| ----------------------------------- | ------------------------------------------------------- |
| To see the diff, without waiting    | `livediff open .`                                       |
| Just a URL, no browser              | `livediff open . --no-open`                             |
| To hand off and wait for the review | `livediff review .`                                     |
| Every registered worktree           | `livediff list`                                         |
| Their review comments               | `livediff comments --json`                              |
| To review a PR or branch            | see [Reviewing a PR or branch](references/pr-review.md) |

## Opening a review

`livediff open <path>` registers a worktree and opens the hub's focused view on it in a
browser, printing the URL either way. `livediff .` is shorthand for the current directory.
Use `--base <ref>` to review everything a branch adds instead of just the last commit —
prefer a remote ref (`origin/main`) over a bare branch name, since a local branch can lag.

See [Opening and waiting for a review](references/opening-a-review.md) for the blocking
`review` command, how to bound the wait with `--timeout`, and how to keep a harness with a
command-execution timeout usable while a human takes their time reading.

## Adding review context

A large diff handed over with no guidance is a wall the reviewer has to find their own way
through. Before handing off, define lenses — named slices of the diff with an optional
highlighted line range — so the reviewer sees the shape of the change first.

See [Adding review context with lenses](references/lenses.md) for the exact command and
the rules for what makes a lens worth having.

## Retrieving and responding to comments

`livediff comments --json` prints open comments as structured data: an id, a `file:line`,
the quoted source line, and the reviewer's note. Trust the quoted line over the line
number — line numbers drift as a file is edited after a comment is left.

See [Retrieving and responding to comments](references/comments.md) — it also covers the
confirmation step required before marking a comment resolved on someone else's behalf.

## Reviewing a PR or branch

Given a PR URL, PR number, or branch name instead of a path, see
[Reviewing a PR or branch through livediff](references/pr-review.md). It walks through
resolving the target, placing a worktree, registering it, and — because creating a
worktree and changing branches both touch the user's repository state — the confirmation
this workflow requires before doing either.

## Destructive actions

Several livediff commands and PR-workflow steps change or delete something the user cannot
get back automatically: `livediff rm`, `livediff archive`, `livediff prune`, marking a
comment resolved, creating a git worktree, and fetching or checking out a branch. Never run
any of these without the user's explicit go-ahead for that specific action — see
[Retrieving and responding to comments](references/comments.md) and
[Reviewing a PR or branch](references/pr-review.md) for how each workflow surfaces that
confirmation. `livediff prune` in particular deletes archived comments permanently; always
run it with `--dry-run` first and report exactly what would be deleted before running it
for real.
