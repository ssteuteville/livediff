---
name: comments
description: Read the user's inline livediff review comments and act on them.
when_to_use: >-
  "address my comments", "what did I comment", "check the diff feedback", "handle my review
  notes", or after the user says they left comments
allowed-tools: Bash(livediff *)
---

# Open review comments

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

!`livediff comments --status open`

The comments above are already loaded. Do not run the command again.

Each entry gives an id, `file:line`, the quoted source line, and the user's note.
**Trust the quoted line over the line number** — numbers drift as you edit, the quoted
text is the anchor.

Work through them, then close each one:

```bash
livediff resolve <id> <what you did>   # replies and resolves in one call
livediff reply   <id> <your question>  # replies without resolving
```

Use `reply` when you need the user to clarify. The browser updates live.

If nothing is listed above, there are no open comments — say so and stop. If an error
appears instead, the current directory is not a registered worktree; tell the user.
