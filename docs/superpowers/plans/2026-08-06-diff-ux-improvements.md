# Diff UX improvements — plan

**Date:** 2026-08-06
**Baseline:** LiveDiff 0.8.2
**Status:** implemented, uncommitted

Four changes to the diff view, all in the web UI. Nothing touches the hub, the CLI, or the
comment model.

## What was asked

1. The current file's header stays pinned at the top until the next file arrives.
2. The file whose header is pinned is highlighted in the left panel.
3. The left panel shows folder structure instead of a flat list.
4. An end-of-diff area so the last file doesn't look cut off.

Plus: virtualization must stay intact, and tests to prove the work.

## What other tools do

**Sticky headers.** GitHub has had sticky file headers in pull requests since 2019 and was
still fixing consistency bugs in them as recently as February 2026, which is a fair signal
that the naive version is easy to get subtly wrong. GitHub virtualizes only the largest
pull requests, so for most diffs they can lean on plain CSS `position: sticky` per file
section. That option is not open here — every diff is virtualized, and the file's rows do
not exist in the DOM as a containing block to stick within.

The virtualized answer, which TanStack Virtual documents as its sticky-header pattern, is
to render the pinned header as a separate element positioned from the scroll offset, and to
compute which header is current from the offset table rather than from the DOM. The detail
that makes it feel right is the **push-off**: as the next file's real header rises into the
viewport, the pinned one is displaced upward by the overlap instead of cross-fading or
snapping. That is one line of arithmetic once the offsets are available.

**File trees.** Both VS Code's explorer ("compact folders") and the VS Code Git Graph
extension's commit details view compress runs of single-child directories into one row, so
`src/components/ui/` is a single entry rather than three nested ones. Without it a monorepo
diff spends most of the sidebar's width on indentation. VS Code also ships a setting to turn
it off, which suggests the behavior is not universally loved, but for a diff sidebar — where
the tree is a navigation aid rather than a place to create files — the compressed form is
clearly right.

**End of list.** Nothing exotic here; a terminal affordance is standard UI practice and the
ask is specific enough not to need precedent.

## Design

### Where the work goes

| File                          | Change                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| `src/file-tree.ts`            | **new** — pure tree construction from paths, with compaction     |
| `src/components/FileTree.tsx` | **new** — recursive rendering, collapse state, highlight         |
| `src/diff-model.ts`           | add `fileRowAt()` — pure "which file governs this scroll offset" |
| `src/hooks/useVirtualRows.ts` | expose `scrollTop`                                               |
| `src/components/FastDiff.tsx` | pinned header, end cap, active-file callback                     |
| `src/App.tsx`                 | swap the flat aside for `FileTree`, hold `activeFile`            |
| `bench/gen.ts`                | add a `nested` shape so e2e has directories to render            |

### 1. Pinned file header

`fileRowAt(rows, offsets, scrollTop)` returns the index of the last `ROW.FILE` at or before
the offset, plus the offset of the next one. Pure, so it is unit-testable without a browser.

The pinned header renders as one absolutely-positioned element inside the existing surface:

```
top = max(fileOffset, min(scrollTop, nextBoundary - headerHeight))
```

`nextBoundary` is the next file's offset, or `totalHeight` when this is the last file — which
is what makes the header push off into the end cap rather than hovering over it.

The real `ROW.FILE` row for the governing file is skipped in the row loop, because the pinned
element is already drawing it. When not scrolled past, the formula puts the pinned element
exactly where the real row would have been, so there is no visual difference and no double
render.

Cost: one extra DOM node, and no new re-render — `scrollTop` already drives a state update
per animation frame.

### 2. Active file in the left panel

`FastDiff` reports the governing file upward through `onActiveFile`. It fires only when the
path actually changes, guarded by a ref — without that it would re-render `App` on every
scroll frame, which is exactly the kind of thing that makes a virtualized view feel heavy.

The classic renderer has no virtualization and no offset table, so it does not report an
active file. The tree still renders and still navigates there; only the highlight is absent.
Worth revisiting, not worth blocking on — `fast` is the default renderer.

### 3. Folder tree

`buildFileTree(paths)` produces `TreeNode[]`, directories before files, alphabetical within
each. Runs of single-child directories collapse into one node whose name is the joined path,
matching VS Code. Each directory carries aggregates — file count and open-comment count — so a
collapsed folder can still show that something inside it needs attention.

Rendering is a recursive component with a `Set<string>` of collapsed paths in local state.
Everything stays keyed by full path, so collapse state survives a diff refetch.

### 4. End cap

A sibling element after the virtualized surface, inside the scroll container. It does not
participate in the offset table, so no row math changes — the scroll container simply grows by
its height. States the file and line totals, and offers "back to top".

## Testing

- `test/file-tree.test.ts` — tree construction: nesting, ordering, compaction of single-child
  chains, aggregate counts, and the flat-paths case that must produce no directories at all.
- `test/diff-model.test.ts` — `fileRowAt` at boundaries: before the first file, exactly on a
  header, mid-file, past the last file.
- `e2e/diff-ux.spec.ts` — the four behaviors against a real hub: header pinned mid-file,
  push-off at the boundary, sidebar highlight tracking the scroll, tree structure from the
  nested fixture, end cap reachable, and a node-count budget proving virtualization survived.

The node-count assertion matters most. Every other test could pass while the pinned header
quietly rendered every file's header at once.

The tree is covered by unit tests plus e2e rather than a browser component test: the
interesting logic is all in `buildFileTree`, which needs no DOM, and the rendering is better
proved against a real diff than against a fixture prop.

## Outcome

All four behaviors implemented and verified. `pnpm verify` is clean: 229 node tests, 6 browser
tests, 28 e2e tests, typecheck, lint, and format.

One assumption in a test was wrong on the first run and worth recording: `modfiles` produces
files roughly 20,000px tall, so scrolling by a "large" absolute pixel count landed inside the
_first_ file and made a working highlight look broken. The test now scrolls by a fraction of
`scrollHeight` instead.
