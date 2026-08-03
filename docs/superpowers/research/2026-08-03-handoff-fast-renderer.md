# Handoff — fast renderer is not virtualizing

**State:** HEAD is `1953ed4`, working tree clean, 152/152 tests pass, v0.6.0 installed.
**Blocker:** the `fast` renderer renders every row. It is committed but not working.

## The finding

Measured in headless Chromium against the 20k-line fixture (`?ws=f361a41e&renderer=fast`):

| | Measured | Expected |
| --- | --- | --- |
| DOM nodes | **500,061** | ~400 |
| Time to diff visible | 2,912 ms | <200 ms |
| Total blocking time | 4,938 ms | near zero |
| Long tasks | 2 × ~2.5 s | none |
| JS heap | 595 MB | <100 MB |
| Scroll FPS | 14 | 60 |
| Scroll height | 895,716 px | — |

The user reports ~11 s to load and laggy scrolling, worse than the headless numbers.

**The model is not the problem.** Driven directly in Node against the same real diff it produces
20,002 rows, a 400,066 px document in 4 ms, 62 rows in the visible window, and window selection in
0.081 ms. 22 headless tests pass. The defect is in the React layer, `src/components/FastDiff.jsx`
or `src/hooks/useVirtualRows.js`.

### What has been ruled out

- **Server.** `/api/diff` returns in ~173 ms; download 5 ms, `JSON.parse` 3 ms, `buildRows` 18 ms.
- **Refetch loop.** `worktreeSignature` is stable — 1 distinct value across 5 polls.
- **The row model.** Verified against the live hub and the fixture.

### Leading hypotheses, untested

1. **`fast` is false and `classic` is rendering.** 500,061 nodes is the right order of magnitude
   for the classic renderer on this diff (research estimated a ≥140,000 floor *excluding* syntax
   spans). Confirm by checking which component is mounted before assuming the virtualizer is broken.
2. **`visibleRange` is receiving a bad `viewport` or `offsets`,** so `range` spans everything.
3. **`useTextMetrics` observes `surfaceRef`,** which is the 895,716 px surface whose height it
   indirectly controls. It should observe the scroll container instead. The `setMetrics` guard
   should prevent a loop, but it is measuring the wrong element regardless.

Hypothesis 1 is cheapest to test and would explain every number.

## Next steps

1. Reinstall Playwright (`pnpm add -D playwright`, `pnpm exec playwright install chromium`) or use
   the Playwright MCP server, now connected.
2. Rebuild the browser benchmark. It measured: FCP, time-to-diff-visible, long tasks, total
   blocking time, DOM node count, JS heap, `Performance.getMetrics` script/layout/style durations,
   and scroll FPS, with `Emulation.setCPUThrottlingRate` for slower-machine simulation.
3. Determine which renderer is actually mounted, then fix the real cause.

## Known deficiencies in `fast`, independent of the above

- **No syntax highlighting.** Once virtualization works only ~60 rows need highlighting, which
  makes Shiki affordable — see `2026-08-03-related-projects.md`.
- **Comment threads render in a bottom panel, not inline** at their line. Inline threads are the
  variable-height case `rowHeight`'s `measured` override exists for.
- **The 1.3 MB bundle ships to both renderers.** `@git-diff-view/react` + lowlight + every
  highlight.js grammar loads even under `?renderer=fast`, which needs none of it.
  `React.lazy` on `FileDiff` fixes this, but requires `DiffModeEnum` to be re-declared locally
  (`{ SplitGitHub: 1, SplitGitLab: 2, Split: 3, Unified: 4 }`, verified against 0.1.7) — importing
  it from the package defeats the split. An attempt was reverted as incomplete; it also needs a
  `Suspense` boundary around the lazy `FileDiff`.
- **The diff refetch is still undebounced and uncancelled.** Every worktree change refetches and
  rebuilds everything; `useScrollAnchor` preserves scroll position but does not reduce the work.

## Fixtures

- `?ws=f361a41e` — 20k-line tracked diff at
  `/private/tmp/claude-501/-Users-shanesteuteville-shane-dev-livediff/26e85cd3-8023-496a-8130-4f27296bd115/scratchpad/tracked`
  (scratchpad; regenerate with `bench/tracked.mjs <path> 20000` if cleared).
- `?ws=c6ef1b93` — this repo, 4 files, a realistic small diff.
- Compare renderers on one diff with `&renderer=classic` versus `&renderer=fast`.
- `RENDERER` in `server/constants.js` sets the default; it remains `"classic"`, so nothing user-facing
  is affected by the defect.
