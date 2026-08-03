# Tooling modernization: TypeScript, oxlint, oxfmt, and a real test net

**Status:** design, approved for planning
**Date:** 2026-08-03
**Baseline:** livediff 0.6.0 — 8,464 lines, no types, no linter, no formatter, no CI

## Why

Every quality gate today is a human remembering to run `pnpm test`. There is no CI, no linter, no
formatter, and no static typing. The recent large-diff work made the cost concrete: the most
expensive mistake of that stretch — believing a stale bundle was the fast renderer — was invisible
to the 167-test suite because the suite never touches the browser, and every frontend bug after it
was found by hand through Playwright MCP at considerable expense.

TypeScript is the headline because it eliminates a class of failure statically. The test net is what
makes the migration safe, and the CI is what makes any of it matter unattended.

## What the toolchain is

| Concern | Tool | Version | Note |
| --- | --- | --- | --- |
| Types | TypeScript | 7.0.2 | Go-native compiler, GA 2026-07-08 |
| Lint | oxlint | 1.77.0 | Type-aware mode on |
| Format | oxfmt | 0.62.0 | Beta; 100% Prettier conformance |
| Unit + component tests | Vitest | 4.1.10 | Node project + browser project |
| E2E | @playwright/test | 1.62.1 | Chromium only |
| Hooks | lefthook | 2.1.10 | |

### Why oxlint rather than ESLint

TypeScript 7.0 ships **no stable programmatic API** — that lands in 7.1, expected around October
2026. `typescript-eslint@8.65.0` declares `typescript >=4.8.4 <6.1.0`, so it cannot run against the
current compiler at all. The official workaround is aliasing two compilers in one manifest
(`"typescript": "npm:@typescript/typescript6"` plus `"typescript-7": "npm:typescript@^7"`).

Oxlint avoids that entirely. Its type-aware engine (tsgolint, stable since 2026-07-22) tracks
TypeScript 7.0.2 directly and implements **59 of typescript-eslint's 61 type-aware rules** —
`no-floating-promises`, the `no-unsafe-*` family, `await-thenable` — at 12–18× ESLint's speed. One
compiler, no alias.

Biome was rejected: it has no type-aware rules at all, which is exactly the class of check this
project exists to gain.

**The known gap** is React Compiler-powered lint rules, which ship only in `eslint-plugin-react-hooks`
v6 and will not be ported. Oxlint has its own `rules-of-hooks` and `exhaustive-deps` ports with
documented behavioral drift from the official plugin.

**Decision on `exhaustive-deps`: keep it enabled.** Where a dependency genuinely should not be
tracked, disable that line — `FastDiff.jsx` already carries such a comment on the jump effect. If
the port proves *wrong* rather than merely noisy, the fallback is adding ESLint for
`eslint-plugin-react-hooks` on `src/` alone. Oxlint's config is independent, so that fallback costs
nothing already built. This is a reversible decision, not a fork.

### Why oxfmt rather than Prettier

oxfmt passes 100% of Prettier's JS/TS conformance tests, runs ~30× faster, and brings import
sorting, `package.json` sorting, and **built-in Tailwind class sorting** (replacing
`prettier-plugin-tailwindcss`). It is beta, not 1.0 — but a formatter's worst failure is ugly
output, not broken code, and because its output is byte-identical to Prettier's, **the exit cost is
zero**: switching back would produce an empty diff. Pin the exact version.

## Structure

```
shared/         types + constants   → imported by both halves
server/  *.ts                       → tsc emits dist-server/
src/     *.ts *.tsx                 → Vite emits dist/
test/    *.test.ts                  → Vitest, node project
test/browser/ *.test.tsx            → Vitest, browser project
e2e/     *.spec.ts                  → Playwright
```

### The `shared/` boundary is load-bearing, not cosmetic

The frontend already reaches across into the server today:

```
src/App.jsx:6                     import { RENDERER, RENDERERS, DIFF_REFETCH_DEBOUNCE_MS }
src/components/CommentThread.jsx:2  import { COMMENT_REPLY_STRIP_PX }
src/components/FastDiff.jsx:12      import { … }
```

all from `../server/constants.js`. This works only because both halves are raw JS in one tree. Once
the server compiles to `dist-server/`, there are two copies of `constants` and the shipped server
runs from a different one than Vite bundled — the same "which build is authoritative?" trap that
cost a full session on the stale tarball.

`shared/` owns those constants plus the API payload types, with a tsconfig path alias. Server
compiles it into `dist-server/`, Vite bundles it into `dist/`, one source of truth. This resolves
the latent packaging bug and the typed server/client contract in one move.

**Not a monorepo.** 8,464 lines and one deployable do not justify workspaces; they would add
resolution complexity for no isolation benefit.

### Packaging change

`bin` becomes `dist-server/cli.js`. `files` becomes `["dist-server", "dist"]`. `prepack` builds
both. Consumers still receive plain JavaScript.

**`engines.node` is `>=24`** (revised 2026-08-03; it was `>=18`). Node 24 is the active LTS — 26 is
Current and does not go LTS until October. livediff is installed locally by developers who already
run a modern Node, so the old floor bought nothing and cost real options: `Array#toSorted` and the
rest of the modern library surface were off the table for a compatibility target nobody was using.
`.node-version` pins 24 for contributors and CI.

`install.sh` packs a tarball and installs it globally, and `livediff doctor` verifies the result —
both must keep working unchanged from the user's side. This is the checkpoint with real packaging
risk and it gets verified by running the actual installer, not by inspection.

### Node floor

Vitest and Playwright both transform TypeScript themselves, so no build step is needed for tests.
Development and CI move to **Node 24 LTS** (local is currently 22.14). This is a contributor-side
floor only; `engines.node` for consumers is untouched because they receive compiled JS.

`erasableSyntaxOnly` is on the strict list regardless, which keeps the source within the subset
Node's own type stripping can handle should we ever want it.

## Strictness

On from day one, per an explicit decision to avoid a half-typed limbo:

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `allowUnreachableCode: false`,
`erasableSyntaxOnly`, `rewriteRelativeImportExtensions`.

Oxlint runs correctness, suspicious, and pedantic categories with type-aware rules enabled, loosened
only for `test/`.

Expect the real cost to land in `server/comments.js` and `server/registry.js`, where `JSON.parse`
currently produces untyped values that flow straight into logic. That is the migration's genuine
work and also most of its payoff.

## Sequencing

The test net comes **first**. The migration is what needs the tests, not the other way around —
neither Vitest nor Playwright cares whether the source is JS or TS. For a migration whose success
criterion is *"behavior identical, now type-checked,"* the tests are the executable specification of
"nothing changed"; writing them afterward would be checking the answer against itself.

New test code is written in TypeScript from birth. That costs one small setup step, avoids writing
the tests twice, and proves the TS toolchain on greenfield files before it meets 8,464 lines of
existing code.

### Plan 1 — Toolchain and net

0. TS + oxlint + oxfmt installed, configs written, scripts wired. Minimal CI running today's
   `pnpm test` and `pnpm build`. **No source changes.**
1. Vitest migration — 15 import lines, suite stays green
2. Vitest browser project + characterization tests for the frontend
3. Playwright e2e + fixture `globalSetup` + deterministic perf gates
4. CI extended to run all of it; lefthook pre-commit

### Plan 2 — Migration, under the net

5. `shared/` extraction + payload types
6. `server/` → TS + packaging change
7. `src/` → TS/TSX
8. `test/`, `e2e/`, `bench/` → TS
9. Format sweep — last, so the tree is reformatted once rather than twice

### Plan 3 — Dependency majors (droppable)

10. Vite 6→8, Tailwind 3→4

Doing this last means the e2e suite and perf gates are what make the upgrade safe.

## The Vitest migration is trivial

All 15 test files import nothing but `test` from `node:test` and assert with `node:assert/strict`.
**Zero mocks, zero `describe`, zero hooks, zero subtests.** The conversion is one import line per
file; every assertion is untouched, because `node:assert/strict` works under Vitest.

**One real risk:** `hub-startup`, `dormancy`, and `ensure-hub` bind real ports and spawn real git
repos. Vitest parallelizes by file. Those run in a node project with `fileParallelism: false` while
pure-logic and component tests stay parallel.

## Why component tests need a real browser

`useTextMetrics` probes real character widths from the DOM, and the entire analytic row-height model
is built on those measurements. Under jsdom the probes return garbage and the row-height math is
untestable. Vitest browser mode drives Playwright underneath while keeping one runner and one
config.

## Performance gates: only the deterministic half

Our metrics split cleanly, and conflating them is how perf suites become flake generators.

| Metric | Nature | Use |
| --- | --- | --- |
| DOM nodes at a scroll position | Deterministic | **Hard gate** |
| Rendered row-window size | Deterministic | **Hard gate** |
| Bundle size gzip | Deterministic, no browser | **Hard gate** |
| Document height for N rows | Deterministic (analytic) | **Hard gate** |
| JS heap after load | GC noise | Generous threshold |
| FCP, fps, worst frame | Machine-dependent | Recorded artifact, never a gate |

Standard guidance is ±10–15% tolerance on timing and consistent hardware, which a shared GitHub
runner categorically is not. Timing assertions in CI would buy flake, not safety.

The decisive point: **the regression actually suffered would have been caught by the node-count
gate.** 500,156 nodes against 1,203 is not a threshold question. Deterministic gates catch the real
failure mode with zero flake; the timing benchmark stays a local `pnpm bench:browser`.

Reference numbers from the 20,000-line fixture, production build:

| | classic | fast |
| --- | --- | --- |
| DOM nodes | 500,156 | 1,203 |
| JS on first load | 413 KB gzip | 71 KB gzip |
| Rows rendered at scroll 250,000 px | — | 62 |
| Document height, 20,002 rows | — | 400,066 px |

## E2E scenarios

Every scenario below is drawn from a bug actually hit, a decision actually recorded, or a behavior
explicitly requested. Citations are to `docs/superpowers/research/2026-08-03-handoff-fast-renderer.md`
(the handoff), `2026-08-02-large-diff-performance.md` (the perf research), or session history.

### Grounded in the record

1. **The served bundle is the fast renderer.** The single most expensive mistake of the last stretch
   was measuring a stale tarball whose `RENDERERS` did not contain `"fast"`. Assert a fast-renderer-
   specific marker is present in what the hub actually serves. *(handoff, "What the handoff got wrong")*
2. **DOM node count stays bounded.** 1,203 against classic's 500,156 on the 20k fixture. Hard gate.
3. **The rendered row window stays small** — ~62 rows at scroll 250,000 px.
4. **First-load JS stays under budget** — 71 KB gzip, from 413 KB.
5. **Document height is analytic and stable.** 400,066 px for 20,002 rows, and — the explicit design
   invariant — **expanding a comment overlays the rows below rather than reflowing them, so document
   height never changes.** *(handoff, "What shipped with it")*
6. **Scroll position survives a live update.** Verified end to end at scrollTop 12,000 in the 40-file
   fixture: after an edit, 12,040 with the same top row. *(session)*
7. **An edit to an already-modified file is noticed.** The `worktreeSignature` bug — status alone
   never changed, so livediff's core use case silently did not work. Unit-tested now; e2e proves the
   whole SSE path. *(session)*
8. **Clicking a file in the rail jumps to it on the right.** Explicitly requested. Pin the known
   inherent limit: the last file cannot reach the top because `scrollTop` maxes at
   `scrollHeight - clientHeight`. *(handoff, and user request)*
9. **A collapsed comment slot has a fixed height.** The stated rule: *whether* a thread has replies
   changes the slot; *how many* it has does not. Assert in both split and unified. *(handoff)*
10. **Long comment bodies truncate with an ellipsis.** Explicitly requested as a test case. *(user)*
11. **A reply badge is visible on a collapsed thread** without focusing it — this was missed entirely
    in review and called out twice. *(user)*
12. **The painted reply box opens the real one, focused.** The collapsed slot is the expanded card
    drawn and clipped, down to a non-functional reply input. *(user design)*
13. **Orphaned comments remain reachable.** The scenario as stated: leave a comment, change the code
    so its anchor line no longer exists, still be able to read whether Claude replied. Assert the
    rail count matches the drawer, and that the "No longer in the diff" section holds it. *(user)*
14. **Search reaches comment rows** and respects scope. *(handoff, model-level search)*
15. **Split and unified both render.** Recorded decision: both diff shapes must work. Unified
    produces more rows than split (30k vs 20k). *(perf research)*
16. **Grammar chunks load per visible language** — not fetched at start, fetched once that language
    scrolls into view. *(handoff, syntax highlighting)*
17. **The untested fixture shapes.** `minified-single-line` and `lockfile` were flagged as never
    exercised against the analytic row-height math. A single 20,000-character line is precisely where
    that math is stressed. *(session, explicitly logged as the known gap)*

### Harness rules, learned the expensive way

Not tests, but binding constraints on how tests are written:

- **Never write artifacts into the repo under test.** Screenshots landing in the working tree
  changed the diff mid-run, triggered refetches between assertions, and produced a bogus "comment
  anchored to the wrong file" result. *(handoff)*
- **Match status text case-insensitively.** DOM text is lowercase with `text-transform: uppercase`;
  an assertion on `MODIFIED` never matches. *(handoff)*
- **Measure the instrument before believing it about the subject.** Scenario 1 exists for this reason.

### Best-practice additions, not grounded in anything asked for

Listed separately and honestly: these are standard practice, but nothing in the record says they
have been cared about. Adopt or drop deliberately.

- **Empty and error states** — a clean worktree with no changes, a non-git directory, the hub not
  running. `livediff doctor` covers some of this from the CLI side; the UI paths are untested.
- **Concurrent clients** — doctor reports client counts and SSE fans out to all of them; nothing
  verifies two tabs stay consistent.
- **Dark mode** — `index.css` ships `prefers-color-scheme` token sets that no test exercises.
- **Keyboard and focus** — tab order through comment controls, Escape to collapse.
- **Accessibility smoke** (axe) — never mentioned in any note.
- **Visual regression snapshots** — plausible, but high maintenance, and they interact badly with
  the "never write into the repo under test" rule.

**Explicitly not recommended: cross-browser.** Standard practice would say run Firefox and WebKit.
The recorded decision is *"Safari does not matter, native Cmd+F is not required"*, which is what
unblocked virtualization in the first place. Chromium only.

## Fixtures

`bench/gen.mjs` already generates the shapes (`one-huge-file`, `many-small-files`,
`modified-not-added`, `minified-single-line`, `lockfile`), with `bench/many-modified.mjs` and
`bench/tracked.mjs` as single-purpose probes. Playwright `globalSetup` calls them, which converts
today's throwaway scratchpad fixtures into permanent infrastructure.

All generators delete the directory they target before writing, so they must be pointed at scratch
paths only — never at anything inside the repo.

## Verification per checkpoint

Each checkpoint commits green and is separately previewable.

- Every checkpoint: full test suite plus `pnpm lint`
- `pnpm typecheck` from checkpoint 0 onward — trivially green until TS files exist, which is the
  point: the gate predates the code it guards
- `pnpm format:check` joins CI at checkpoint 9, not before. The tree is deliberately unformatted
  until the sweep, so gating on it earlier would fail by construction
- Checkpoint 6 (server → TS): `./install.sh` followed by `livediff doctor` reporting all checks good
- Checkpoint 7 (src → TS): the Playwright suite against the built bundle
- Checkpoint 10 (dep majors): the full e2e suite plus a local `pnpm bench:browser` comparison

## What this does not include

- **Monorepo / workspaces** — rejected above.
- **knip, publint, arethetypeswrong** — reasonable for a published package, but livediff is
  installed from a local tarball and publishes nothing today. Revisit if it goes to npm.
- **Timing-based CI gates** — rejected above as flake generators.
- **Shiki** — the handoff notes virtualization makes a heavier highlighter affordable. That is a
  feature decision, not tooling.
