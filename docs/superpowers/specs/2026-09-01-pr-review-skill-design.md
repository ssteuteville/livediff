# Review a PR or branch through livediff

## Problem

livediff reviews the worktree you are standing in. Reviewing someone else's pull request
means creating a worktree, fetching the branch, working out the right base, registering it,
and only then defining lenses — four manual steps before the first useful screen. Nothing in
the plugin knows how to do that, and every existing skill assumes the worktree already exists.

## Decision

Add one plugin skill, `/livediff:pr`, that turns a PR URL, PR number, or branch name into a
registered worktree with the right base, then hands off to the existing `lens` and `review`
skills. The CLI and server do not change. GitHub stays out of the core, as
`docs/DECISIONS.md` requires; the skill is the only place `gh` is called.

## Skill contract

Frontmatter: `name: pr`, `allowed-tools: Bash(livediff *), Bash(git *), Bash(gh *)`.
`when_to_use` covers "review this PR", "open PR 12 in livediff", "review branch x", and a
pasted github.com pull URL.

### 1. Resolve the target

The argument is classified and reduced to a local branch, a base ref, and a label.

| Argument              | Head                                                                                                              | Base                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PR URL or bare number | `gh pr view <n> --json number,headRefName,baseRefName,title,body`; `git fetch origin pull/<n>/head:<headRefName>` | `origin/<baseRefName>` after `git fetch origin <baseRefName>`                                                      |
| Branch name           | `git fetch origin <branch>`; local branch tracking it                                                             | remote default branch via `git symbolic-ref refs/remotes/origin/HEAD`, else `gh repo view --json defaultBranchRef` |

Fetching `pull/<n>/head` rather than running `gh pr checkout` keeps fork PRs working and
never touches the worktree the agent is standing in.

Before creating anything, `git worktree list --porcelain` is checked. If the branch is
already checked out in a worktree, that path is reused and no worktree is created.

### 2. Place the worktree

The skill does not choose a location. It instructs the agent to follow any worktree
convention the project or user has already established (project instructions, hooks, a
stated preference). When none exists, the agent asks once and suggests a sibling directory
named after the repository and branch. Machine-specific paths are never assumed, so the skill
behaves the same on any device.

Then `git worktree add <path> <branch>`.

### 3. Register

From the new worktree: honor `.livediff` at its root if present, then run
`livediff . --base origin/<base>`. The base sticks to the workspace, so later `lens`,
`link`, `comments`, and `review` invocations from that directory need no extra flags.

### 4. Read the diff before defining lenses

This is the step that differs from an agent handing off its own work. The agent did not
write this change, so it cannot know the shape from memory, and lens highlights are exact
line numbers.

1. `git diff origin/<base>...HEAD --stat` for the shape.
2. Read the full diff for files outside mechanical categories: lockfiles, generated code,
   snapshots, vendored assets.
3. Use the PR title and body, when available, as input to `why` lines and lens grouping.
4. Mechanical categories become a single skim lens by path glob, without highlights.

Only after this does the agent load `/livediff:lens` and emit one `lens set`. The `lens`
skill itself is unchanged.

### 5. Hand off and clean up

If the user asked for a review rather than a look, the skill continues into
`/livediff:review` from the worktree, backgrounded as that skill already requires.

When `review --wait` exits, and only when this skill created the worktree, the agent checks
`git status` there and, if clean, offers to remove the worktree and the local branch. A
decline leaves both in place; `livediff prune` drops stale registry entries later. The agent
never removes a worktree it reused or one with uncommitted changes.

## Pointers in existing skills

`open` and `review` each gain one line: when given a PR URL, PR number, or branch name in
place of a path, load `/livediff:pr`. No other skill changes.

## Docs

- `README.md`: one row in the Claude Code and Codex table for `/livediff:pr`.
- `docs/PRODUCT.md`: note that PR and branch review is supported through a worktree, and
  that the "GitHub PR context" direction remains open.

## Out of scope

Syncing comments back to GitHub. Tags or SHAs as targets. A base picker in the hub UI. Any
`livediff --pr` flag; the skill proves the shape first.

## Verification

Skills are prose, so there is no unit under test. Verification is a walkthrough in a scratch
repo with a real PR: URL, bare number, and branch each produce a registered worktree whose
`livediff config get` shows the expected base, a lens set with real line highlights, and a
cleanup offer only when the skill created the worktree. `pnpm verify` still passes, since
`README.md` and skill files are lint targets.
