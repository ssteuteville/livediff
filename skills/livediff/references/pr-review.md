# Reviewing a PR or branch through livediff

livediff reviews the worktree you are standing in, so reviewing a PR or branch means
turning it into one first, then following the same opening, lens, and comments workflow.

## 1. Resolve the target — read-only

| Given                 | Head                                                              | Base                                                                                                                 |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PR URL or bare number | `gh pr view <n> --json number,headRefName,baseRefName,title,body` | `origin/<baseRefName>`, the same field                                                                               |
| Branch name           | the branch name itself                                            | the remote default branch, via `git symbolic-ref refs/remotes/origin/HEAD` or `gh repo view --json defaultBranchRef` |

This step only looks things up — it doesn't fetch or create anything yet. Before doing
either, check `git worktree list --porcelain`: if the branch is already checked out
somewhere, reuse that path and skip the fetch and worktree creation below entirely.

## 2. Confirm before touching the repository

Fetching a PR or branch creates or updates a local branch, and creating a worktree adds a
new working directory — both change the user's repository state outside the one worktree
you were asked to work in. **Tell the user, before running anything below: which branch
you'll fetch or create, and the worktree path** — then get a go-ahead before running any
`git fetch`, `git worktree add`, or checkout. Skip asking only if the user already told you
exactly what to fetch and where to place it.

## 3. Fetch and place the worktree

For a PR URL or bare number, fetch `pull/<n>/head` directly rather than checking the PR out
with a tool that switches branches in place — it works for pull requests from forks and
never touches the worktree you're already standing in:

```
git fetch origin pull/<n>/head:<headRefName>
git fetch origin <baseRefName>
```

For a branch name, `git fetch origin <branch>` and track it locally.

Then place the worktree: follow whatever convention the project has already established
(an instruction file, a hook, a stated preference); if none exists, suggest a sibling
directory named after the repo and branch rather than guessing a machine-specific path.

```
git worktree add <path> <branch>
```

## 4. Register

If `.livediff` exists at the root of the new worktree, read it and follow it before doing
anything else. Otherwise, run `livediff open . --base origin/<base>` (or `livediff review .
--base origin/<base>` to go straight to waiting). Always use the remote ref, never a bare
`main` — a local branch can lag the PR's real base. The base sticks to that workspace, so
later `lens`, `comments`, and `review`/`open` calls from the same directory need no extra
flags.

## 5. Read the diff before defining lenses

You didn't write this change, so you can't know its shape from memory, and lens highlights
are exact line numbers that have to be right.

1. `git diff origin/<base>...HEAD --stat` for the shape of the change.
2. Read the full diff for anything outside mechanical categories — lockfiles, generated
   code, snapshots, vendored assets become one skim lens by path glob, with no highlights.
3. Use the PR title and body, when available, to write the `why` line for each lens and to
   decide how to group them.

Then follow [Adding review context with lenses](lenses.md) and emit one `lens set`.

## 6. Hand off and clean up — with confirmation

If the user asked for a review rather than just a look, continue into `livediff review .`
(see [Opening and waiting for a review](opening-a-review.md)) from the new worktree.

When the review finishes, and only when this workflow created the worktree itself, check
`git status` there. If it's clean, **ask the user before removing anything** — offer to
remove the worktree and its local branch (`git worktree remove <path>`, then delete the
branch), and take a decline as leaving both in place. Never remove a worktree you reused, or
one with uncommitted changes.
