# The fast renderer was never broken — the bundle was stale

**Resolved 2026-08-03.** The virtualized renderer is now the default. This file kept its name because
the mistake in it is worth keeping.

## What the handoff got wrong

It reported the fast renderer rendering all 500,061 rows and listed three hypotheses. The first —
"`fast` is false and `classic` is rendering" — was correct, and it was the only one worth testing,
because the measurement had never touched the new code at all.

The hub on port 4180 serves a packed tarball, not the working tree. That build predated the fast
renderer, so `RENDERERS` did not contain `"fast"`, `?renderer=fast` fell through to the default, and
every number in the table described the classic renderer. One grep for a string unique to the new
code settled it in seconds:

```
grep -c "Regular expression" ~/Library/pnpm/global/5/node_modules/livediff/dist/assets/index-*.js
0
```

**The lesson is about the harness, not the renderer.** Two other measurement artifacts cost time the
same way: screenshots written into the repo changed the diff under test and triggered refetches
between assertions, and an assertion matched `MODIFIED` against DOM text that is lowercase with
`text-transform: uppercase`. A third "bug" — a file that would not scroll to the top — was
`scrollHeight - clientHeight`: the last file in a diff cannot reach the top because the document
ends. Measure the instrument before believing what it says about the subject.

## Where it landed

Same 20,000-line fixture, production build, served by the installed hub:

|                        | classic     | fast                          |
| ---------------------- | ----------- | ----------------------------- |
| First contentful paint | 5,536 ms    | **104 ms**                    |
| DOM nodes              | 500,156     | **1,203**                     |
| JS heap                | 597 MB      | **73 MB**                     |
| Scroll                 | 14 fps      | **96 fps**, worst frame 21 ms |
| JS on first load       | 413 KB gzip | **71 KB gzip**                |

`RENDERER` in `server/constants.js` is `"fast"`; `?renderer=classic` overrides it per tab.

## What shipped with it

- **Syntax highlighting**, per visible row. highlight.js core plus one chunk per language, fetched
  when that language scrolls into view. Tokens rather than HTML, so a search match splits a token
  instead of replacing the line.
- **Comment threads inline**, at the line they annotate. A collapsed thread is the expanded one
  drawn and clipped, down to a painted reply box that opens the real one focused. Its height is
  computed from the text and capped, so expanding overlays the rows below instead of reflowing them
  and the document height never changes. The latest reply shows on a strip: whether a thread has
  replies changes the slot, how many it has does not.
- **A comment drawer** on file headers and on the rail's count, holding every comment on a file or
  in the worktree, split into the ones the diff can place and the ones it cannot. A comment outlives
  the line it was written against; before this there was no way to read one after its anchor closed.
- **Jump to a file** from the rail, and the classic renderer behind `React.lazy`.

## Still open

- The diff refetch is undebounced and uncancelled. Every worktree change refetches and rebuilds
  everything. `useScrollAnchor` preserves the reader's place but does not reduce the work.
- `buildRows` re-flattens the whole model when the comments array changes identity, which a poll can
  do without any comment changing.
- The comment card's chrome height is a measured constant (`COMMENT_ROW_CHROME_PX`). The reply strip
  pins its own height to its constant so the two cannot drift; the rest of the card does not.

## Fixtures

- `?ws=f361a41e` — the 20k-line fixture at `scratchpad/tracked`, with three comments left on it as a
  demo. Regenerate with `bench/tracked.mjs <path> 20000`.
- `?ws=c6ef1b93` — this repo.
- `pnpm vite preview --port 4173` serves the production bundle and proxies `/api` to the hub, which
  is how to measure without reinstalling.
