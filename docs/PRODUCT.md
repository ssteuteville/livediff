# Product

## Purpose

LiveDiff is a local, browser-based workspace diff viewer for people and coding agents working in Git repositories. It makes a worktree's changes easy to inspect, lets a reviewer leave inline comments, and gives any shell-capable agent a simple CLI to read and resolve that feedback.

The important unit is the worktree, not a hosted pull request or a particular coding environment. A reviewer can move between worktrees in one local hub; agents interact with the same review state through the `livediff` CLI.

## What it optimizes for

- Fast local review without an account, remote service, or repository upload.
- A useful handoff between a browser reviewer and any coding agent that can run shell commands.
- Correct, durable comment state across changed, deleted, and restored files.
- A low-friction install for Claude Code and Codex, while keeping the core interface portable.
- Large diffs that remain useful rather than attempting to render every line at any cost.

## Deliberate boundaries

- LiveDiff is not a hosted code-review system and does not replace GitHub or another forge.
- It does not require an MCP server: the CLI is the portable integration surface.
- It does not attempt authentication, multi-user access control, or network exposure. The hub binds only to loopback.
- It does not promise to render an entire arbitrarily large diff at once. Visible, actionable content wins over exhaustive DOM output.

## Current direction

The next product questions are about making local review more capable without giving up its small, local shape:

- Improve the large-diff experience through bounded rendering, smarter diff retrieval, and clear navigation to relevant files and comments.
- Consider features proven useful by adjacent tools: commit history, a base-branch picker, and optional PR context.
- Preserve agent portability as integrations evolve; a plugin should enhance discovery and workflow, not become the only way to use LiveDiff.

## Adjacent projects and inspiration

### difit

[difit](https://difit.dev/) is a shared point of inspiration for the local browser-diff workflow. LiveDiff borrows the immediacy of reviewing a local change set, while concentrating on a durable browser-to-agent feedback loop.

### cmux-hub

[cmux-hub](https://github.com/azu/cmux-hub) is the closest adjacent project: a browser diff viewer with inline review and live updates. Its cmux-specific terminal socket creates a tighter integration for that environment. LiveDiff deliberately uses CLI commands instead, so Claude Code, Codex, Gemini, agy, and ordinary shell workflows can all participate without special runtime knowledge.

cmux-hub also highlights future opportunities worth evaluating: GitHub PR context, commit-history browsing, an interactive diff base, and configurable toolbar actions. These are directions, not commitments.

### Diff rendering

[`@git-diff-view/react`](https://github.com/MrWangJustToDo/git-diff-view) provides the side-by-side and unified diff rendering foundation. LiveDiff owns workspace state, comments, lifecycle handling, and the review workflow around that renderer.
