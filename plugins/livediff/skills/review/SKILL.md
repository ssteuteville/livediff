---
name: review
description: Open this worktree in livediff and wait until the user finishes reviewing.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

Run `livediff . --wait` as a **background** command. A review takes longer than any
foreground command timeout allows, and backgrounding keeps the session usable while
the user reads.

When it exits it prints a summary. Open comments in that summary are the work you are
being handed, not an error — load `/livediff:comments` and address them.
