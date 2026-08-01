---
name: open-worktree-diff
description: Show the current git worktree in livediff — a local, live browser diff hub — and read/answer the review comments the user leaves on it. Use when the user says "open a diff", "show me the diff", "register this worktree", "open livediff", "review my changes in the browser", or asks you to read/address their diff comments.
---

# livediff — show a worktree and handle its review comments

`livediff` is a local browser diff hub on `localhost` — no network, no telemetry. The user leaves
inline comments on your diff; you read them, make the edits, and reply.

You never touch livediff's storage. Everything goes through the CLI.

## Show the user a diff

```bash
livediff .
```

That is the whole thing. It registers the worktree containing the current directory, starts the hub
if it isn't running, and opens a focused view in the browser. There is no server to start first.

Add `--no-open` when the user is not at the machine, or when you just want the URL to share:

```bash
livediff . --no-open
```

Both print the URL. Share it with the user.

**Multiple worktrees.** Every registered worktree appears in one hub at `http://localhost:4180`.
Register each one with `livediff <path>`; the user switches between them in the left rail. Running
`livediff` with no arguments opens that hub view.

## Wait for a review

When the user says they want to review before you continue:

```bash
livediff . --wait
```

This blocks until the user clicks **Done reviewing** in the browser, then prints a summary. Open
comments at that point are the point — they are the work you are being handed, not an error.

## Read and answer comments

```bash
livediff comments          # from inside the worktree
livediff comments <path>   # from anywhere
livediff comments --json   # machine-readable
```

Each comment carries:

- `file` and `line` — where it was left
- `lineContent` — the exact line text at the time. **Trust this over `line`.** Line numbers drift
  as you edit; the quoted content is the anchor.
- `body` — what the user wants
- `status` — `open` or `resolved`
- `replies` — the thread so far

Work through the open ones, make the edits each asks for, then close the loop:

```bash
livediff resolve <comment-id> Switched to the refresh token.
livediff reply   <comment-id> Do you mean the outer call, or the retry?
```

`resolve` posts an optional reply and marks the thread resolved in one call. `reply` responds
without resolving — use it when you need the user to clarify. The browser updates live either way.

## Typical loop

1. User: *"show me your diff"* → `livediff .` → share the URL.
2. User leaves inline comments in the browser.
3. User: *"address my diff comments"* → `livediff comments` → make the edits.
4. `livediff resolve <id> <what you did>` for each. The user watches threads resolve live.

## Notes

- **Never read or write livediff's files directly.** Comments live outside the repo, and the
  storage location is free to change precisely because nothing depends on it. Use the CLI.
- Comments are scoped per worktree, so parallel agents never see each other's.
- Every command accepts `--json` for parsing, and exits `0` on success, `1` on error, `2` on
  a usage mistake.
- If something looks wrong with the install, `livediff doctor` reports it.
- `livediff --help`, or `livediff help <command>`, documents everything.
