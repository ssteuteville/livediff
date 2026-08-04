# livediff v0.4 Dormancy, Reviews & Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish v0.4 — a hub that costs nothing when nobody is watching, an explicit "Done reviewing" gate for `--wait`, a `doctor` command that proves the cutover took, npm-style packaging, and documentation rewritten for the new model.

**Architecture:** The hub gates its `git status` poll loop on SSE client count, so an idle hub is resident but free. Because the CLI is now a pure HTTP client (Plan 1), the hub performs every mutation itself and emits SSE in-process; `fs.watch` on the config dir remains only as a safety net for hand-edited JSON. Review requests are in-memory hub state surfaced as a header button, closing the `--wait` loop.

**Tech Stack:** Node ≥18, ESM, zero runtime dependencies, `node:test`, React 19 + Tailwind 3 frontend.

**Spec:** `docs/superpowers/specs/2026-07-31-livediff-cli-first-design.md` §5, §6.3, §7, §9, §10.1, §10.3, §11. Plan 1 (`2026-07-31-livediff-v04-foundation.md`) covered §4, §6.1–6.2, §8, §10.2.

## Global Constraints

- Node ≥18. Zero new runtime **or** dev dependencies.
- ESM only, `node:` prefixed builtins. Server binds `127.0.0.1` only.
- All JSON writes atomic via `writeJsonAtomic`.
- Tests set `XDG_CONFIG_HOME` and `XDG_STATE_HOME` to temp dirs and pin their own `LIVEDIFF_PORT` band — `node --test` runs files in parallel. Bands in use: hub-startup 4187–4192, ensure-hub 4193–4196, cli 4197. **New:** dormancy 4198, reviews 4199, doctor 4201.
- Port 4190 and the rest of the WHATWG Fetch blocklist must never be used in tests or defaults.
- React: no render functions (extract components), no nested ternaries (extract a named helper with `if`/`return`), Tailwind utilities over inline styles.
- Prefer no comments; when one is needed it explains _why_.
- Conventional Commits.

---

## File Structure

**Create:**

- `server/reviews.js` — in-memory review-request registry. One responsibility: open/complete/cancel/list.
- `server/doctor.js` — diagnostics, returns structured findings; rendering lives in the CLI.
- `src/components/ReviewBanner.jsx` — the "Done reviewing" header control.
- `test/dormancy.test.js`, `test/reviews.test.js`, `test/doctor.test.js`

**Modify:**

- `server/index.js` — client-count gating, auto-prune, in-process events, `fs.watch` safety net, review routes.
- `server/cli.js` — `--wait`, `doctor` command.
- `server/cli-help.js` — `doctor` entry, `--wait`/`--timeout` flags.
- `src/api.js` — review endpoints + `review` SSE frame.
- `src/App.jsx` — review state, banner, corrected empty-state copy.
- `package.json` — `files`, `prepack`, drop `private`.
- `install.sh` — pack + global install, cutover cleanup.
- `DESIGN.md`, `README.md`, `skills/open-worktree-diff/SKILL.md` — full rewrites.

---

### Task 1: Dormancy and auto-prune

**Files:** Modify `server/index.js`; create `test/dormancy.test.js`.

**Interfaces:** Produces `GET /api/meta` → adds `clients: number`, `polling: boolean`. Auto-prune emits `workspaces` with `reason: "pruned"`.

- [ ] **Step 1: Write the failing test** — assert `/api/meta` reports `polling:false` with no SSE client, `polling:true` once one connects, back to `false` after it disconnects; assert a registered workspace whose directory is deleted disappears from `/api/workspaces`.
- [ ] **Step 2: Run it, expect failure** (`polling` undefined).
- [ ] **Step 3: Implement** — wrap the poll interval in `startPolling()`/`stopPolling()` driven by `sseClients.size` transitions in the `/api/events` handler and its `close` listener. In each tick, drop workspaces whose path fails `access()` or is no longer a git dir.
- [ ] **Step 4: Run tests, expect pass. Step 5: Commit.**

### Task 2: In-process events and fs.watch safety net

**Files:** Modify `server/index.js`.

Because the hub is the sole writer, mutation handlers already `broadcast()` synchronously — the poll loop's comment-file signature check is redundant and adds a up-to-1s delay. Remove comment-signature polling; add a `fs.watch` on the config dir that broadcasts when a _hand edit_ changes `workspaces.json` or `comments/*.json`, debounced 50ms, degrading to mtime polling if `fs.watch` throws.

- [ ] Steps: failing test (hand-edit a comments file, assert a `comments` frame arrives) → implement → pass → commit.

### Task 3: Review requests

**Files:** Create `server/reviews.js`, `test/reviews.test.js`; modify `server/index.js`.

**Interfaces:**

- `openReview(ws): {reviewId, ws, startedAt}` — returns the existing request if one is open for `ws`.
- `completeReview(reviewId): request | null`, `cancelReview(reviewId): boolean`, `reviewFor(ws): request | null`
- Routes: `POST /api/reviews` `{ws}`; `DELETE /api/reviews/:id`; `POST /api/reviews/:id/done`; `GET /api/reviews?ws=`
- SSE frame `review` → `{ws, reviewId, state: "open"|"done"|"cancelled"}`

- [ ] Steps: failing test (open → duplicate open returns same id → done broadcasts → done twice is 404) → implement → pass → commit.

### Task 4: CLI `--wait`

**Files:** Modify `server/cli.js`, `server/cli-help.js`; extend `test/cli.test.js`.

`livediff <path> --wait` opens a review, subscribes to `/api/events`, and exits 0 on the matching `review-done`. `--timeout <sec>` optional. `Ctrl-C` cancels the request and exits non-zero. A second `--wait` on the same workspace attaches rather than duplicating.

Note: `EventSource` is not available in Node 18. Consume the SSE stream by reading the `fetch` response body as a stream and splitting on `\n\n` — no dependency.

- [ ] Steps: failing test (spawn `--wait`, POST done, assert exit 0 and summary line) → implement → pass → commit.

### Task 5: UI — Done reviewing button

**Files:** Create `src/components/ReviewBanner.jsx`; modify `src/api.js`, `src/App.jsx`.

Renders only when the selected workspace has an open review. Labelled with the open-comment count. Also fixes the two empty-state strings referencing the removed `livediff add`.

- [ ] Steps: implement → `pnpm build` succeeds → manual check → commit.

### Task 6: `livediff doctor`

**Files:** Create `server/doctor.js`, `test/doctor.test.js`; modify `server/cli.js`, `server/cli-help.js`.

Findings (each `{level: "ok"|"warn"|"error", title, detail, fix?}`): PATH resolution and shadowing (`which -a`), CLI vs running hub version, hub state (running / stopped / stale `hub.json` / stale `hub.lock`), non-toplevel or duplicate registry entries, leftover `.diff-review/` dirs, stale copied skill referencing removed commands.

- [ ] Steps: failing test (seed a stale `hub.json` and a legacy `.diff-review`, assert findings) → implement → pass → commit.

### Task 7: Packaging and cutover

**Files:** Modify `package.json`, `install.sh`.

`package.json`: drop `"private": true`, add `"files": ["server", "dist"]`, `"prepack": "vite build"`. `install.sh`: remove any prior `pnpm link --global`, `pnpm pack`, `pnpm add -g <tarball>`, verify `which -a livediff` resolves once, refresh the copied skill, then run `livediff doctor`. `--dev` keeps `pnpm link --global`.

- [ ] Steps: implement → run `install.sh --dev` → `livediff doctor` clean → commit.

### Task 8: Documentation rewrite

**Files:** Rewrite `DESIGN.md`, `README.md`, `skills/open-worktree-diff/SKILL.md`.

All three describe a hub started by hand and commands that no longer exist (`livediff add`, `livediff open`). Rewrite rather than patch; drop the v0.1→v0.3 changelog narrative.

- [ ] Steps: rewrite → verify every command shown exists in `cli-help.js` → commit.

---

## Self-Review Notes

| Spec section              | Task |
| ------------------------- | ---- |
| §5.1 in-process events    | 2    |
| §5.2 fs.watch safety net  | 2    |
| §5.3 client-gated polling | 1    |
| §5.4 auto-prune           | 1    |
| §6.3 `--wait`             | 4    |
| §7 review API + SSE       | 3    |
| §9 UI scope               | 5    |
| §10.1 packaging           | 7    |
| §10.3 doctor              | 6    |
| §11 documentation         | 8    |
