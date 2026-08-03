# Related projects

A place to track tools solving adjacent problems, so we can steal from them deliberately rather
than rediscover things. Not a competitive analysis — a source of ideas.

## cmux-hub

<https://github.com/azu/cmux-hub> — MIT, ~39 stars, 146 commits as of August 2026.

> "A browser-based diff viewer for cmux. See what changed at a glance — syntax-highlighted diffs,
> inline review comments, commit history, GitHub PR status, and custom toolbar actions, all
> streamed in real time via WebSocket."

The closest thing to livediff that exists. Same shape — `server/`, `src/`, `.claude-plugin/`,
React 19 + Tailwind, a hub that serves a diff UI, inline review comments, worktree support. We
were both inspired by [difit](https://difit.dev/), which is probably why.

### Where it differs structurally

**Comments go to a terminal, not through a CLI.** cmux-hub talks to cmux over a Unix domain
socket (`/tmp/cmux.sock`) via JSON-RPC. It is a diff viewer *for cmux*. livediff's comments go
through `livediff comments`, which any shell-capable agent can call — that was the deliberate
premise of the v0.4 CLI-first redesign, and it is why Codex, Gemini, and agy can use livediff
without livediff knowing they exist. Different choice, not a worse one; it buys them a tighter
integration and costs them portability.

**Bun, not Node.** Also Shiki rather than lowlight for highlighting, and WebSocket rather than SSE.

### Two places they chose the opposite of us, deliberately

- **"Auto-shutdown when browser tab closes."** We rejected this during the v0.4 design: a frozen
  or discarded Chrome tab cannot restart a hub that killed itself. livediff goes dormant instead —
  it suspends the poll loop with no client attached but never exits. See DESIGN.md.
- **A `SessionStart` hook that downloads and installs the binary.** We called this invasive when
  considering whether the plugin should install the CLI. Note the narrower version is fine and we
  may still want it: a `SessionStart` or `PreToolUse` hook that merely runs `livediff . --no-open`
  to register the worktree is cheap and idempotent.

### What they have that we do not

Worth revisiting when we want features rather than performance:

- GitHub PR integration — CI status and PR review comments in the UI
- Commit history browser, shown when there are no pending changes
- Branch selector for switching the diff base (we have `?base=` as a request param, no UI)
- Custom toolbar actions defined in JSON, with submenus
- Plan file viewer for Claude Code session plans
- Self-update command

### What they have not solved

**Large diffs.** No virtualization dependency in `package.json` — no react-window, TanStack
Virtual, virtua, or react-virtuoso — so they render every row, the same as livediff's `classic`
renderer. Their Shiki highlighting is heavier per line than our lowlight, so a 20k-line diff
plausibly costs them more, not less.

This is the gap the v0.7 renderer work targets, and the reason it is worth building rather than
borrowing. See `2026-08-02-large-diff-performance.md`.

Second-order note: once rendering is virtualized we only highlight the ~50 visible rows, which
makes an expensive highlighter affordable. **Shiki becomes a viable upgrade after virtualization,
not before.**

## Integration surface — conclusions from discussing cmux

livediff already has three integration points and needs no plugin framework for most of what a
terminal integration would want:

| Need | Answer | Status |
| --- | --- | --- |
| Where does the URL open? | `LIVEDIFF_BROWSER`, e.g. `cmux open-window` | Works; fixed to accept arguments in 0.6 |
| When does livediff fire? | A Claude Code hook running `livediff . --no-open` | Works, no livediff change needed |
| Push comments out to a terminal | Would need richer SSE payloads | Not built |

The third is the only one that needs anything from us. Today the `comments` SSE event carries
`{reason, ws}` and the browser refetches — deliberate, because it makes the browser the single
reader. An integration that wants to *forward* a comment needs the comment in the event.

If we ever do want outbound integrations, the cheap shape is **hooks that run a command**, mirroring
Claude Code's own model, rather than a plugin API with a lifecycle to version:

```json
// ~/.config/livediff/hooks.json
{ "comment.created": "cmux send-keys 'address my diff comments'" }
```

Three constraints if that gets built:

1. **User-scoped config only, never repo-scoped.** Reading hooks from a cloned repo would execute
   a stranger's command on `livediff .`.
2. **Richer event payloads first.** That is the actual work; the hook runner is ~50 lines.
3. **Fire-and-forget with a timeout.** A hanging hook must never wedge the poll loop.

Deferred deliberately — the payload work gets cheaper once the new renderer needs finer-grained
updates than "refetch everything".
