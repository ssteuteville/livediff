# Opening and waiting for a review

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

`livediff open [path] [--base <ref>] [--no-open] [--wait] [--timeout <sec>] [--lens <name>]`
registers a worktree and opens its focused view. Without `--wait` it returns immediately
after printing the URL — use this when you just want to show the user something.

`livediff review [path] [--base <ref>] [--no-open] [--timeout <sec>] [--lens <name>]` does
the same thing but always waits for the reviewer to click "Done reviewing" before it exits
(it behaves like `livediff open --wait`). Use it when you are handing off a change and want
to act on the outcome. On exit it only prints a count — "review complete ✓ — N comments (M
open)", and as JSON `{ comments: N, openComments: M }` — not the comments themselves. Run
`livediff comments --json` afterward to read them (see
[Retrieving and responding to comments](comments.md)).

## The wait has no default limit

By default, both the wait in `review` and `open --wait` block until a human acts, with no
timeout. That's correct for an interactive session where waiting is free, but it will
exceed a fixed command-execution timeout in many harnesses. Handle it one of two ways:

- **Bound the wait and re-run.** Pass `--timeout <sec>`. When it elapses, the command exits
  non-zero with "timed out after Ns waiting for review" — that's an expected outcome of
  bounding the wait, not a failure to report as one. After a timeout, don't just re-run the
  same wait: poll `livediff comments --status open --json` for what's been left so far,
  and/or ask the user whether they're still reviewing. Only start another wait if they say
  they are, and add `--no-open` to the re-run — otherwise every retry opens a new browser
  tab. If the user actually clicked "Done reviewing" between your calls, a fresh wait has
  nothing left to wait for and will block until the next click (which may never come) or
  its own timeout, so confirming with the user first matters more than retrying quickly.
- **Run it as a background process and poll.** If your harness supports starting a process
  in the background and continuing the session, start `livediff review .` that way, then
  periodically run `livediff comments --status open --json` to see what's been left so far.
  `livediff status` reports whether the hub is running, not whether a particular review is
  still open — it won't tell you the wait finished. Do not register the same worktree with
  a second, overlapping `review` or `open --wait` call while one is already running
  against it.

Check what your specific harness actually supports — a configurable timeout, running a
command in the background, or neither — before choosing. Don't assume either is available.

## Choosing a lens on arrival

`--lens <name>` opens the review with one lens already applied, instead of the full diff.
It only picks which view opens first; every lens defined for the workspace still shows up
in the picker. See [Adding review context with lenses](lenses.md) for how to define them.
