# Handoff: tooling modernization, Plan 1 done, Plan 2 written

**Date:** 2026-08-03 · **Branch:** `main` at `1b92710` · **Tree:** clean

## Where things stand

Plan 1 (toolchain + test net) is **complete and merged**. Plan 2 (the TypeScript migration) is
**written but not started**. No code has been migrated yet — the tree is still JavaScript.

Read in this order:

1. `docs/superpowers/specs/2026-08-03-livediff-tooling-modernization-design.md` — the design and why
   each tool was chosen
2. `docs/superpowers/plans/2026-08-03-livediff-toolchain-and-test-net.md` — Plan 1, all 8 tasks done
3. `docs/superpowers/plans/2026-08-03-livediff-typescript-migration.md` — Plan 2, 7 tasks, **next**

## The gate

```
pnpm verify     # typecheck + lint + test + test:browser + e2e, ~55s
```

Current: **173 node tests, 6 browser tests, 17 e2e** (15 pass + 2 expected `test.fail()`).
`pnpm lint` exits 0 with 19 warnings. `pnpm format:check` **fails on 56 files** — deliberate, the
sweep is Plan 2 Task 6.

lefthook runs oxlint on staged files and `tsc -b` on staged TypeScript at commit time.

## Toolchain, and why

| Concern          | Tool                          | Note                                          |
| ---------------- | ----------------------------- | --------------------------------------------- |
| Types            | TypeScript 7.0.2              | Go-native compiler                            |
| Lint             | oxlint 1.77 + oxlint-tsgolint | `typeAware` is **false** until the tree is TS |
| Format           | oxfmt 0.62                    | 100% Prettier conformance; not run yet        |
| Unit + component | Vitest 4.1.10                 | two projects: `node`, `browser`               |
| E2E              | @playwright/test 1.62.1       | Chromium only, by recorded decision           |

**oxlint rather than ESLint** because TypeScript 7 ships no stable programmatic API until 7.1
(~October), so `typescript-eslint@8.65` (peer `typescript <6.1.0`) cannot run on it at all. Oxlint's
tsgolint tracks 7.0.2 directly and covers 59 of 61 type-aware rules. The fallback, if oxlint's
`exhaustive-deps` port proves wrong rather than merely noisy, is adding ESLint for
`eslint-plugin-react-hooks` on `src/` alone — nothing built so far would be redone.

## Constraints learned the hard way

These are in Plan 2's Global Constraints; they cost real time to discover.

- **Relative imports keep `.js` after renaming to `.ts`.** `moduleResolution: nodenext` resolves
  `./git.js` → `git.ts` and emits `./git.js`. Do not rewrite them.
- **Browser tests assert with `expect`, never `node:assert`** — Vite externalizes node builtins in
  the browser. The node project keeps `node:assert/strict` unchanged.
- **Browser component tests must `import "../../src/index.css"`.** Without it every Tailwind class is
  a no-op, the card sizes to its content, and layout assertions pass while proving nothing.
- **React 19 commits asynchronously.** Await the mount; never query the DOM right after `render()`.
- **Never write artifacts into the repo under test.** Screenshots landing in the tree change the diff
  mid-run and trigger refetches between assertions. `__screenshots__/`, `.vitest-attachments/`,
  `test-results/`, `playwright-report/` are all gitignored — two PNGs still made it into a commit
  before this was caught.
- **Match status text case-insensitively** — DOM text is lowercase with `text-transform: uppercase`.
- **E2E must redirect `XDG_*` but not `HOME`.** The hub must not touch real livediff state, but
  Playwright resolves its browser cache from `HOME`; moving it makes every worker fail to find
  Chromium. Only the hub child gets the temp `HOME`. See `e2e/global-setup.ts`.
- **`?ws=` deep links are broken** (below), so every e2e test uses `focusUrl()` from `e2e/harness.ts`.

## Two open bugs, both with failing tests already written

Plan 2 Task 7 closes both. They are verification-complete: flip `test.fail()` off and make them pass.

- `docs/superpowers/research/2026-08-03-minified-line-node-count.md` — a single 20,000-character line
  renders **40,058 DOM nodes** and takes 11s, against 1,203 nodes and 0.4s for the whole 20,000-_line_
  fixture. Virtualization bounds rows; nothing bounds tokens within a row. The analytic height model
  is **not** at fault and that half is a passing test. Fix: per-line length cutoff on highlighting.
- `docs/superpowers/research/2026-08-03-deep-link-selection.md` — `?ws=<id>` shows the first workspace
  instead of the one named. Two effects race on mount; the guard clears the URL preselect while the
  workspace list is still empty. Fix: a `loaded` flag distinguishing "not fetched yet" from "empty".

## Also landed this session

`feat(livediff): compare the working tree against any branch` (`505026f`, `fd0dfcc`). The `base` ref
used to mean `base...HEAD` — two commits, so uncommitted work was invisible — and ran the old
per-file spawn loop with every status hardcoded to `"modified"`. It now means _the working tree
versus where this branch diverged from `<ref>`_, reusing the fast whole-tree path. Merge base rather
than branch tip, so commits landing on `main` after you branched do not appear inverted as deletions.
Adds `/api/refs` and a datalist picker.

## Known rough edges, deliberately not addressed

- **19 lint warnings** — 4 in `server/git.js`, `promise/always-return` at `src/App.jsx:106`, four
  `no-shadow`, the `no-array-sort` set. Real work; needs source changes, which Plan 1 forbade.
- **The tree is unformatted.** Plan 2 Task 6, last, so it is reformatted once.
- **`engines.node` is `>=24`** and `.node-version` pins 24, but this machine runs **22.14**, so
  `./install.sh` refuses. Upgrade before Plan 2 Task 2, which changes what the tarball contains.
- **CI is dormant** — there is no git remote, so `.github/workflows/ci.yml` has never run.
- **Comment anchoring is numeric** (`path:side:line` in `src/diff-model.js`), so changing the compared
  ref can orphan comments into the drawer. Note that `lineContent` is already stored and already
  surfaced to agents by `server/comment-format.js`, so an agent can re-find the line; only the UI
  drops it. A content fallback in `commentsForRow` would close it.
- The hub was last run from the working tree (`node server/index.js`) rather than installed, because
  of the Node floor. That background process has since stopped.

## Fixtures

`bench/gen.mjs <path> <shape>` where shape is `one-huge-file`, `many-small-files`,
`modified-not-added`, `minified-single-line`, `lockfile`. Also `bench/tracked.mjs <path> 20000` and
`bench/many-modified.mjs <path> 500 40`. **All delete their target directory first — point them at
`os.tmpdir()` only.** `e2e/global-setup.ts` generates four of them automatically.
