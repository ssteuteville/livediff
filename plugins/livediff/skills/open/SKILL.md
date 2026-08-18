---
name: open
description: Show the user the current git worktree as a live browser diff they can comment on.
when_to_use: "show me the diff", "open a diff", "open livediff", "let me see your changes", "give me a link to the diff", "review my changes in the browser"
allowed-tools: Bash(livediff *)
---

# Show a worktree in livediff

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

Pick one row. Run it once. Do not check anything first — there is no server to start
and no state worth inspecting.

| The user wants               | Run                    |
| ---------------------------- | ---------------------- |
| to see the diff              | `livediff .`           |
| a link or URL, not a browser | `livediff . --no-open` |
| a specific worktree          | `livediff <path>`      |
| every registered worktree    | `livediff`             |

Each prints a URL. Give it to the user.

If the output says it could not open a browser, pass the URL along and say so — the
worktree is registered either way.
