# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 8,500 lines to TypeScript at full strictness, behind the test net Plan 1 built.

**Architecture:** `shared/` is extracted first so both halves stop reaching across the server boundary. Then `server/` moves and starts compiling to `dist-server/`, then `src/`, then the tests. Type-aware linting turns on only once the tree is TypeScript, and the format sweep runs last so the tree is reformatted once.

**Tech Stack:** TypeScript 7.0.2, oxlint 1.77.0 + oxlint-tsgolint, oxfmt 0.62.0, Vitest 4.1.10, `@playwright/test` 1.62.1.

## Status — 2026-08-03

| Task                                  | State                                                   |
| ------------------------------------- | ------------------------------------------------------- |
| 1. Extract `shared/`                  | **done** — `2ad1d07`                                    |
| 2. `server/` to TypeScript            | not started                                             |
| 3. `src/` to TypeScript               | not started                                             |
| 4. Tests, e2e and bench to TypeScript | not started                                             |
| 5. Turn on type-aware linting         | blocked on 2–4 — nothing to be type-aware about yet     |
| 6. The format sweep                   | **done** — `4740819`, run early since it is independent |
| 7. Close the two known bugs           | **done** — `ddc5e30`                                    |

Tasks 6 and 7 were taken out of order deliberately: both are self-contained and neither depends on
the migration, so they bank value that a half-finished migration would otherwise strand.

Task 7's outcome is worth carrying forward: the minified fixture went from 11.3s to 0.28s, and both
`test.fail()` guards are now ordinary passing tests. **17 e2e, 0 expected-fail.**

A note for whoever picks up task 2: a working-tree revert of `2ad1d07` was found and discarded on
2026-08-03 with the user's agreement — `shared/` stays. If it reappears, that is a signal another
session disagrees about the boundary, not a merge artifact to wave through.

## Global Constraints

- Package manager is **pnpm**. **Never chain shell commands** — one per invocation.
- Conventional Commits: `type(scope): subject`, scope is `livediff`.
- `engines.node` is `>=24`; `.node-version` pins 24.
- **`pnpm verify` must pass before every commit.** It runs typecheck, lint, node tests, browser tests, and e2e.
- **Behavior must not change.** The 17 e2e and 6 browser tests are the specification of "nothing moved". A test that starts failing is a regression in the migration, not a test to adjust — the two `test.fail()` cases are the only expected failures, and they must stay failing until Task 7.
- Browser tests assert with `expect`, never `node:assert` — Vite externalizes node builtins in the browser.
- Browser component tests must `import "../../src/index.css"`, or Tailwind classes are no-ops and layout assertions prove nothing.
- React 19 commits asynchronously: await the mount, never query the DOM straight after `render()`.
- Relative imports keep their `.js` extension after renaming to `.ts` — `moduleResolution: nodenext` resolves `./git.js` to `git.ts` and emits `./git.js`. Do not rewrite them to `.ts`.
- Never write test artifacts into the repo.

---

## File Structure

| File                                       | Change                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `shared/constants.ts`                      | Extracted from `server/constants.js` — the values both halves need |
| `shared/types.ts`                          | `DiffFile`, `Diff`, `Comment`, `Reply`, `Workspace`, `Review`      |
| `server/*.ts`                              | Renamed, typed, compiled to `dist-server/`                         |
| `src/*.ts`, `src/**/*.tsx`                 | Renamed, typed                                                     |
| `test/*.test.ts`, `e2e/*.ts`, `bench/*.ts` | Renamed, typed                                                     |
| `package.json`                             | `bin` → `dist-server/cli.js`, `files` → `["dist-server","dist"]`   |
| `.oxlintrc.json`                           | `typeAware: true`                                                  |

---

### Task 1: Extract `shared/`

Three `src/` files import from `../server/constants.js` today. Once the server compiles to `dist-server/`, that import resolves to a different copy than the one the server runs, which is the "which build is authoritative?" trap that cost a full session on the stale tarball.

**Files:**

- Create: `shared/constants.ts`, `shared/types.ts`
- Modify: `server/constants.js`, `src/App.jsx`, `src/components/CommentThread.jsx`, `src/components/FastDiff.jsx`, `tsconfig.base.json`

- [ ] **Step 1: Find every cross-boundary import**

Run: `git grep -n "server/constants" -- src`
Expected: exactly three files — `src/App.jsx:6`, `src/components/CommentThread.jsx:2`, `src/components/FastDiff.jsx:12`.

- [ ] **Step 2: Create the shared constants**

Create `shared/constants.ts` holding only the values `src/` consumes. Read the three import statements from Step 1 and move exactly those bindings — `RENDERER`, `RENDERERS`, `DIFF_REFETCH_DEBOUNCE_MS`, `COMMENT_REPLY_STRIP_PX`, plus whatever `FastDiff.jsx:12` destructures. Type them as `const`:

```ts
export const RENDERERS = ["fast", "classic"] as const;
export type Renderer = (typeof RENDERERS)[number];
export const RENDERER: Renderer = "fast";
export const DIFF_REFETCH_DEBOUNCE_MS = 80;
```

Copy the existing explanatory comments across verbatim — they record why each number is what it is.

- [ ] **Step 3: Re-export from the server's constants**

In `server/constants.js`, replace the moved declarations with a re-export so the server keeps one import site:

```js
export {
  RENDERER,
  RENDERERS,
  DIFF_REFETCH_DEBOUNCE_MS,
  COMMENT_REPLY_STRIP_PX,
} from "../shared/constants.ts";
```

- [ ] **Step 4: Point the frontend at `shared/`**

In the three files from Step 1, change the import specifier to `../shared/constants.ts` (adjusting depth per file). Leave everything else alone.

- [ ] **Step 5: Define the payload types**

Create `shared/types.ts`. Derive the shapes from what the server already returns — `buildFile` in `server/git.js` and the comment record documented at `server/comments.js:28`:

```ts
export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffFile {
  path: string;
  oldPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  lang: string;
  patch: string;
}

export interface Diff {
  repo: string;
  branch: string;
  head: string | null;
  base: string | null;
  files: DiffFile[];
}

export interface Reply {
  author: string;
  body: string;
  at: string;
}

export interface Comment {
  id: string;
  file: string;
  side: "old" | "new";
  line: number;
  lineContent: string;
  body: string;
  status: "open" | "resolved";
  replies: Reply[];
  archivedAt?: string;
}

export interface Workspace {
  id: string;
  path: string;
  label: string;
  addedAt: string;
}
```

Verify each field against the source before trusting this block — `server/comments.js:28` is the authority for `Comment`, and `buildFile` for `DiffFile`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm verify`
Expected: all green, 17 e2e (2 expected-fail).

```bash
git add shared server/constants.js src
git commit -m "refactor(livediff): give both halves one source of truth in shared/"
```

---

### Task 2: `server/` to TypeScript, compiled to `dist-server/`

**Files:**

- Rename: all 17 files in `server/` from `.js` to `.ts`
- Modify: `package.json`, `tsconfig.node.json`, `install.sh`, `e2e/global-setup.ts`

- [ ] **Step 1: Rename**

```bash
git mv server/atomic.js server/atomic.ts
```

Repeat for all 17: `cli-help`, `cli`, `comment-format`, `comment-lifecycle`, `comments`, `constants`, `doctor`, `ensure-hub`, `git`, `hub-state`, `index`, `migrations`, `open-browser`, `registry`, `reviews`, `sse`. Leave every relative import's `.js` extension alone.

- [ ] **Step 2: Make the node config emit**

In `tsconfig.node.json`, drop `allowJs`/`checkJs` and emit the server:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "noEmit": false,
    "outDir": "dist-server",
    "rootDir": "."
  },
  "include": ["server/**/*", "shared/**/*"]
}
```

Tests, e2e and bench move to their own config in Task 4; until then they are simply not typechecked, which is why Task 4 exists.

- [ ] **Step 3: Typecheck and fix**

Run: `pnpm typecheck`
Expected: a large number of errors. Work through them file by file, smallest first (`atomic`, `sse`, `open-browser`, `comment-lifecycle`).

The two that will dominate, both real:

- `JSON.parse` returns `any` in `comments.ts`, `registry.ts`, `migrations.ts`. Type the parse site and validate what you assume, rather than casting: `const data = JSON.parse(raw) as unknown;` then narrow.
- `noUncheckedIndexedAccess` makes every array and record access possibly-undefined. Prefer a guard over `!`.

Do not add `any` to move on. Do not disable a strict flag.

- [ ] **Step 4: Point the package at the build**

In `package.json`:

```json
"bin": { "livediff": "dist-server/cli.js" },
"files": ["dist-server", "dist"],
"scripts": {
  "build": "tsc -b && vite build",
  "serve": "node dist-server/server/index.js",
  "prepack": "pnpm build"
}
```

Check the emitted path before writing it: with `rootDir: "."`, output lands at `dist-server/server/index.js`, not `dist-server/index.js`.

- [ ] **Step 5: Add the shebang check**

`server/cli.js` starts with a shebang. Confirm `tsc` preserved it in the emitted file:

Run: `head -1 dist-server/server/cli.js`
Expected: `#!/usr/bin/env node`. If absent, keep the shebang as the first line of `server/cli.ts` — TypeScript preserves a leading shebang.

- [ ] **Step 6: Update the e2e setup**

`e2e/global-setup.ts` spawns `server/index.js` and imports `server/registry.js`. Point both at `dist-server/server/`.

- [ ] **Step 7: Verify end to end**

Run: `pnpm verify`
Run: `./install.sh`
Run: `livediff doctor`
Expected: doctor reports "All good." across every check. This is the checkpoint with real packaging risk — inspection is not sufficient, run the installer.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(livediff): move the server to TypeScript"
```

---

### Task 3: `src/` to TypeScript

**Files:**

- Rename: 11 files in `src/` — `.jsx` → `.tsx`, `.js` → `.ts`
- Modify: `tsconfig.web.json`, `index.html`

- [ ] **Step 1: Rename**

```bash
git mv src/App.jsx src/App.tsx
```

Repeat for `main.jsx`, all eight files under `src/components/`, `src/hooks/useVirtualRows.js` → `.ts`, `src/diff-model.js` → `.ts`, `src/api.js` → `.ts`, `src/syntax.js` → `.ts`.

`index.html` references `/src/main.jsx` — update it to `/src/main.tsx` or the app will not boot.

- [ ] **Step 2: Drop allowJs from the web config**

In `tsconfig.web.json`, remove `"allowJs": true` and `"checkJs": false`.

- [ ] **Step 3: Type the component props**

Run: `pnpm typecheck`

Every component needs a props interface. Import the payload types from `shared/types.ts` rather than redeclaring them — `DiffFile` and `Comment` are already defined there.

`src/diff-model.ts` is the file to take most care with: it is the row model, it is the most-tested file in the tree, and its `Row` union is what the rest of the renderer keys off. Define it explicitly:

```ts
export type Row =
  | { kind: "file"; key: string; file: DiffFile }
  | { kind: "hunk"; key: string; text: string; file: DiffFile }
  | { kind: "spacer"; key: string; text: string }
  | { kind: "comment"; key: string; file: DiffFile; line: number; comments: Comment[] }
  | { kind: "line"; key: string /* … the split/unified line shape … */ };
```

Read the existing `ROW` constant and `buildRows` before writing this — the real shape is the authority, and the `line` variant differs between split and unified mode.

- [ ] **Step 4: Verify**

Run: `pnpm verify`
Expected: all green. The browser and e2e suites are what prove the renderer still behaves; if `diff-model` typing changed a height calculation, the slot tests catch it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(livediff): move the frontend to TypeScript"
```

---

### Task 4: Tests, e2e and bench to TypeScript

**Files:**

- Rename: 15 files in `test/`, `test/helpers.js`, 6 files in `bench/`
- Create: `tsconfig.test.json`
- Modify: `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: Rename**

`git mv` each `test/*.test.js` to `.test.ts`, `test/helpers.js` to `.ts`, and each `bench/*.mjs` to `.ts`. The browser tests are already `.tsx`.

- [ ] **Step 2: Add a config for them**

Create `tsconfig.test.json` — these are typechecked but never emitted:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true
  },
  "include": ["test/**/*", "e2e/**/*", "bench/**/*", "types/**/*"]
}
```

Add `{ "path": "./tsconfig.test.json" }` to the references in `tsconfig.json`.

- [ ] **Step 3: Update the Vitest include globs**

In `vitest.config.ts`, the node project's `include` is `["test/*.test.{js,ts}"]` — narrow it to `["test/*.test.ts"]` now that no `.js` tests remain.

- [ ] **Step 4: Verify**

Run: `pnpm verify`
Expected: 173 node tests, same count as before the rename. A changed count means a file stopped being collected.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(livediff): move the tests and benchmarks to TypeScript"
```

---

### Task 5: Turn on type-aware linting

The tree is now TypeScript, so the 59 type-aware rules can finally run — this is the payoff the whole migration was for.

**Files:**

- Modify: `.oxlintrc.json`, plus whatever it flags

- [ ] **Step 1: Enable it**

In `.oxlintrc.json` set `"typeAware": true`, and restore the rules downgraded in Plan 1 now that they can be judged properly:

```json
"unicorn/no-array-sort": "error",
"eslint/no-shadow": "error",
"promise/always-return": "error",
"promise/no-callback-in-promise": "error"
```

`Array#toSorted` is available — the Node floor is 24, which is why these were warnings rather than errors before.

- [ ] **Step 2: See what it finds**

Run: `pnpm exec oxlint`

Expect `typescript/no-floating-promises` to be the interesting one. `src/App.tsx:106` already carries a `promise/always-return` warning on the `loadDiff` chain, and the SSE subscription fires promises without awaiting them.

- [ ] **Step 3: Fix, do not silence**

Work through each finding. A floating promise in a `useEffect` is a real defect class — an error in a refetch currently disappears. Prefer `void promise` only where the fire-and-forget is deliberate and add a comment saying why.

- [ ] **Step 4: Verify and commit**

Run: `pnpm verify`

```bash
git add -A
git commit -m "build(livediff): enable type-aware linting"
```

---

### Task 6: The format sweep

Last, so the tree is reformatted once rather than twice.

- [ ] **Step 1: Sweep**

Run: `pnpm format`

- [ ] **Step 2: Confirm it is whitespace only**

Run: `git diff --stat`
Run: `git diff -w --stat`

The second must be empty or near-empty. A non-whitespace change means oxfmt rewrote code, which is worth reading before committing.

- [ ] **Step 3: Verify**

Run: `pnpm verify`
Expected: all green. Formatting must not change behavior; if a test fails here, that is the finding.

- [ ] **Step 4: Add the gates**

In `.github/workflows/ci.yml`, add `- run: pnpm format:check` after `pnpm lint`.

In `lefthook.yml`, add the formatter now that the tree is clean:

```yaml
format:
  glob: "*.{js,ts,tsx,json,css,md}"
  run: pnpm exec oxfmt {staged_files}
  stage_fixed: true
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "style(livediff): format the tree with oxfmt"
```

---

### Task 7: Close the two known bugs

Both already have failing tests written, so this is verification-complete before a line is changed: flip `test.fail()` off and make them pass.

**Files:**

- Modify: `src/App.tsx`, `src/syntax.ts`, `shared/constants.ts`, `e2e/navigation.spec.ts`

- [ ] **Step 1: Fix the deep link**

Per `docs/superpowers/research/2026-08-03-deep-link-selection.md`: the guard effect clears the URL preselect while the workspace list is still empty. Distinguish "not loaded yet" from "loaded and empty" with a `loaded` flag set by the first successful `fetchWorkspaces`, and gate the clearing branch on it.

- [ ] **Step 2: Un-fail its test**

Remove `test.fail()` from the `?ws= deep link` test in `e2e/navigation.spec.ts`.

Run: `pnpm e2e --grep "deep link"`
Expected: PASS.

- [ ] **Step 3: Fix the minified line**

Per `docs/superpowers/research/2026-08-03-minified-line-node-count.md`: nothing bounds the tokens in one row, so a 20,000-character line renders 40,058 nodes. Add a length cutoff in `shared/constants.ts`:

```ts
// Above this, a line renders as plain text instead of tokens. Nobody reads syntax colour on a
// minified bundle, and one line's token count is otherwise unbounded — 40,058 nodes for one line.
export const MAX_HIGHLIGHT_LINE_CHARS = 2000;
```

Apply it in `src/syntax.ts` where tokenization happens: above the threshold, return a single plain-text token.

- [ ] **Step 4: Un-fail its test**

Remove `test.fail()` from the node-budget test.

Run: `pnpm e2e --grep "minified"`
Expected: both PASS, and the load time drops from ~11s.

- [ ] **Step 5: Update the research notes**

Add a `## Resolved` section to both documents with the date and the measured result, in the style of `2026-08-02-large-diff-performance.md` — those files exist to record what was learned, so the outcome belongs in them.

- [ ] **Step 6: Verify and commit**

Run: `pnpm verify`
Expected: **17 passed, 0 expected-fail.**

```bash
git add -A
git commit -m "fix(livediff): cap highlighting per line and keep ?ws= deep links"
```

---

## Definition of done

- No `.js` or `.jsx` remains under `server/`, `src/`, `test/`, or `bench/`
- `pnpm verify` passes with **zero** expected failures
- `./install.sh` followed by `livediff doctor` reports all checks good
- `pnpm lint` runs with `typeAware: true` and exits 0
- No `any`, no `@ts-expect-error`, and no disabled strict flag was added to get there
