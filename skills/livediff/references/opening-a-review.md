# Opening and waiting for a review

`livediff open [path] [--base <ref>] [--no-open] [--wait] [--timeout <sec>] [--lens <name>]`
registers a worktree and opens its focused view. Without `--wait` it returns immediately
after printing the URL — use this when you just want to show the user something.

`livediff review [path] [--base <ref>] [--no-open] [--timeout <sec>] [--lens <name>]` does
the same thing but always waits for the reviewer to click "Done reviewing" before it exits
(it behaves like `livediff open --wait`). Use it when you are handing off a change and want
to act on the outcome — it prints a summary of the review, including any open comments,
when it exits.

## The wait has no default limit

By default, both the wait in `review` and `open --wait` block until a human acts, with no
timeout. That's correct for an interactive session where waiting is free, but it will
exceed a fixed command-execution timeout in many harnesses. Handle it one of two ways:

- **Bound the wait and re-run.** Pass `--timeout <sec>` so the command returns control
  after that many seconds even if the review isn't done yet, then call it again later (or
  just poll comments, below) instead of leaving a review open indefinitely inside one call.
- **Run it as a background process and poll.** If your harness supports starting a process
  in the background and continuing the session, start `livediff review .` that way, then
  periodically run `livediff comments --status open --json` to see what's been left so far
  and `livediff status` to see whether the hub still considers the review open. Do not
  register the same worktree with a second, overlapping `review` or `open --wait` call
  while one is already running against it.

Check what your specific harness actually supports — a configurable timeout, running a
command in the background, or neither — before choosing. Don't assume either is available.

## Choosing a lens on arrival

`--lens <name>` opens the review with one lens already applied, instead of the full diff.
It only picks which view opens first; every lens defined for the workspace still shows up
in the picker. See [Adding review context with lenses](lenses.md) for how to define them.
