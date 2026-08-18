---
name: link
description: Print the livediff URL for this worktree without opening a browser.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

!`livediff . --no-open`

Give the user the URL above and nothing else.
