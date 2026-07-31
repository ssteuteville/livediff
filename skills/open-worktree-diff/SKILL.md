---
name: open-worktree-diff
description: Show the current git worktree in livediff — a local, live browser diff hub — and read/answer the review comments the user leaves on it. Use when the user says "open a diff", "show me the diff", "register this worktree", "open livediff", "review my changes in the browser", or asks you to read/address their diff comments.
---

# livediff — register a worktree & handle its review comments

`livediff` is a local browser diff **hub**. It runs on `localhost` (no network, no telemetry) and
shows every worktree you register, each with its own live-updating diff and inline review comments.
Nothing appears until you register it, so registering the current worktree is the first step.

Assume the `livediff` CLI is on `PATH` (installed via the repo's `install.sh`). If it is not, fall
back to `node <path-to-livediff>/server/cli.js` with the same arguments.

`REPO` below = the absolute path of the worktree the user is working in (usually `$PWD`).

## Show the current worktree

1. Make sure the hub is running. Probe it:
   ```
   curl -s http://127.0.0.1:4180/api/meta
   ```
   If that fails, start the hub in the background (it stays up across your edits):
   ```
   LIVEDIFF_OPEN=1 livediff &
   ```
   `LIVEDIFF_OPEN=1` opens the browser. Omit it and share the URL yourself if you'd rather not.

2. Open a **focused** view of this worktree — this is the default way to open livediff. It registers
   the worktree if needed, then opens the browser straight to it with the workspaces rail hidden:
   ```
   livediff open "$REPO"
   ```
   It prints the focused URL, e.g. `http://localhost:4180/?ws=<id>&focus=1`. Share that URL with the
   user.

   The focused URL is also constructable directly: `?ws=<id>&focus=1`, or `?path=<dir>&focus=1`
   (any directory inside the worktree resolves).

   Only skip focused mode if the user explicitly wants the multi-workspace view (to see/switch
   between several registered worktrees) — then use `livediff add "$REPO"` and share the plain hub
   URL (`http://localhost:4180`), which shows the rail.

3. Tell the user the URL. The view updates on its own as you edit — no need to restart or re-register.

To stop showing it later: `livediff rm "$REPO"`. This only unregisters; it never touches the repo
or its comments.

## Read the user's comments

Talk to livediff only through the `livediff` CLI or its HTTP API — never read or edit the comments
file directly. Where/how comments are stored is an internal detail of the hub.

Run `livediff comments` from inside the worktree (or `livediff comments "$REPO"` from elsewhere). It
resolves the workspace from the given directory automatically and prints
`{ "workspace": "<id>", "comments": [ ... ] }`. Each comment gives you `file`, `line`, the **exact
`lineContent`** it was anchored to (trust this over the line number, since the worktree shifts),
`body`, and `status`. Only act on `open` comments unless told otherwise.

Because comments are stored per worktree, you only ever see the comments left on *your* diff — other
agents' worktrees are separate.

## Answer / resolve comments

Prefer the CLI — it resolves the workspace from `$PWD`, so no ids to look up:
```
livediff resolve <comment-id> Switched to the refresh token.
```
This posts the text as a reply (author `claude`) and marks the comment resolved in one step. To
reply without resolving, use `livediff reply <comment-id> <text…>`. Omit the text to `resolve` to
just mark it done with no reply.

Equivalent HTTP API, if you need it (pass `?path=<dir>` — any directory inside the registered
worktree resolves):
```
curl -s -X PATCH "http://127.0.0.1:4180/api/comments/<comment-id>?path=$REPO" \
  -H 'content-type: application/json' \
  -d '{"reply":{"author":"claude","body":"Switched to the refresh token."},"status":"resolved"}'
```
Add your own comment with `POST /api/comments?path=<dir>` and
`{file, side:"new"|"old", line, lineContent, body, author:"claude"}`.

## Typical flow

1. User: "show me your diff" → start hub if needed, `livediff add "$PWD"`, share the URL + workspace.
2. User leaves inline comments in the browser and says "address my diff comments".
3. Run `livediff comments`, make the edits each open comment asks for.
4. `livediff resolve <id> <reply text>` for each. The user watches the threads resolve and the diff
   refresh live.
