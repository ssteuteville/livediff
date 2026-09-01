---
name: review
description: Open this worktree in livediff and wait until the user finishes reviewing.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

Given a PR URL, PR number, or branch name instead of a path, load `/livediff:pr` first.

Handing off a change is two steps, not one. Define the lenses first — load `/livediff:lens`
— then start the review. A large change handed over without them is a wall the user has to
find their own way through.

Run `livediff . --wait` as a **background** command. A review takes longer than any
foreground command timeout allows, and backgrounding keeps the session usable while
the user reads.

When it exits it prints a summary. Open comments in that summary are the work you are
being handed, not an error — load `/livediff:comments` and address them.
