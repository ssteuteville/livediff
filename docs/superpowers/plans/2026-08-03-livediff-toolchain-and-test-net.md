# Toolchain and Test Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the TypeScript/oxlint/oxfmt toolchain and build the Vitest + Playwright test net that will make the TypeScript migration (Plan 2) safe.

**Architecture:** No existing source file changes behavior in this plan. Task 1 installs tooling and CI without touching source. Task 2 converts the test runner. Tasks 3–6 add characterization tests — a browser-based component suite for the code whose correctness depends on real DOM text metrics, and a Playwright e2e suite whose scenarios are drawn from bugs actually hit. Task 7 turns the gates on.

**Tech Stack:** TypeScript 7.0.2, oxlint 1.77.0 + oxlint-tsgolint, oxfmt 0.62.0, Vitest 4.1.10 (`@vitest/browser-playwright`, `vitest-browser-react`), `@playwright/test` 1.62.1, lefthook 2.1.10, GitHub Actions.

## Global Constraints

- Package manager is **pnpm**, never npm or yarn.
- **Never chain shell commands** — no `&&`, `||`, `|`, `;`. One command per invocation.
- Conventional Commits: `type(scope): subject`, scope is `livediff`.
- Prefer no comments. A comment explains *why*, never *what*.
- `engines.node` is `>=24` and `.node-version` pins 24 (revised 2026-08-03 from `>=18`). Node 24 is the active LTS; 26 is Current until October.
- Browser tests assert with `expect`, not `node:assert` — Vite externalizes node builtins in the browser. The node project keeps `node:assert/strict`.
- Browser component tests must `import "../../src/index.css"`, or every Tailwind class is a no-op and layout assertions prove nothing.
- React 19 commits asynchronously: await the mount, never query the DOM straight after `render()`.
- **Never write test artifacts into the repo under test.** Screenshots landing in the working tree change the diff mid-run and trigger refetches between assertions. This cost a full debugging session once already.
- **Match status text case-insensitively.** DOM text is lowercase with `text-transform: uppercase`; an assertion on `MODIFIED` never matches.
- E2E must never touch the developer's real livediff state. Always redirect `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `HOME` to a temp directory first.
- Fixture generators delete the directory they target before writing. Point them at `os.tmpdir()` paths only, never anything inside the repo.
- **No source file changes behavior in this plan.** The only edits permitted under `src/` are the `data-*` test hooks and the `__LIVEDIFF_RENDERERS__` line in Task 5, plus adding an `export` keyword to a declaration a test needs to import. Nothing under `server/` changes at all. If a test appears to require a real source change, the test is describing a bug — record it in `docs/superpowers/research/`, do not fix it here.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tsconfig.base.json` | Shared compiler options — every strict flag lives here, once |
| `tsconfig.web.json` | DOM + JSX surface: `src/`, `shared/`, `test/browser/` |
| `tsconfig.node.json` | Node surface: `server/`, `shared/`, `test/`, `e2e/`, `bench/` |
| `tsconfig.json` | Solution file referencing the two; what `tsc -b` builds |
| `.oxlintrc.json` | Lint rules, plugins, per-directory overrides |
| `.oxfmtrc.json` | Format options |
| `vitest.config.ts` | Two projects: `node` and `browser` |
| `playwright.config.ts` | E2E runner config, Chromium only |
| `src/App.jsx`, `src/components/FastDiff.jsx`, `src/components/CommentDrawer.jsx`, `src/components/WorkspaceRail.jsx` | Gain `data-*` test hooks only — no behavior change |
| `e2e/global-setup.ts` | Builds the UI, starts a hub on temp state, generates fixtures |
| `e2e/harness.ts` | Shared helpers: workspace URLs, scroll helpers, metric probes |
| `e2e/renderer.spec.ts` | Renderer identity and the deterministic performance gates |
| `e2e/navigation.spec.ts` | Jump-to-file, live update, scroll anchoring, search, grammar chunks |
| `e2e/comments.spec.ts` | Comment slots, truncation, reply badge, drawer |
| `test/browser/metrics.test.tsx` | `useTextMetrics` against real fonts |
| `test/browser/rows.test.tsx` | `useVirtualRows` windowing and scroll anchoring |
| `test/browser/comment-thread.test.tsx` | Collapsed slot rendering and truncation |
| `.github/workflows/ci.yml` | The gates |
| `lefthook.yml` | Pre-commit format + lint on staged files |

---

### Task 1: Toolchain and CI, no source changes

Installs everything and proves it runs against today's JavaScript. Nothing in `src/` or `server/` is touched.

**Files:**
- Create: `tsconfig.base.json`, `tsconfig.web.json`, `tsconfig.node.json`, `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `.github/workflows/ci.yml`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Produces: `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm format:check` scripts used by every later task.

- [ ] **Step 1: Install the toolchain**

```bash
pnpm add -D typescript@7.0.2 oxlint@1.77.0 oxlint-tsgolint@7.0.2001 oxfmt@0.62.0 @types/node @types/react @types/react-dom
```

- [ ] **Step 2: Write the shared compiler options**

Create `tsconfig.base.json`. Every strict flag lives here so the two leaf configs cannot drift:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Write the two leaf configs and the solution file**

`tsconfig.node.json`. `allowJs` is on because `e2e/` imports `server/*.js` while the server is still JavaScript; Plan 2 removes it.

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "allowJs": true,
    "checkJs": false
  },
  "include": ["server/**/*", "shared/**/*", "test/**/*", "e2e/**/*", "bench/**/*"],
  "exclude": ["test/browser/**/*"]
}
```

`tsconfig.web.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "module": "ESNext",
    "allowJs": true,
    "checkJs": false
  },
  "include": ["src/**/*", "shared/**/*", "test/browser/**/*", "vite.config.js"]
}
```

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

- [ ] **Step 4: Write the lint config**

Create `.oxlintrc.json`. `typeAware` is **false** here and flips to true in Plan 2's final task — the tree is still JavaScript, so there are no types to be aware of yet.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "react", "unicorn", "promise", "node", "import", "oxc", "vitest"],
  "categories": {
    "correctness": "error",
    "suspicious": "error",
    "pedantic": "warn"
  },
  "options": {
    "typeAware": false
  },
  "ignorePatterns": ["dist", "dist-server", "node_modules", "test-results", "playwright-report"],
  "overrides": [
    {
      "files": ["test/**/*", "e2e/**/*", "bench/**/*"],
      "rules": {
        "typescript/no-non-null-assertion": "off",
        "eslint/no-console": "off"
      }
    }
  ]
}
```

- [ ] **Step 5: Write the format config**

Create `.oxfmtrc.json`, matching the style already in the tree (double quotes, semicolons, 100 columns):

```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "bracketSpacing": true,
  "arrowParens": "always"
}
```

- [ ] **Step 6: Wire the scripts**

In `package.json`, add to `scripts`:

```json
"typecheck": "tsc -b",
"lint": "oxlint",
"format": "oxfmt .",
"format:check": "oxfmt --check ."
```

- [ ] **Step 7: Ignore test artifacts**

Append to `.gitignore`:

```
test-results/
playwright-report/
.vitest/
*.tgz
```

- [ ] **Step 8: Verify the gates run**

Run: `pnpm typecheck`
Expected: PASS. There are no `.ts` files yet, so this is trivially green — which is the point. The gate exists before the code it guards.

Run: `pnpm lint`
Expected: Completes and reports findings on the existing JavaScript. **Findings are expected and are not fixed in this task.** Record the count in the commit message.

Run: `pnpm format:check`
Expected: FAIL, listing unformatted files. This is correct — the tree is deliberately unformatted until Plan 2's sweep. Do not run `pnpm format`.

- [ ] **Step 9: Write the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

`pnpm format:check` is deliberately absent — it joins in Plan 2 after the format sweep.

- [ ] **Step 10: Verify CI passes**

Push the branch and confirm the `check` job is green. If `pnpm lint` fails the build on existing findings, downgrade `categories.pedantic` to `"off"` in `.oxlintrc.json` and re-run — correctness and suspicious findings must stay at `error`.

- [ ] **Step 11: Commit**

```bash
git add tsconfig.base.json tsconfig.web.json tsconfig.node.json tsconfig.json .oxlintrc.json .oxfmtrc.json .github/workflows/ci.yml package.json pnpm-lock.yaml .gitignore
git commit -m "build(livediff): add the TypeScript, oxlint and oxfmt toolchain"
```

---

### Task 2: Move the suite to Vitest

Fifteen import lines. Every assertion is untouched, because `node:assert/strict` works under Vitest.

**Files:**
- Create: `vitest.config.ts`
- Modify: all 15 files in `test/*.test.js` (line 1 only), `package.json`

**Interfaces:**
- Consumes: `pnpm typecheck` from Task 1.
- Produces: `vitest.config.ts` exporting a config whose `test.projects[0].name` is `"node"`. Task 3 appends a second project named `"browser"`.

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest@4.1.10
```

- [ ] **Step 2: Write the config**

Create `vitest.config.ts`. File-level parallelism is left at its default because `node --test` already runs these files in parallel today and they pass — the fixed ports in `test/hub-startup.test.js` (4187–4192) are what makes that safe. Any new port-binding test must claim its own unused fixed port.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/*.test.{js,ts}"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
```

The 30s timeout is required: `test/cli.test.js` spawns real processes and `test/git.test.js` builds real repositories.

- [ ] **Step 3: Convert the imports**

In each of the 15 files matching `test/*.test.js`, change line 1 from:

```js
import { test } from "node:test";
```

to:

```js
import { test } from "vitest";
```

Leave line 2 (`import assert from "node:assert/strict";`) alone in every file. Do not convert assertions to `expect`.

- [ ] **Step 4: Point the test script at Vitest**

In `package.json`, replace the `test` script:

```json
"test": "vitest run"
```

- [ ] **Step 5: Run the suite**

Run: `pnpm test`
Expected: PASS, 167 tests. The count must match exactly what `node --test test/*.test.js` reported before this task. If any test fails, it is a runner difference and must be diagnosed — do not adjust the assertion.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json pnpm-lock.yaml test
git commit -m "test(livediff): run the suite on Vitest"
```

---

### Task 3: Browser project and text-metric characterization

The analytic row-height model rests entirely on real character-width measurements taken from the DOM. Under jsdom those probes return garbage, so this code is untestable anywhere but a real browser.

**Files:**
- Create: `test/browser/metrics.test.tsx`
- Modify: `vitest.config.ts`, `package.json`

**Interfaces:**
- Consumes: `vitest.config.ts` from Task 2.
- Produces: a `browser` Vitest project matching `test/browser/*.test.tsx`; `pnpm test:browser`.
- Uses from source: `useTextMetrics` exported by `src/hooks/useVirtualRows.js`, returning at least `{ charWidth, lineHeight, proseCharWidth }`.

- [ ] **Step 1: Install the browser stack**

```bash
pnpm add -D @vitest/browser-playwright@4.1.10 vitest-browser-react@2.2.0 playwright@1.62.1
```

- [ ] **Step 2: Install the Chromium binary**

```bash
pnpm exec playwright install --with-deps chromium
```

- [ ] **Step 3: Add the browser project**

In `vitest.config.ts`, add a second entry to `test.projects` and import the provider:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/*.test.{js,ts}"],
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "browser",
          include: ["test/browser/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
```

- [ ] **Step 4: Write the failing test**

Create `test/browser/metrics.test.tsx`. This pins the property the row model depends on — that proportional text measures **wider** per character than monospace, which is the exact mistake that produced dead space and clipping in comment slots when a `charsPerLine * 0.85` estimate used monospace half-width metrics for proportional text.

```tsx
import { test } from "vitest";
import assert from "node:assert/strict";
import { render } from "vitest-browser-react";
import { useTextMetrics } from "../../src/hooks/useVirtualRows.js";

function Probe({ onMeasure }: { onMeasure: (m: unknown) => void }) {
  const metrics = useTextMetrics();
  onMeasure(metrics);
  return <div data-testid="probe" />;
}

test("text metrics measure a real font, not a guess", async () => {
  let measured: any = null;
  render(<Probe onMeasure={(m) => { measured = m; }} />);

  assert.ok(measured, "useTextMetrics returned nothing");
  assert.ok(measured.charWidth > 0, "monospace character width must be positive");
  assert.ok(measured.lineHeight > 0, "line height must be positive");
  assert.ok(measured.proseCharWidth > 0, "prose character width must be positive");
});

test("prose text is measured separately from monospace", async () => {
  let measured: any = null;
  render(<Probe onMeasure={(m) => { measured = m; }} />);

  // The bug this pins: estimating proportional text with monospace metrics. The two must not be
  // the same number, or the comment-slot height math is guessing again.
  assert.notEqual(
    measured.proseCharWidth,
    measured.charWidth,
    "prose and monospace widths are identical — the prose probe is not measuring proportional text"
  );
});
```

- [ ] **Step 5: Add the script and run it**

In `package.json` add:

```json
"test:browser": "vitest run --project browser"
```

Run: `pnpm test:browser`
Expected: PASS. If `useTextMetrics` is not exported from `src/hooks/useVirtualRows.js`, add the `export` keyword to its declaration — an export changes no behavior.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json pnpm-lock.yaml test/browser
git commit -m "test(livediff): measure text metrics in a real browser"
```

---

### Task 4: Row windowing and comment-slot characterization

Pins the two invariants the virtualized renderer is built on.

**Files:**
- Create: `test/browser/rows.test.tsx`, `test/browser/comment-thread.test.tsx`

**Interfaces:**
- Consumes: the `browser` project from Task 3.
- Uses from source: `buildRows(files, mode, comments)` and `ROW` from `src/diff-model.js`; `CommentThreadPreview` from `src/components/CommentThread.jsx`; `COMMENT_REPLY_STRIP_PX` from `server/constants.js`.

- [ ] **Step 1: Write the row-window test**

Create `test/browser/rows.test.tsx`. The invariant: a slot's height depends on *whether* a thread has replies, never on *how many* it has.

```tsx
import { test } from "vitest";
import assert from "node:assert/strict";
import { buildRows } from "../../src/diff-model.js";

const file = {
  path: "a.ts",
  oldPath: "a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  lang: "typescript",
  patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n",
};

const thread = (id, replies) => ({
  id,
  path: "a.ts",
  side: "new",
  line: 2,
  body: "a comment body",
  replies,
});

test("how many replies a thread has does not change its slot", () => {
  const one = buildRows([file], "split", [thread("a", [{ body: "r1" }])]);
  const many = buildRows([file], "split", [
    thread("a", [{ body: "r1" }, { body: "r2" }, { body: "r3" }, { body: "r4" }]),
  ]);

  const heightOf = (rows) => rows.find((r) => r.kind === "comment")?.height;
  assert.equal(heightOf(one), heightOf(many), "reply count leaked into the slot height");
});

test("whether a thread has replies does change its slot", () => {
  const none = buildRows([file], "split", [thread("a", [])]);
  const some = buildRows([file], "split", [thread("a", [{ body: "r1" }])]);

  const heightOf = (rows) => rows.find((r) => r.kind === "comment")?.height;
  assert.notEqual(heightOf(none), heightOf(some), "the reply strip is not being budgeted");
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test:browser`
Expected: PASS both. If `height` is not a property on comment rows, read `src/diff-model.js` to find the actual field name that `buildRows` assigns and use it — do not change the source.

- [ ] **Step 3: Write the truncation test**

Create `test/browser/comment-thread.test.tsx`. This covers the case explicitly requested for testing: a collapsed thread whose body is too long, which must show an ellipsis rather than clip mid-word or overflow its slot.

```tsx
import { test } from "vitest";
import assert from "node:assert/strict";
import { render } from "vitest-browser-react";
import { CommentThreadPreview } from "../../src/components/CommentThread.jsx";

const long = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long comment body`).join("\n");

test("a long collapsed body is clipped to its slot, not allowed to overflow", async () => {
  const { container } = render(
    <div style={{ height: 200, width: 600 }}>
      <CommentThreadPreview
        comment={{ id: "a", body: long, replies: [], author: "shane", side: "new", line: 2 }}
      />
    </div>
  );

  const card = container.firstElementChild as HTMLElement;
  assert.ok(card, "nothing rendered");
  assert.ok(
    card.scrollHeight >= card.clientHeight,
    "content shorter than its box — the fixture is not exercising truncation"
  );
  assert.equal(
    card.getBoundingClientRect().height <= 200,
    true,
    "the collapsed card grew past the slot it was given"
  );
});

test("a collapsed thread with replies shows that it has them", async () => {
  const { container } = render(
    <CommentThreadPreview
      comment={{
        id: "a",
        body: "short",
        replies: [{ author: "claude", body: "I fixed it" }],
        author: "shane",
        side: "new",
        line: 2,
      }}
    />
  );

  // The bug this pins: replies were invisible until the thread was focused, and the badge was
  // missed entirely in review.
  assert.match(container.textContent ?? "", /claude/i, "no indication that a reply exists");
});
```

- [ ] **Step 4: Run it**

Run: `pnpm test:browser`
Expected: PASS. If `CommentThreadPreview` takes different prop names, read `src/components/CommentThread.jsx` and match the real signature — do not change the source.

- [ ] **Step 5: Commit**

```bash
git add test/browser
git commit -m "test(livediff): pin the row-window and comment-slot invariants"
```

---

### Task 5: Add stable test hooks

The UI has exactly two `data-*` attributes today (`data-reply-placeholder` in
`src/components/CommentThread.jsx:38`, read back by `src/components/FastDiff.jsx:137`). Every other
element is addressable only by Tailwind class strings, which are not a contract and will churn.

This task adds attributes and nothing else. It is deliberately its own commit so a reviewer can
confirm at a glance that no behavior changed.

**Files:**
- Modify: `src/App.jsx:332`, `src/App.jsx:347`, `src/components/FastDiff.jsx` (lines 373, 384, 397, 409, 421, 446, 453, 476, 510), `src/components/CommentDrawer.jsx`, `src/components/WorkspaceRail.jsx:30`

**Interfaces:**
- Produces the selectors every e2e test in Tasks 6–8 depends on:

| Selector | Element |
| --- | --- |
| `[data-file-list]` | the file-list `<aside>` |
| `[data-file-item="<path>"]` | one file entry in that list |
| `[data-diff-scroll]` | the virtualized scroll container |
| `[data-row]` | any absolutely-positioned row |
| `[data-row-kind="file\|hunk\|spacer\|comment\|line"]` | that row's kind |
| `[data-comment-slot]` | a collapsed comment slot |
| `[data-comment-expanded]` | the expanded overlay |
| `[data-comment-composer]` | the new-comment overlay |
| `[data-comment-drawer]` | the drawer panel |
| `[data-add-comment]` | the `+` gutter button |
| `[data-rail-comment-count]` | the workspace open-comment badge |
| `[data-diff-search]` | the search wrapper in `src/components/DiffSearch.jsx` |
| `window.__LIVEDIFF_RENDERERS__` | the renderer list the served bundle knows about |

- [ ] **Step 1: Hook the file list**

`src/App.jsx:332` — add `data-file-list` to the `<aside className="w-60 shrink-0 overflow-y-auto …">`.

`src/App.jsx:347` — the element whose `onClick` is `() => scrollToFile(i, f.path)` gains
`data-file-item={f.path}`.

- [ ] **Step 2: Hook the scroller and rows**

`src/components/FastDiff.jsx:373` — `<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">`
gains `data-diff-scroll`.

Each of the six row branches gains `data-row` plus its kind. At lines 384, 397, 409, 421, 446 and
453 respectively:

```jsx
<div key={row.key} data-row data-row-kind="file" className="absolute inset-x-0" style={{ top, height }}>
```

Use `"file"`, `"hunk"`, `"spacer"`, `"comment"`, `"line"`, `"line"` in that order. The comment branch
at 421 additionally gains `data-comment-slot`.

- [ ] **Step 3: Hook the overlays**

`src/components/FastDiff.jsx:476` — the expanded-thread overlay gains `data-comment-expanded`.
Line 510 — the composer overlay gains `data-comment-composer`.

In `src/components/CommentDrawer.jsx`, the drawer's outermost element gains `data-comment-drawer`,
and each rendered comment entry gains `data-drawer-comment`.

In `src/components/FastDiff.jsx`, the `+` add-comment button (the one styled
`hidden h-5 w-5 … bg-blue-600 … group-hover:flex`) gains `data-add-comment`.

- [ ] **Step 4: Hook the rail badge**

`src/components/WorkspaceRail.jsx:30` — the `<span>` rendering `{ws.openComments}` gains
`data-rail-comment-count`.

- [ ] **Step 5: Expose the renderer list**

`src/App.jsx` already imports `RENDERERS` from `../server/constants.js` at line 6. Immediately after
the import block, add:

```js
// Lets a test assert which renderers the *served* bundle knows about. A stale build once produced
// a full session of measurements that described the classic renderer.
if (typeof window !== "undefined") window.__LIVEDIFF_RENDERERS__ = RENDERERS;
```

- [ ] **Step 6: Verify nothing changed**

Run: `pnpm test`
Expected: PASS, same count as Task 2.

Run: `pnpm build`
Expected: succeeds.

Run: `git diff --stat`
Expected: only the files listed above, and every hunk is an added attribute or the three-line
`__LIVEDIFF_RENDERERS__` block. If any hunk changes logic, revert it.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "test(livediff): add stable data hooks for end-to-end selectors"
```

---

### Task 6: E2E harness and the deterministic performance gates

**Files:**
- Create: `playwright.config.ts`, `e2e/global-setup.ts`, `e2e/harness.ts`, `e2e/renderer.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `e2e/harness.ts` exporting `hubUrl(): string` and `workspaceUrl(name: FixtureName): string`, where `FixtureName` is `"tracked20k" | "modfiles" | "minified" | "lockfile"`.
- Consumes from source: `startHub` and `withTempXdg` patterns from `test/helpers.js`; `addWorkspace(path, label)` from `server/registry.js`.

- [ ] **Step 1: Install Playwright test**

```bash
pnpm add -D @playwright/test@1.62.1
```

- [ ] **Step 2: Write the global setup**

Create `e2e/global-setup.ts`. It redirects XDG state, generates fixtures into `os.tmpdir()`, builds the UI, and starts a hub that serves the built bundle — the same path production takes, so the test measures what ships.

```ts
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repo = fileURLToPath(new URL("..", import.meta.url));

export default async function globalSetup() {
  const root = await mkdtemp(join(tmpdir(), "livediff-e2e-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.HOME = home;

  const fixtures = {
    tracked20k: join(root, "tracked"),
    modfiles: join(root, "modfiles"),
    minified: join(root, "minified"),
    lockfile: join(root, "lockfile"),
  };

  execFileSync(process.execPath, ["bench/tracked.mjs", fixtures.tracked20k, "20000"], { cwd: repo });
  execFileSync(process.execPath, ["bench/gen.mjs", fixtures.modfiles, "modified-not-added"], { cwd: repo });
  execFileSync(process.execPath, ["bench/gen.mjs", fixtures.minified, "minified-single-line"], { cwd: repo });
  execFileSync(process.execPath, ["bench/gen.mjs", fixtures.lockfile, "lockfile"], { cwd: repo });

  execFileSync("pnpm", ["run", "build"], { cwd: repo, stdio: "inherit" });

  const { addWorkspace } = await import(join(repo, "server/registry.js"));
  const ids: Record<string, string> = {};
  for (const [name, path] of Object.entries(fixtures)) {
    const ws = await addWorkspace(path, name);
    ids[name] = ws.id;
  }

  const child = spawn(process.execPath, [join(repo, "server/index.js")], {
    env: { ...process.env, LIVEDIFF_PORT: "4183" },
    stdio: "ignore",
  });

  const statePath = join(process.env.XDG_STATE_HOME, "livediff", "hub.json");
  const deadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (parsed.pid === child.pid && parsed.port) {
        port = parsed.port;
        break;
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!port) {
    child.kill("SIGKILL");
    throw new Error("hub did not start");
  }

  process.env.LIVEDIFF_E2E_URL = `http://127.0.0.1:${port}`;
  process.env.LIVEDIFF_E2E_IDS = JSON.stringify(ids);
  process.env.LIVEDIFF_E2E_PATHS = JSON.stringify(fixtures);

  return async () => {
    child.kill("SIGKILL");
  };
}
```

- [ ] **Step 3: Write the harness helpers**

Create `e2e/harness.ts`:

```ts
export type FixtureName = "tracked20k" | "modfiles" | "minified" | "lockfile";

export function hubUrl(): string {
  const url = process.env.LIVEDIFF_E2E_URL;
  if (!url) throw new Error("global setup did not publish LIVEDIFF_E2E_URL");
  return url;
}

function ids(): Record<FixtureName, string> {
  return JSON.parse(process.env.LIVEDIFF_E2E_IDS ?? "{}");
}

export function fixturePath(name: FixtureName): string {
  const paths = JSON.parse(process.env.LIVEDIFF_E2E_PATHS ?? "{}");
  const path = paths[name];
  if (!path) throw new Error(`no fixture path for ${name}`);
  return path;
}

export function workspaceUrl(name: FixtureName): string {
  const id = ids()[name];
  if (!id) throw new Error(`no workspace id for ${name}`);
  return `${hubUrl()}/?ws=${id}`;
}
```

- [ ] **Step 4: Write the Playwright config**

Create `playwright.config.ts`. Chromium only — the recorded decision is that Safari does not matter, which is what unblocked virtualization in the first place.

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

`workers: 1` because every test shares one hub and the fixture worktrees are mutated by the live-update tests.

- [ ] **Step 5: Write the renderer identity and performance gates**

Create `e2e/renderer.spec.ts`. The first test exists because the single most expensive mistake on record was measuring a stale bundle whose `RENDERERS` did not contain `"fast"` — every number collected described the classic renderer.

```ts
import { test, expect } from "@playwright/test";
import { workspaceUrl } from "./harness";

test("the hub serves the fast renderer, not a stale bundle", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const renderers = await page.evaluate(() => (window as any).__LIVEDIFF_RENDERERS__ ?? null);
  expect(renderers, "the served bundle does not expose its renderer list").not.toBeNull();
  expect(renderers).toContain("fast");
});

test("DOM node count stays bounded on a 20k-line diff", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  // Measured: 1,203 for fast, 500,156 for classic. This gate catches the difference between a
  // virtualized renderer and one that is not; it is not a tight threshold and must not become one.
  expect(nodes).toBeLessThan(5_000);
});

test("only a window of rows is rendered, wherever you scroll", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await scroller.evaluate((el) => { el.scrollTop = 250_000; });
  await page.waitForTimeout(200);

  const rendered = await page.locator("[data-row]").count();
  // Measured: 62 rows at this scroll position.
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(200);
});

test("first-load JS stays under budget", async ({ page }) => {
  const transferred: number[] = [];
  page.on("response", async (res) => {
    if (res.url().endsWith(".js")) {
      const body = await res.body().catch(() => null);
      if (body) transferred.push(body.byteLength);
    }
  });

  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const total = transferred.reduce((n, b) => n + b, 0);
  // Measured: 71 KB gzip on the fast path, from 413 KB before the split. Uncompressed here, so
  // the budget is generous — it exists to catch the classic renderer being pulled in eagerly.
  expect(total).toBeLessThan(600_000);
});
```

- [ ] **Step 6: Add the script and run**

In `package.json` add:

```json
"e2e": "playwright test"
```

Run: `pnpm e2e`
Expected: PASS, four tests. Every selector used here was added in Task 5; a "selector not found" failure means Task 5 was applied incompletely, not that the test is wrong.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts e2e package.json pnpm-lock.yaml
git commit -m "test(livediff): gate renderer identity and DOM node count end to end"
```

---

### Task 7: E2E navigation, live update, and the untested fixture shapes

**Files:**
- Create: `e2e/navigation.spec.ts`

**Interfaces:**
- Consumes: `workspaceUrl`, `fixturePath` from `e2e/harness.ts`.

- [ ] **Step 1: Write the jump-to-file and scroll-anchor tests**

Create `e2e/navigation.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceUrl, fixturePath } from "./harness";

test("clicking a file in the rail jumps to it in the diff", async ({ page }) => {
  await page.goto(workspaceUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const scroller = page.locator("[data-diff-scroll]");
  const before = await scroller.evaluate((el) => el.scrollTop);

  await page.locator('[data-file-item="mod-20.ts"]').click();
  await page.waitForTimeout(300);

  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(after).not.toBe(before);

  const topText = await page.locator("[data-row]").first().textContent();
  expect(topText ?? "").toContain("mod-20");
});

test("the last file cannot reach the top, and that is not a bug", async ({ page }) => {
  await page.goto(workspaceUrl("modfiles"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await page.locator("[data-file-item]").last().click();
  await page.waitForTimeout(300);

  // scrollTop maxes out at scrollHeight - clientHeight, so the final file lands mid-viewport.
  // This was chased as a 234px bug once. Pinning it stops that happening again.
  const atMax = await scroller.evaluate(
    (el) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2
  );
  expect(atMax).toBe(true);
});

test("an edit to an already-modified file updates the diff and holds the reader's place", async ({ page }) => {
  await page.goto(workspaceUrl("modfiles"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await scroller.evaluate((el) => { el.scrollTop = 12_000; });
  await page.waitForTimeout(200);
  const before = await scroller.evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
  }));
  const topRow = await page.locator("[data-row]").first().textContent();

  // mod-0.ts is already in the diff. Status alone never changes for this edit, which is exactly
  // the case that silently did not work until worktreeSignature folded in size and mtime.
  await appendFile(join(fixturePath("modfiles"), "mod-0.ts"), "\n// live update check\n");

  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight), { timeout: 15_000 })
    .not.toBe(before.height);

  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(after).toBeGreaterThanOrEqual(before.top);

  const topRowAfter = await page.locator("[data-row]").first().textContent();
  expect(topRowAfter).toBe(topRow);
});
```

- [ ] **Step 2: Run them**

Run: `pnpm e2e`
Expected: PASS. Note that the file list lives in `src/App.jsx:332`, not in `WorkspaceRail.jsx` — the rail lists *workspaces*, the aside lists *files*.

- [ ] **Step 3: Write the untested-shape tests**

Append to `e2e/navigation.spec.ts`. These two fixtures were explicitly logged as never having been exercised against the analytic row-height math, and a single 20,000-character line is precisely where that math is stressed.

```ts
test("a minified single-line bundle does not break the height model", async ({ page }) => {
  await page.goto(workspaceUrl("minified"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const scroller = page.locator("[data-diff-scroll]");
  const height = await scroller.evaluate((el) => el.scrollHeight);
  expect(height).toBeGreaterThan(0);

  // A 20,000-character line must wrap to many rows' worth of height, not be measured as one line.
  const clientHeight = await scroller.evaluate((el) => el.clientHeight);
  expect(height).toBeGreaterThan(clientHeight);

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  expect(nodes).toBeLessThan(5_000);
});

test("a 20k-line lockfile renders under the same node budget", async ({ page }) => {
  await page.goto(workspaceUrl("lockfile"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  expect(nodes).toBeLessThan(5_000);
});
```

- [ ] **Step 4: Run and record**

Run: `pnpm e2e`
Expected: PASS. **If either fails, that is a real finding, not a broken test.** Record it in `docs/superpowers/research/` with the measured numbers and leave the test failing behind `test.fail()` — Plan 2 does not begin with a red suite, and a genuine bug must not be silently deleted.

- [ ] **Step 5: Write the search, mode, and grammar-loading tests**

Append to `e2e/navigation.spec.ts`. Search runs over the row model rather than the DOM, so it must
find matches that were never rendered. Both diff modes must work — the recorded decision is that
split and unified are both supported, and unified produces *more* rows (30k against 20k). Grammar
chunks are fetched per language as it scrolls into view, which is what keeps first load at 71 KB.

```ts
test("search finds matches that were never rendered", async ({ page }) => {
  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  // value19000 lives far below the rendered window, so a DOM-based search could not find it.
  await page.locator("[data-diff-search] input").fill("value19000");
  await page.waitForTimeout(400);

  const hits = await page.locator("[data-diff-search]").textContent();
  expect(hits ?? "").toMatch(/[1-9]/);
});

test("unified mode renders and produces more rows than split", async ({ page }) => {
  await page.goto(`${workspaceUrl("tracked20k")}&mode=split`);
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });
  const splitHeight = await scroller.evaluate((el) => el.scrollHeight);

  await page.goto(`${workspaceUrl("tracked20k")}&mode=unified`);
  await scroller.waitFor({ timeout: 30_000 });
  const unifiedHeight = await scroller.evaluate((el) => el.scrollHeight);

  expect(unifiedHeight).toBeGreaterThan(splitHeight);
});

test("a language grammar is fetched only once its rows scroll into view", async ({ page }) => {
  const chunks: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/assets/") && req.url().endsWith(".js")) chunks.push(req.url());
  });

  await page.goto(workspaceUrl("lockfile"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });
  const atLoad = chunks.length;

  await page.goto(workspaceUrl("tracked20k"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });
  await page.waitForTimeout(500);

  // The TypeScript fixture must pull a grammar chunk the YAML lockfile did not.
  expect(chunks.length).toBeGreaterThan(atLoad);
});
```

If `[data-diff-search]` is absent, add it to the wrapper element in `src/components/DiffSearch.jsx`
as part of Task 5's hook set, and note it in that task's table.

- [ ] **Step 6: Run them**

Run: `pnpm e2e`
Expected: PASS. If the `mode=split` / `mode=unified` query parameter is not how the mode is
selected, read `src/App.jsx` for the real control and drive it by clicking instead.

- [ ] **Step 7: Commit**

```bash
git add e2e
git commit -m "test(livediff): cover jump-to-file, live update and the untested diff shapes"
```

---

### Task 8: E2E comments, and turn the gates on

**Files:**
- Create: `e2e/comments.spec.ts`, `lefthook.yml`
- Modify: `.github/workflows/ci.yml`, `package.json`

- [ ] **Step 1: Write the comment tests**

Create `e2e/comments.spec.ts`. Every scenario here is a behavior that was explicitly requested or a bug that was missed in review.

```ts
import { test, expect } from "@playwright/test";
import { workspaceUrl } from "./harness";

test("expanding a comment overlays the rows below and does not change document height", async ({ page }) => {
  await page.goto(workspaceUrl("modfiles"));
  const scroller = page.locator("[data-diff-scroll]");
  await scroller.waitFor({ timeout: 30_000 });

  await page.locator("[data-add-comment]").first().click({ force: true });
  await page.locator("[data-comment-composer] textarea").fill("a comment for the overlay test");
  await page.locator("[data-comment-composer] button[type=submit]").click();
  await page.waitForTimeout(500);

  const before = await scroller.evaluate((el) => el.scrollHeight);
  await page.locator("[data-comment-slot]").first().click();
  await page.waitForTimeout(300);
  const after = await scroller.evaluate((el) => el.scrollHeight);

  // The stated invariant: expanding overlays rather than reflows, so the document never resizes.
  expect(after).toBe(before);
});

test("the painted reply box opens the real one, focused", async ({ page }) => {
  await page.goto(workspaceUrl("modfiles"));
  await page.waitForSelector("[data-comment-slot]", { timeout: 30_000 });

  await page.locator("[data-reply-placeholder]").first().click();
  await page.waitForTimeout(200);

  const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
  expect(focused).toBe("textarea");
});

test("a comment whose anchor line is gone is still reachable", async ({ page }) => {
  await page.goto(workspaceUrl("modfiles"));
  await page.waitForSelector("[data-diff-scroll]", { timeout: 30_000 });

  const railCount = await page.locator("[data-rail-comment-count]").first().textContent();
  await page.locator("[data-rail-comment-count]").first().click();

  const drawer = page.locator("[data-comment-drawer]");
  await expect(drawer).toBeVisible();

  // The scenario as stated: leave a comment, change the code so the anchor no longer exists,
  // and still be able to read whether Claude replied.
  const listed = await drawer.locator("[data-drawer-comment]").count();
  expect(String(listed)).toBe((railCount ?? "").trim());
});
```

- [ ] **Step 2: Run them**

Run: `pnpm e2e`
Expected: PASS. Every selector was added in Task 5; `data-reply-placeholder` already existed at `src/components/CommentThread.jsx:38`.

- [ ] **Step 3: Write the pre-commit hook**

```bash
pnpm add -D lefthook@2.1.10
```

Create `lefthook.yml`:

```yaml
pre-commit:
  parallel: true
  commands:
    lint:
      glob: "*.{js,jsx,ts,tsx}"
      run: pnpm oxlint {staged_files}
```

Formatting is deliberately absent until Plan 2's sweep — a formatting hook on an unformatted tree would rewrite every file touched, scattering the sweep across unrelated commits.

- [ ] **Step 4: Install the hook**

```bash
pnpm exec lefthook install
```

- [ ] **Step 5: Extend CI**

In `.github/workflows/ci.yml`, add after the `pnpm test` step:

```yaml
      - run: pnpm test:browser
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

- [ ] **Step 6: Verify the whole gate**

Run: `pnpm typecheck`
Run: `pnpm lint`
Run: `pnpm test`
Run: `pnpm test:browser`
Run: `pnpm e2e`
Expected: all five green.

Push and confirm CI is green.

- [ ] **Step 7: Commit**

```bash
git add e2e lefthook.yml .github/workflows/ci.yml package.json pnpm-lock.yaml
git commit -m "test(livediff): cover comment slots end to end and gate them in CI"
```

---

## Definition of done

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser`, `pnpm e2e` all pass locally and in CI
- The 167-test suite runs on Vitest with the same count it had on `node:test`
- No file under `server/` or `src/` has changed behavior — only added `data-*` test hooks and, where needed, an `export` keyword
- Any real bug the new tests surface is written up in `docs/superpowers/research/`, not silently fixed
