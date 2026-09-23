---
name: pr
description: Turn a PR URL, PR number, or branch name into a registered livediff worktree, ready to review.
when_to_use: >-
  "review this PR", "open PR 12 in livediff", "review branch x", a pasted github.com pull
  URL
allowed-tools: Bash(livediff *), Bash(git *), Bash(gh *)
---

# Review a PR or branch through livediff

livediff reviews the worktree you are standing in. This skill turns a PR or branch into
one, then hands off to the skills that already know how to review it.

## 1. Resolve the target

| Argument              | Head                                                                                                              | Base                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PR URL or bare number | `gh pr view <n> --json number,headRefName,baseRefName,title,body`; `git fetch origin pull/<n>/head:<headRefName>` | `origin/<baseRefName>` after `git fetch origin <baseRefName>`                                                      |
| Branch name           | `git fetch origin <branch>`; local branch tracking it                                                             | remote default branch via `git symbolic-ref refs/remotes/origin/HEAD`, else `gh repo view --json defaultBranchRef` |

Fetch `pull/<n>/head` rather than `gh pr checkout` — it works for fork PRs and never
touches the worktree you're standing in.

Before creating anything, run `git worktree list --porcelain`. If the branch is already
checked out somewhere, reuse that path and skip worktree creation entirely.

## 2. Place the worktree

Follow whatever convention the project or user has already established — project
instructions, a hook, a stated preference. If none exists, ask once and suggest a sibling
directory named after the repo and branch. Never assume a machine-specific path.

Then `git worktree add <path> <branch>`.

## 3. Register

From the new worktree: honor `.livediff` at its root if present, then run
`livediff . --base origin/<base>`. Always the remote ref, never a bare `main` — a local
branch can lag the PR's real base. The base sticks to the workspace, so later `lens`,
`link`, `comments`, and `review` calls from that directory need no extra flags.

## 4. Read the diff before defining lenses

You did not write this change, so you cannot know its shape from memory, and lens
highlights are exact line numbers.

1. `git diff origin/<base>...HEAD --stat` for the shape.
2. Read the full diff for every file outside mechanical categories — lockfiles, generated
   code, snapshots, vendored assets. Those become one skim lens by path glob, with no
   highlights.
3. Use the PR title and body, when you have them, to write `why` lines and group lenses.

Only then load `/livediff:lens` and emit one `lens set`.

## 5. Hand off and clean up

If the user asked for a review rather than a look, continue into `/livediff:review` from
the worktree.

When `review --wait` exits, and only when this skill created the worktree, check
`git status` there. If it's clean, offer to remove the worktree and the local branch. A
decline leaves both in place. Never remove a worktree you reused or one with uncommitted
changes.
