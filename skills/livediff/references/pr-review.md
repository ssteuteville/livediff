# Reviewing a PR or branch through livediff

livediff reviews the worktree you are standing in, so reviewing a PR or branch means
turning it into one first, then following the same opening, lens, and comments workflow.

## 1. Resolve the target

| Given                 | Head                                                                                                                   | Base                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PR URL or bare number | `gh pr view <n> --json number,headRefName,baseRefName,title,body`, then `git fetch origin pull/<n>/head:<headRefName>` | `origin/<baseRefName>`, after `git fetch origin <baseRefName>`                                                       |
| Branch name           | `git fetch origin <branch>`, then a local branch tracking it                                                           | the remote default branch, via `git symbolic-ref refs/remotes/origin/HEAD` or `gh repo view --json defaultBranchRef` |

Fetch `pull/<n>/head` directly rather than checking the PR out with a tool that switches
branches in place — it works for pull requests from forks and never touches the worktree
you're already standing in.

Before creating anything, check `git worktree list --porcelain`. If the branch is already
checked out somewhere, reuse that path and skip creating a new one.

## 2. Place the worktree — with confirmation

Creating a worktree and fetching or checking out a branch both change the user's repository
state outside the one worktree you were asked to work in. **Tell the user what you're about
to create — the branch, and the path — before running `git worktree add <path> <branch>`,**
unless they already specified the path themselves. Follow whatever convention the project
has already established (an instruction file, a hook, a stated preference); if none exists,
suggest a sibling directory named after the repo and branch rather than guessing a
machine-specific path.

## 3. Register

From the new worktree, run `livediff open . --base origin/<base>` (or `livediff review .
--base origin/<base>` to go straight to waiting). Always use the remote ref, never a bare
`main` — a local branch can lag the PR's real base. The base sticks to that workspace, so
later `lens`, `comments`, and `review`/`open` calls from the same directory need no extra
flags.

## 4. Read the diff before defining lenses

You didn't write this change, so you can't know its shape from memory, and lens highlights
are exact line numbers that have to be right.

1. `git diff origin/<base>...HEAD --stat` for the shape of the change.
2. Read the full diff for anything outside mechanical categories — lockfiles, generated
   code, snapshots, vendored assets become one skim lens by path glob, with no highlights.
3. Use the PR title and body, when available, to write the `why` line for each lens and to
   decide how to group them.

Then follow [Adding review context with lenses](lenses.md) and emit one `lens set`.

## 5. Hand off and clean up — with confirmation

If the user asked for a review rather than just a look, continue into `livediff review .`
(see [Opening and waiting for a review](opening-a-review.md)) from the new worktree.

When the review finishes, and only when this workflow created the worktree itself, check
`git status` there. If it's clean, **ask the user before removing anything** — offer to
remove the worktree and its local branch (`git worktree remove <path>`, then delete the
branch), and take a decline as leaving both in place. Never remove a worktree you reused, or
one with uncommitted changes.
