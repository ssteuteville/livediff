# Filter-only Lenses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent hand off a review with named, file-level filters over the diff — each optionally marking line ranges — so a 3,000-line change becomes four passes a human can actually do.

**Architecture:** A lens set is a per-workspace JSON file that the hub owns and the agent replaces wholesale at handoff. The CLI stays a pure HTTP client. The browser filters `diff.files` the same way the existing `?dir=` subdirectory filter already does, and renders highlights as a tint on the rows a range covers. Every read-modify-write against a workspace store moves inside a new per-key async mutex, which also closes a latent lost-update race in comments.

**Tech Stack:** TypeScript (Node ≥24, ESM, `.js` import specifiers), zero runtime dependencies in `server/`, React 19 + Tailwind in `src/`, vitest for unit/integration, Playwright for e2e.

**Spec:** [`../specs/2026-08-07-filter-lenses-design.md`](../specs/2026-08-07-filter-lenses-design.md)

## Global Constraints

- **Zero runtime dependencies in `server/`.** No new packages. `path.matchesGlob` is off-limits (experimental).
- **The CLI never touches the filesystem for hub state.** It is argument parsing plus `fetch`. It must not import `lenses.js` or `registry.js`.
- **The hub is the single writer** to every store under `$XDG_CONFIG_HOME/livediff/`.
- **All JSON writes go through `writeJsonAtomic`** from `server/atomic.js`.
- **Imports use `.js` specifiers** even for `.ts` sources (`import { x } from "./lenses.js"`). Imports from `shared/` use `.ts` (`from "../shared/types.ts"`) — match the file you are editing.
- **Comments explain _why_, never _what_.** JSDoc on exported functions and non-obvious types; nothing on internal helpers whose name says it.
- **No nested ternaries in `src/`** (per the repo's React rules) — extract a named helper with `if`/`return`.
- **Commit format:** `type(livediff): subject`, imperative, lowercase after the colon.
- **Lens name pattern:** `^[a-z0-9][a-z0-9-]{0,39}$` — copy verbatim.
- **Lens store version:** `1`.
- **Highlights are new-side line numbers only**, 1-based, inclusive, `end >= start`.
- **Test commands.** `pnpm test` is `vitest run --project node`. A single file is
  `pnpm vitest run --project node test/<name>.test.ts`; add `-t "<substring>"` for one case.
  `pnpm e2e` is Playwright. **`pnpm verify` runs typecheck, lint, node tests, browser tests, _and_
  the whole e2e suite** — it is the gate before the final commit, not before every one. Per task,
  run the targeted tests plus `pnpm typecheck && pnpm lint`.
- **Formatting is applied by the pre-commit hook** (lefthook runs `oxfmt` on staged files), so
  committed markdown and TypeScript may come back reformatted. That is expected, not a conflict.

---

### Task 1: Per-key mutex, and the comment race it fixes

The hub is one process but not one thread of execution. `addComment` reads the store, awaits `currentBranch()`, then writes — two in-flight requests interleave at that await, both read the same snapshot, and the second write drops the first. Human-paced comments never hit it. Agent-driven lens writes would.

**Files:**

- Create: `server/locks.ts`
- Modify: `server/comments.ts` (wrap every read-modify-write mutator)
- Test: `test/locks.test.ts`, `test/comments.test.ts` (append one regression test)

**Interfaces:**

- Consumes: nothing.
- Produces: `withLock<T>(key: string, fn: () => Promise<T>): Promise<T>` and `lockCount(): number` from `server/locks.js`. Every later task that mutates a store wraps its read-modify-write in `withLock(wsId, …)`.

- [ ] **Step 1: Write the failing tests for the mutex**

Create `test/locks.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { withLock, lockCount } from "../server/locks.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("two writers on one key do not interleave their read-modify-write", async () => {
  let shared = 0;
  const bump = async (): Promise<void> => {
    const read = shared;
    await tick(); // the window a bare async handler leaves open
    shared = read + 1;
  };
  await Promise.all([withLock("ws", bump), withLock("ws", bump)]);
  assert.equal(shared, 2);
});

test("writers on different keys are not serialized against each other", async () => {
  const order: string[] = [];
  const slow = async (): Promise<void> => {
    await tick();
    await tick();
    order.push("slow");
  };
  const fast = async (): Promise<void> => {
    order.push("fast");
  };
  await Promise.all([withLock("a", slow), withLock("b", fast)]);
  assert.deepEqual(order, ["fast", "slow"]);
});

test("a rejecting task does not poison the key for later writers", async () => {
  await assert.rejects(
    withLock("ws", () => Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.equal(await withLock("ws", () => Promise.resolve("ok")), "ok");
});

test("the caller of a rejecting task still sees its rejection", async () => {
  const first = withLock("ws", () => Promise.reject(new Error("mine")));
  const second = withLock("ws", () => Promise.resolve("fine"));
  await assert.rejects(first, /mine/);
  assert.equal(await second, "fine");
});

test("keys are released once their chain drains, so the map cannot grow without bound", async () => {
  await withLock("a", () => Promise.resolve());
  await withLock("b", () => Promise.resolve());
  await tick();
  assert.equal(lockCount(), 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project node test/locks.test.ts`
Expected: FAIL — cannot resolve `../server/locks.js`.

- [ ] **Step 3: Implement the mutex**

Create `server/locks.ts`:

```ts
/**
 * Serializes read-modify-write cycles that share a key.
 *
 * The hub is a single process, which is easy to mistake for a single thread of execution. A
 * handler that reads a store, awaits anything, then writes it can be interleaved by a second
 * request that read the same snapshot — and the later write silently drops the earlier one.
 * Comments never hit that window because a human clicks one at a time; an agent writing a lens
 * set does.
 */

const tails = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  // Run regardless of how the predecessor settled: one caller's failure must not strand the queue.
  const result = previous.then(fn, fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Only the current tail may clear the entry — anything else would drop a queued successor.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/** Test seam: proves drained keys are released rather than accumulating. */
export function lockCount(): number {
  return tails.size;
}
```

- [ ] **Step 4: Run the mutex tests**

Run: `pnpm vitest run --project node test/locks.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing regression test for the comment race**

Append to `test/comments.test.ts`:

```ts
test("two comments added concurrently both survive", async () => {
  await withTempXdg(async ({ root }) => {
    const repo = await makeRepo(join(root, "repo"));
    await Promise.all([
      addComment("ws1", repo, { ...input, body: "first" }),
      addComment("ws1", repo, { ...input, body: "second" }),
    ]);
    const stored = await listComments("ws1", repo);
    assert.deepEqual(
      stored.map((c) => c.body).toSorted(),
      ["first", "second"],
      "a concurrent write dropped one comment",
    );
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run --project node test/comments.test.ts -t "concurrently"`
Expected: FAIL — one comment stored, not two. This is the bug.

- [ ] **Step 7: Wrap the comment mutators**

In `server/comments.ts`, add `import { withLock } from "./locks.js";` and wrap the body of every exported function that reads the store, awaits, then writes it: `addComment`, `updateComment`, `restoreComment`, `sweep`, `purgeArchived`. Read-only functions (`listComments`, `getComment`) are left alone.

The shape for each — `addComment` shown, apply the same transformation to the rest:

```ts
export async function addComment(
  wsId: string,
  repoPath: string | null,
  input: unknown,
): Promise<Comment> {
  return withLock(wsId, async () => {
    // ...the existing body, unchanged...
  });
}
```

For `sweep` and `purgeArchived`, which take their workspace id the same way, use the same `wsId` key so they serialize against `addComment` rather than racing it.

- [ ] **Step 8: Run the full comment suite**

Run: `pnpm vitest run --project node test/comments.test.ts test/locks.test.ts`
Expected: PASS, including the new regression test.

- [ ] **Step 9: Commit**

```bash
git add server/locks.ts server/comments.ts test/locks.test.ts test/comments.test.ts
git commit -m "fix(livediff): serialize store writes so concurrent requests cannot drop one"
```

---

### Task 2: Glob matching

**Files:**

- Create: `server/glob.ts`
- Test: `test/glob.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `pathMatcher(patterns: readonly string[]): (path: string) => boolean` and `matchesGlob(path: string, pattern: string): boolean` from `server/glob.js`. Task 7 imports `pathMatcher` into the browser bundle.

- [ ] **Step 1: Write the failing tests**

Create `test/glob.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { matchesGlob, pathMatcher } from "../server/glob.js";

test("a pattern with no metacharacter matches only itself", () => {
  assert.equal(matchesGlob("src/retry.ts", "src/retry.ts"), true);
  assert.equal(matchesGlob("src/retry.test.ts", "src/retry.ts"), false);
  assert.equal(matchesGlob("a/src/retry.ts", "src/retry.ts"), false);
});

test("a star stays inside one segment", () => {
  assert.equal(matchesGlob("src/retry.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/deep/retry.ts", "src/*.ts"), false);
  assert.equal(matchesGlob("src/.ts", "src/*.ts"), true, "star matches the empty run");
});

test("a globstar spans any number of segments, including zero", () => {
  assert.equal(matchesGlob("foo.ts", "**/foo.ts"), true);
  assert.equal(matchesGlob("a/foo.ts", "**/foo.ts"), true);
  assert.equal(matchesGlob("a/b/c/foo.ts", "**/foo.ts"), true);
  assert.equal(matchesGlob("a/b", "a/**/b"), true);
  assert.equal(matchesGlob("a/x/y/b", "a/**/b"), true);
});

test("a trailing globstar matches everything beneath a directory but not the directory itself", () => {
  assert.equal(matchesGlob("test/unit/a.ts", "test/**"), true);
  assert.equal(matchesGlob("test/a.ts", "test/**"), true);
  assert.equal(matchesGlob("test", "test/**"), false);
  assert.equal(matchesGlob("tests/a.ts", "test/**"), false);
});

test("a bare globstar matches every path", () => {
  assert.equal(matchesGlob("a", "**"), true);
  assert.equal(matchesGlob("a/b/c.ts", "**"), true);
});

test("a question mark matches exactly one character and never a separator", () => {
  assert.equal(matchesGlob("src/a.ts", "src/?.ts"), true);
  assert.equal(matchesGlob("src/ab.ts", "src/?.ts"), false);
  assert.equal(matchesGlob("src/a/ts", "src/?.ts"), false);
});

test("regex metacharacters in a pattern are literal", () => {
  assert.equal(matchesGlob("a+b.ts", "a+b.ts"), true);
  assert.equal(matchesGlob("aab.ts", "a+b.ts"), false);
  assert.equal(matchesGlob("v1.2.ts", "v1.2.ts"), true);
  assert.equal(matchesGlob("v1x2.ts", "v1.2.ts"), false);
});

test("matching is case-sensitive", () => {
  assert.equal(matchesGlob("SRC/a.ts", "src/*.ts"), false);
});

test("a leading bang is literal, not negation", () => {
  assert.equal(matchesGlob("test/a.ts", "!test/**"), false);
  assert.equal(matchesGlob("!test/a.ts", "!test/**"), true);
});

test("a matcher unions its patterns and an empty matcher matches nothing", () => {
  const match = pathMatcher(["test/**", "src/retry.ts"]);
  assert.equal(match("test/a.ts"), true);
  assert.equal(match("src/retry.ts"), true);
  assert.equal(match("src/other.ts"), false);
  assert.equal(pathMatcher([])("anything"), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project node test/glob.test.ts`
Expected: FAIL — cannot resolve `../server/glob.js`.

- [ ] **Step 3: Implement it**

Create `server/glob.ts`:

```ts
/**
 * Path matching for lens membership: `*`, `**`, `?`, and literals, and nothing else.
 *
 * Hand-rolled because the server carries no runtime dependencies and `path.matchesGlob` is still
 * experimental. The small syntax is the point rather than a limitation — a pattern with no
 * metacharacter is a literal path matching only itself, which is what lets one field express both
 * "the tests, including ones added later" and "these four files I picked by reading them".
 */

/** Sentinel for a `**` segment. Not a legal path character, so it cannot collide with a literal. */
const GLOBSTAR = "�";

export function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns.map((pattern) => new RegExp(`^${translate(pattern)}$`));
  return (path) => compiled.some((expression) => expression.test(path));
}

export function matchesGlob(path: string, pattern: string): boolean {
  return pathMatcher([pattern])(path);
}

function translate(pattern: string): string {
  const tokens = pattern.split("/").map((s) => (s === "**" ? GLOBSTAR : segment(s)));
  let source = "";
  for (const [index, token] of tokens.entries()) {
    const last = index === tokens.length - 1;
    if (token === GLOBSTAR) {
      // A globstar owns the separator that follows it, so `**/foo` still matches a bare `foo`.
      source += last ? "[^]*" : "(?:[^/]+/)*";
      continue;
    }
    source += last ? token : `${token}/`;
  }
  return source;
}

function segment(text: string): string {
  let source = "";
  for (const char of text) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return source;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project node test/glob.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/glob.ts test/glob.test.ts
git commit -m "feat(livediff): match diff paths against lens patterns"
```

---

### Task 3: The lens model and its store

**Files:**

- Modify: `shared/types.ts` (add `Highlight`, `Lens`)
- Modify: `server/constants.ts` (add `LENSES_DIR_NAME`, `LENS_STORE_VERSION`, `LENS_NAME_PATTERN`)
- Create: `server/lenses.ts`
- Test: `test/lenses.test.ts`

**Interfaces:**

- Consumes: `withLock` (Task 1); `pathMatcher` (Task 2).
- Produces, from `server/lenses.js`: `parseLens(value, where): Lens`, `parseLensSet(value): Lens[]`, `listLenses(wsId): Promise<Lens[]>`, `setLenses(wsId, lenses): Promise<Lens[]>`, `upsertLens(wsId, lens): Promise<Lens[]>`, `removeLens(wsId, name): Promise<boolean>`, `clearLenses(wsId): Promise<boolean>`, `lensStorePath(wsId): string`. Types `Lens` and `Highlight` from `shared/types.ts`.

- [ ] **Step 1: Add the shared types**

Append to `shared/types.ts`:

```ts
export interface Highlight {
  path: string;
  /** New-side line number, 1-based and inclusive. */
  start: number;
  /** New-side line number, 1-based and inclusive; never less than `start`. */
  end: number;
}

/**
 * One way of reading a change: the files it selects, and the ranges inside them worth looking at.
 *
 * A lens belongs to a review handoff rather than to the repository — the agent writes the whole
 * set when it stops working, and the next handoff replaces it. Nothing keeps it current in
 * between, which is why highlights carry plain line numbers and need no drift anchor.
 */
export interface Lens {
  name: string;
  why: string | null;
  /** Glob patterns; a pattern with no metacharacter is a literal path matching only itself. */
  paths: string[];
  highlights: Highlight[];
  createdAt: string;
}
```

- [ ] **Step 2: Add the constants**

In `server/constants.ts`, under the `─── Storage ───` section beside `COMMENTS_DIR_NAME`:

```ts
export const LENSES_DIR_NAME = "lenses";

/** Schema version written into every lens store. */
export const LENS_STORE_VERSION = 1;
```

And under `─── Identifiers ───`:

```ts
/** Lens names are typed, completed, and put in a URL, so they are kebab-case and bounded. */
export const LENS_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
```

- [ ] **Step 3: Write the failing tests**

Create `test/lenses.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { withTempXdg } from "./helpers.js";
import {
  parseLens,
  parseLensSet,
  listLenses,
  setLenses,
  upsertLens,
  removeLens,
  clearLenses,
  lensStorePath,
} from "../server/lenses.js";

const retry = { name: "retry", why: "the actual change", paths: ["src/retry.ts"] };

test("a lens parses with its optional fields defaulted", () => {
  const lens = parseLens({ name: "retry", paths: ["src/retry.ts"] }, "lens 0");
  assert.equal(lens.name, "retry");
  assert.equal(lens.why, null);
  assert.deepEqual(lens.highlights, []);
  assert.match(lens.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a supplied createdAt is preserved so a round trip is lossless", () => {
  const lens = parseLens({ ...retry, createdAt: "2026-01-01T00:00:00.000Z" }, "lens 0");
  assert.equal(lens.createdAt, "2026-01-01T00:00:00.000Z");
});

test("a name outside the pattern is rejected, at both ends of the range", () => {
  assert.throws(() => parseLens({ ...retry, name: "" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "-leading" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "Retry" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "has space" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "a".repeat(41) }, "lens 0"), /name/);
  assert.doesNotThrow(() => parseLens({ ...retry, name: "a" }, "lens 0"));
  assert.doesNotThrow(() => parseLens({ ...retry, name: "a".repeat(40) }, "lens 0"));
});

test("a lens with no paths is rejected — it could never be intended", () => {
  assert.throws(() => parseLens({ name: "retry", paths: [] }, "lens 0"), /paths/);
  assert.throws(() => parseLens({ name: "retry" }, "lens 0"), /paths/);
});

test("the error names where the bad lens was, so a set of ten is debuggable", () => {
  assert.throws(() => parseLens({ name: "BAD", paths: ["a"] }, "lens 7"), /lens 7/);
});

test("a highlight must have a sane range", () => {
  const withRange = (h: unknown) => () => parseLens({ ...retry, highlights: [h] }, "lens 0");
  assert.throws(withRange({ path: "src/retry.ts", start: 5, end: 4 }), /end/);
  assert.throws(withRange({ path: "src/retry.ts", start: 0, end: 4 }), /start/);
  assert.throws(withRange({ path: "src/retry.ts", start: 1.5, end: 4 }), /start/);
  assert.doesNotThrow(withRange({ path: "src/retry.ts", start: 4, end: 4 }));
});

test("a highlight outside the lens's own paths is rejected — it could never render", () => {
  assert.throws(
    () => parseLens({ ...retry, highlights: [{ path: "src/other.ts", start: 1, end: 2 }] }, "l"),
    /src\/other\.ts/,
  );
  assert.doesNotThrow(() =>
    parseLens(
      { name: "t", paths: ["test/**"], highlights: [{ path: "test/a.ts", start: 1, end: 2 }] },
      "l",
    ),
  );
});

test("a set rejects duplicate names rather than silently keeping one", () => {
  assert.throws(() => parseLensSet({ lenses: [retry, retry] }), /retry/);
});

test("a set accepts a bare array as well as the wrapped form", () => {
  assert.equal(parseLensSet([retry]).length, 1);
  assert.equal(parseLensSet({ lenses: [retry] }).length, 1);
});

test("an absent store reads as an empty set", async () => {
  await withTempXdg(async () => {
    assert.deepEqual(await listLenses("ws1"), []);
  });
});

test("setting replaces the whole set rather than merging into it", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry, { name: "tests", paths: ["test/**"] }]));
    await setLenses("ws1", parseLensSet([{ name: "docs", paths: ["docs/**"] }]));
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["docs"],
    );
  });
});

test("the stored order is the order given, because it is the order the picker shows", async () => {
  await withTempXdg(async () => {
    await setLenses(
      "ws1",
      parseLensSet([
        { name: "b", paths: ["b"] },
        { name: "a", paths: ["a"] },
      ]),
    );
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["b", "a"],
    );
  });
});

test("the store is written with its version", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    const raw: unknown = JSON.parse(await readFile(lensStorePath("ws1"), "utf8"));
    assert.equal((raw as { version: number }).version, 1);
  });
});

test("upsert appends a new lens and replaces one whose name already exists", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    await upsertLens("ws1", parseLens({ name: "tests", paths: ["test/**"] }, "lens"));
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["retry", "tests"],
    );
    await upsertLens("ws1", parseLens({ name: "retry", paths: ["src/**"] }, "lens"));
    const stored = await listLenses("ws1");
    assert.deepEqual(
      stored.map((l) => l.name),
      ["retry", "tests"],
      "replacing kept the position",
    );
    assert.deepEqual(stored[0]?.paths, ["src/**"]);
  });
});

test("removing reports whether anything was removed", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    assert.equal(await removeLens("ws1", "absent"), false);
    assert.equal(await removeLens("ws1", "retry"), true);
    assert.deepEqual(await listLenses("ws1"), []);
  });
});

test("clearing an empty store reports that nothing was cleared", async () => {
  await withTempXdg(async () => {
    assert.equal(await clearLenses("ws1"), false);
    await setLenses("ws1", parseLensSet([retry]));
    assert.equal(await clearLenses("ws1"), true);
  });
});

test("concurrent upserts do not drop one", async () => {
  await withTempXdg(async () => {
    await Promise.all([
      upsertLens("ws1", parseLens({ name: "one", paths: ["a"] }, "lens")),
      upsertLens("ws1", parseLens({ name: "two", paths: ["b"] }, "lens")),
    ]);
    assert.deepEqual((await listLenses("ws1")).map((l) => l.name).toSorted(), ["one", "two"]);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run --project node test/lenses.test.ts`
Expected: FAIL — cannot resolve `../server/lenses.js`.

- [ ] **Step 5: Implement the store**

Create `server/lenses.ts`:

```ts
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./registry.js";
import { LENSES_DIR_NAME, LENS_NAME_PATTERN, LENS_STORE_VERSION } from "./constants.js";
import { writeJsonAtomic } from "./atomic.js";
import { withLock } from "./locks.js";
import { pathMatcher } from "./glob.js";
import type { Highlight, Lens } from "../shared/types.ts";

/**
 * Lens sets, one JSON file per workspace, a sibling of the comment stores.
 *
 * An ordered array rather than a keyed object: a workspace holds a handful of lenses and always
 * reads them as a whole set, and the order is meaningful — it is the order the picker shows, and
 * later the order of a walkthrough's steps.
 */

interface LensFile {
  version: number;
  lenses: Lens[];
}

export function lensStorePath(wsId: string): string {
  return join(configDir(), LENSES_DIR_NAME, `${wsId}.json`);
}

export function parseLens(value: unknown, where: string): Lens {
  if (!isRecord(value)) throw new TypeError(`${where}: must be an object`);
  const name = value["name"];
  if (typeof name !== "string" || !LENS_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `${where}: name must be lowercase letters, digits, and dashes, 1–40 characters, not starting with a dash`,
    );
  }
  const paths = value["paths"];
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((p) => typeof p !== "string" || p.length === 0)
  ) {
    throw new TypeError(`${where}: paths must be a non-empty array of non-empty patterns`);
  }
  const why = value["why"];
  if (why !== undefined && why !== null && typeof why !== "string") {
    throw new TypeError(`${where}: why must be a string`);
  }
  const createdAt = value["createdAt"];
  if (createdAt !== undefined && typeof createdAt !== "string") {
    throw new TypeError(`${where}: createdAt must be a string`);
  }
  return {
    name,
    why: typeof why === "string" ? why : null,
    paths: paths as string[],
    highlights: parseHighlights(value["highlights"], where, paths as string[]),
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

function parseHighlights(value: unknown, where: string, paths: readonly string[]): Highlight[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${where}: highlights must be an array`);
  const covered = pathMatcher(paths);
  return value.map((entry, index) => {
    const at = `${where}: highlight ${index}`;
    if (!isRecord(entry)) throw new TypeError(`${at}: must be an object`);
    const path = entry["path"];
    if (typeof path !== "string" || path.length === 0)
      throw new TypeError(`${at}: path is required`);
    // A highlight the lens itself filters out could never render, so it is a mistake, not a no-op.
    if (!covered(path)) throw new TypeError(`${at}: ${path} is not matched by this lens's paths`);
    const start = lineNumber(entry["start"], `${at}: start`);
    const end = lineNumber(entry["end"], `${at}: end`);
    if (end < start) throw new TypeError(`${at}: end must not be before start`);
    return { path, start, end };
  });
}

function lineNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${where} must be a whole line number of 1 or more`);
  }
  return value;
}

export function parseLensSet(value: unknown): Lens[] {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value["lenses"] : undefined;
  if (!Array.isArray(raw)) throw new TypeError("expected { lenses: [...] } or an array of lenses");
  const lenses = raw.map((entry, index) => parseLens(entry, `lens ${index}`));
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (seen.has(lens.name)) throw new TypeError(`duplicate lens name: ${lens.name}`);
    seen.add(lens.name);
  }
  return lenses;
}

export async function listLenses(wsId: string): Promise<Lens[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(lensStorePath(wsId), "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw["lenses"])) return [];
    return raw["lenses"].flatMap((entry, index) => {
      // A hand-edited store should lose the broken entry, not the whole set.
      try {
        return [parseLens(entry, `lens ${index}`)];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

export async function setLenses(wsId: string, lenses: Lens[]): Promise<Lens[]> {
  return withLock(wsId, async () => {
    await write(wsId, lenses);
    return lenses;
  });
}

export async function upsertLens(wsId: string, lens: Lens): Promise<Lens[]> {
  return withLock(wsId, async () => {
    const current = await listLenses(wsId);
    const at = current.findIndex((entry) => entry.name === lens.name);
    // Replacing in place rather than moving to the end: the order is the reading order.
    const next = at === -1 ? [...current, lens] : current.with(at, lens);
    await write(wsId, next);
    return next;
  });
}

export async function removeLens(wsId: string, name: string): Promise<boolean> {
  return withLock(wsId, async () => {
    const current = await listLenses(wsId);
    const next = current.filter((entry) => entry.name !== name);
    if (next.length === current.length) return false;
    await write(wsId, next);
    return true;
  });
}

export async function clearLenses(wsId: string): Promise<boolean> {
  return withLock(wsId, async () => {
    const had = (await listLenses(wsId)).length > 0;
    await rm(lensStorePath(wsId), { force: true });
    return had;
  });
}

async function write(wsId: string, lenses: Lens[]): Promise<void> {
  const file: LensFile = { version: LENS_STORE_VERSION, lenses };
  await writeJsonAtomic(lensStorePath(wsId), file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run --project node test/lenses.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add shared/types.ts server/constants.ts server/lenses.ts test/lenses.test.ts
git commit -m "feat(livediff): store a workspace's lens set"
```

---

### Task 4: HTTP surface

**Files:**

- Modify: `server/index.ts` (routes, SSE broadcast, file watcher)
- Test: `test/lenses-http.test.ts`

**Interfaces:**

- Consumes: everything from Task 3.
- Produces: `GET|PUT|POST|DELETE /api/lenses?ws=<id>` and a `lenses` SSE event `{ reason, ws }`. Tasks 5 and 7 are its only clients.

- [ ] **Step 1: Write the failing integration tests**

Create `test/lenses-http.test.ts`. Model the hub setup on the existing `test/hub-startup.test.ts` — read it first and reuse its helper for starting a hub against a temp XDG root and registering a workspace. Cover:

```ts
// 1. GET on a workspace with no lenses returns { lenses: [] }
// 2. PUT { lenses: [a, b] } then GET returns both, in order
// 3. PUT { lenses: [c] } replaces — GET returns only c
// 4. POST one lens appends it; POST the same name again replaces in place
// 5. DELETE ?name=a removes one and returns { ok: true }; an absent name returns { ok: false }
// 6. DELETE with no name clears the set
// 7. PUT with a malformed lens returns 400 and a message naming the lens index and field
// 8. GET with an unknown ws returns 404
// 9. each of PUT, POST, DELETE emits one `lenses` SSE frame carrying { ws }
```

Write each as a real `test(...)` with real assertions — the comment block above is the checklist, not the deliverable.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project node test/lenses-http.test.ts`
Expected: FAIL — every request 404s, the route does not exist.

- [ ] **Step 3: Add the routes**

In `server/index.ts`, import from `./lenses.js`, and add a block beside the `/api/comments` routes. Follow the existing shape exactly: resolve the workspace with the same helper the comment routes use, `send(res, 404, …)` when it is missing, and `send(res, 400, { error: … })` for a `TypeError` out of the parsers.

```ts
if (pathname === "/api/lenses") {
  const ws = await workspaceFromQuery(url); // same helper /api/comments uses
  if (!ws) return send(res, 404, { error: "unknown workspace" });

  if (req.method === "GET") return send(res, 200, { lenses: await listLenses(ws.id) });

  if (req.method === "PUT") {
    const lenses = parseLensSet(await readJson(req));
    await setLenses(ws.id, lenses);
    broadcast("lenses", { reason: "set", ws: ws.id });
    return send(res, 200, { lenses });
  }

  if (req.method === "POST") {
    const lenses = await upsertLens(ws.id, parseLens(await readJson(req), "lens"));
    broadcast("lenses", { reason: "added", ws: ws.id });
    return send(res, 200, { lenses });
  }

  if (req.method === "DELETE") {
    const name = url.searchParams.get("name");
    const ok = name ? await removeLens(ws.id, name) : await clearLenses(ws.id);
    if (ok) broadcast("lenses", { reason: name ? "removed" : "cleared", ws: ws.id });
    return send(res, 200, { ok });
  }
}
```

Match the file's existing names for the workspace lookup and body reader rather than inventing `workspaceFromQuery`/`readJson` — read the `/api/comments` POST handler at `server/index.ts:352` and copy its idiom.

- [ ] **Step 4: Teach the file watcher about the new directory**

At `server/index.ts:585`, beside the comments case, add the lens store so hand-editing the file on disk reaches an open browser:

```ts
const lensMatch = /^lenses[/\\]([\w-]+)\.json$/.exec(file);
if (lensMatch) return broadcast("lenses", { reason: "file", ws: lensMatch[1] });
```

Confirm the watcher is actually watching `configDir()` recursively enough to see `lenses/`; if it watches specific subdirectories, add `lenses` alongside `comments`.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run --project node test/lenses-http.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add server/index.ts test/lenses-http.test.ts
git commit -m "feat(livediff): serve lens sets over the hub API"
```

---

### Task 5: CLI lens commands

**Files:**

- Modify: `server/cli-help.ts` (add `lens` to `COMMANDS`, add `LENS_COMMANDS`, `findLensCommand`, extend `VALUE_FLAGS`, extend `describeCommand` listing)
- Modify: `server/cli.ts` (add `cmdLens`, dispatch, help resolution)
- Test: `test/cli.test.ts` (append), `test/cli-docs.test.ts` will pick the new commands up automatically

**Interfaces:**

- Consumes: the HTTP surface from Task 4.
- Produces: `livediff lens set|add|list|rm|clear`. Task 6 relies on lens names being resolvable via `GET /api/lenses`.

- [ ] **Step 1: Add the command table entries**

In `server/cli-help.ts`, add to `COMMANDS` (place it after `comments` so the main help groups review surfaces together):

```ts
{
  id: "lens",
  name: "lens",
  usage: "livediff lens <set|add|list|rm|clear> [...]",
  summary: "define the ways to read this change",
  args: [{ name: "subcommand", required: false }],
  details:
    "A lens narrows the diff to a set of files and marks ranges inside them. A lens set\n" +
    "belongs to a review handoff: the agent writes the whole set when it stops working,\n" +
    "and the next handoff replaces it.\n" +
    "\n" +
    "`lens set` reads the whole set as JSON on stdin and is the path an agent should use —\n" +
    "one write, no chance of two concurrent commands dropping each other's lenses.",
  flags: [],
  examples: [
    ["livediff lens list", "show this workspace's lenses and what each one matches"],
    ["livediff lens add tests --path 'test/**'", "add one lens by hand"],
  ],
},
```

Then a `LENS_COMMANDS` table beside `CONFIG_COMMANDS`, with one entry per subcommand. `set` takes no args and no flags (stdin only). `add` takes `<name>` plus `--path <glob>` (repeatable, required), `--why <text>`, `--highlight <path>:<start>-<end>` (repeatable). `list` takes none. `rm` takes `<name>` with `completion: "lens"`. `clear` takes none.

Add `findLensCommand`, mirroring `findConfigCommand`. Add `...LENS_COMMANDS.flatMap(valueOptionNames)` to `VALUE_FLAGS` — without it the parser will swallow `--path`'s value as a positional. Add `renderLensCommandHelp` mirroring `renderConfigCommandHelp`, and add the `LENS_COMMANDS` line to the `describeCommand` list at `server/cli-help.ts:757` so `livediff __describe` and the generated CLI reference include them.

Add `"lens"` to the `CompletionKind` union.

- [ ] **Step 2: Write the failing CLI tests**

Append to `test/cli.test.ts`, following the file's existing harness for invoking the CLI against a temp hub:

```
- `lens add tests --path 'test/**' --why "coverage"` then `lens list --json` shows one lens
- `lens add` with no --path exits non-zero with a usage message mentioning --path
- `lens add BAD --path a` exits non-zero mentioning the name rules
- `lens add t --path 'test/**' --highlight nope` exits non-zero showing the path:start-end form
- `lens add t --path 'test/**' --highlight test/a.ts:9-4` exits non-zero mentioning end
- `lens set` fed valid JSON on stdin replaces the whole set
- `lens set` fed invalid JSON exits non-zero naming the offending lens index
- `lens rm absent` exits non-zero
- `lens clear` empties the set
- `lens list` on an empty set prints a human line saying there are none, and exits 0
```

Write each as a real test with real assertions.

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run --project node test/cli.test.ts -t lens`
Expected: FAIL — `unknown command: lens`.

- [ ] **Step 4: Implement `cmdLens`**

In `server/cli.ts`, add `cmdLens(rest)` modelled on `cmdConfig` (`server/cli.ts:877`). It resolves the workspace from `process.cwd()` the way the other workspace commands do, then:

- `set` — read all of stdin, `JSON.parse`, `PUT /api/lenses`. On a parse or validation failure, `die(message, EXIT_USAGE)`.
- `add <name>` — collect repeated `--path` and `--highlight` values and a single `--why`, build the lens object, `POST /api/lenses`.
- `list` — `GET /api/lenses`. Human output: one line per lens, `name  (n files)  why`, where the count comes from resolving the lens's patterns against the current diff so a zero is visible. `--json` emits the raw set.
- `rm <name>` — `DELETE ?name=`, exit non-zero when `ok` is false.
- `clear` — `DELETE` with no name.

Repeated flags need parser support: check how `flags` collects values today and add a `flagValues(name): string[]` helper if it only keeps the last one. `--highlight` parsing lives in a small exported function so it can be unit-tested:

```ts
/** `path:start-end`, where the path may itself contain colons on Windows-style inputs. */
export function parseHighlightArg(value: string): { path: string; start: number; end: number } {
  const at = value.lastIndexOf(":");
  const range = at === -1 ? "" : value.slice(at + 1);
  const match = /^(\d+)-(\d+)$/.exec(range);
  const path = at === -1 ? "" : value.slice(0, at);
  if (!match || path.length === 0) {
    throw new Error(`--highlight must look like path:start-end, for example src/retry.ts:88-104`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1) throw new Error("--highlight start must be 1 or more");
  if (end < start) throw new Error("--highlight end must not be before start");
  return { path, start, end };
}
```

Wire dispatch: add `case "lens": return cmdLens(rest);` to the main switch beside `case "config":` at `server/cli.ts:1068`, and extend `resolveHelpCommand` (`server/cli.ts:959`) with a `lens` arm so `livediff lens add --help` works.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run --project node test/cli.test.ts test/cli-docs.test.ts`
Expected: PASS. If `cli-docs` fails, regenerate with `pnpm docs` (check `package.json` for the exact script name) and commit the regenerated reference.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add server/cli-help.ts server/cli.ts test/cli.test.ts docs/
git commit -m "feat(livediff): define lenses from the CLI"
```

---

### Task 6: Apply a lens on open

**Files:**

- Modify: `server/cli-help.ts` (add `--lens <name>` to `open` and `review`)
- Modify: `server/cli.ts` (`cmdOpen`, around `server/cli.ts:353-377`)
- Test: `test/cli.test.ts` (append)

**Interfaces:**

- Consumes: `GET /api/lenses` (Task 4).
- Produces: `&lens=<name>` in the focused URL. Task 7 reads it.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts`:

```
- `livediff open . --no-open --lens tests --json` puts `lens=tests` in the returned url
- the same without --lens has no `lens=` in the url
- `--lens absent` exits non-zero and the message lists the names that do exist
- `--lens absent` with an empty set says so rather than printing an empty list
- a lens name is URL-encoded in the emitted url
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project node test/cli.test.ts -t "lens="`
Expected: FAIL — unknown option `--lens`.

- [ ] **Step 3: Implement it**

Add `["--lens <name>", "open with one lens already applied"]` to the `flags` of both the `open` and `review` entries in `COMMANDS`.

In `cmdOpen`, after the workspace is registered and before the URL is built, resolve the name:

```ts
const lens = flagValue("--lens");
if (lens !== undefined) {
  const { lenses } = await api(base, `/api/lenses?ws=${ws.id}`, parseLenses);
  if (!lenses.some((entry) => entry.name === lens)) {
    // Silently opening the full diff would mean reviewing the wrong thing while believing
    // otherwise, which is worse than a stopped command.
    const known = lenses.map((entry) => entry.name).join(", ");
    await die(
      known
        ? `unknown lens: ${lens}\n\nthis worktree has: ${known}`
        : `unknown lens: ${lens}\n\nthis worktree has no lenses`,
      EXIT_USAGE,
    );
  }
}
const applied = lens === undefined ? "" : `&lens=${encodeURIComponent(lens)}`;
```

and append `applied` to the URL beside the existing `scope`. Add `lens` to the JSON payload passed to `out(...)` alongside `dir`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project node test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add server/cli-help.ts server/cli.ts test/cli.test.ts docs/
git commit -m "feat(livediff): open a worktree with a lens applied"
```

---

### Task 7: Filter the diff in the browser

**Files:**

- Modify: `src/api.ts` (add `fetchLenses`, add `onLenses` to `Subscribers`)
- Create: `src/components/LensPicker.tsx`
- Modify: `src/App.tsx` (read `?lens=`, fetch the set, filter files, render the picker)
- Test: `e2e/lenses.spec.ts`

**Interfaces:**

- Consumes: `GET /api/lenses`, the `lenses` SSE event, `pathMatcher` from `server/glob.js`, `Lens` from `shared/types.ts`.
- Produces: an `activeLens: Lens | null` value in `App.tsx` that Task 8 reads for highlights.

- [ ] **Step 1: Extend the client API**

In `src/api.ts`, add beside `fetchComments`:

```ts
export function fetchLenses(ws: string): Promise<Lens[]> {
  return fetch(`/api/lenses?ws=${encodeURIComponent(ws)}`)
    .then(json<{ lenses: Lens[] }>)
    .then((body) => body.lenses);
}
```

Match the existing function's exact idiom rather than the sketch above. Add `onLenses?: () => void` to `Subscribers` and dispatch the `lenses` event to it inside `subscribe`.

- [ ] **Step 2: Write the failing e2e tests**

Create `e2e/lenses.spec.ts`, following `e2e/navigation.spec.ts` for harness setup. Cover:

```
- with a lens applied via ?lens=, the file tree shows only the lens's files
- the header control reads the lens name, and reads "Full diff" with no lens
- the control is visually distinguished while a lens is applied (assert on a data attribute, not a colour)
- choosing "Full diff" from the picker restores every file and drops lens= from the URL
- choosing a lens from the picker adds lens= to the URL
- an unknown ?lens= falls back to the full diff rather than an empty screen
- a lens matching no files shows an empty state that still offers the way back
- the picker lists each lens with its `why` and a file count
```

Add a fixture lens set via the CLI (`livediff lens set`) in the spec's setup.

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm e2e lenses`
Expected: FAIL — no lens control exists.

- [ ] **Step 4: Build the picker component**

Create `src/components/LensPicker.tsx`: a button showing the applied lens name (or `Full diff`) that toggles a dropdown listing `Full diff` plus every lens with its `why` and file count. Props: `lenses: Lens[]`, `active: Lens | null`, `counts: Map<string, number>`, `onSelect: (name: string | null) => void`. Tailwind classes only; carry the applied state on a `data-lens-active` attribute so the e2e test asserts on behavior rather than colour.

No nested ternaries — if a label needs branching, extract a named helper returning early.

- [ ] **Step 5: Wire it into App.tsx**

Beside the existing `dir` handling at `src/App.tsx:154`:

```ts
// ?lens=<name> narrows the view to one lens. Like ?dir=, it is a filter over the same diff —
// comments stay keyed to the worktree, so nothing is hidden from the CLI by applying one.
const [lensName, setLensName] = useState(() => urlParams.get("lens"));
```

Fetch the set when the selected workspace changes and on the `lenses` SSE event. Resolve `activeLens` by name, falling back to `null` when the name matches nothing — an unknown name must show the full diff, never an empty screen.

Extend the file filter at `src/App.tsx:366` so `dir` and the lens compose as an intersection:

```ts
const files = useMemo(() => {
  const all = diff?.files ?? [];
  const underDir = dir ? all.filter((f) => f.path === dir || f.path.startsWith(`${dir}/`)) : all;
  if (!activeLens) return underDir;
  const inLens = pathMatcher(activeLens.paths);
  return underDir.filter((f) => inLens(f.path));
}, [diff, dir, activeLens]);
```

Selecting a lens updates both `lensName` and the URL via `history.replaceState`, so the address bar stays the whole shareable state — mirror however `App.tsx` already handles URL state if it does; otherwise `replaceState` is the right call.

Update the empty-state copy at `src/App.tsx:647` to name the lens when one is applied and no files match, and keep the picker reachable in that state.

- [ ] **Step 6: Run the tests**

Run: `pnpm e2e lenses`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/api.ts src/components/LensPicker.tsx src/App.tsx e2e/lenses.spec.ts
git commit -m "feat(livediff): filter the diff through the applied lens"
```

---

### Task 8: Highlight ranges

**Files:**

- Modify: `src/diff-model.ts` (add `highlightedLines`)
- Modify: `src/components/FastDiff.tsx` (accept highlights, tint the rows)
- Modify: `src/App.tsx` (pass the active lens's highlights through)
- Test: `test/diff-model.test.ts` (append), `e2e/lenses.spec.ts` (append)

**Interfaces:**

- Consumes: `activeLens` from Task 7.
- Produces: `highlightedLines(highlights: readonly Highlight[]): Map<string, (line: number) => "start" | "end" | "only" | "middle" | null>` — or whatever equivalent shape the implementer settles on; the contract is that `FastDiff` can ask, for a file path and a new-side line number, whether the row is highlighted and whether it is the first or last row of its range.

- [ ] **Step 1: Write the failing unit tests**

Append to `test/diff-model.test.ts`:

```ts
test("a highlight marks its first and last rows so the tint reads as one bubble", () => {
  const lookup = highlightedLines([{ path: "a.ts", start: 10, end: 12 }]);
  assert.equal(lookup("a.ts", 9), null);
  assert.equal(lookup("a.ts", 10), "start");
  assert.equal(lookup("a.ts", 11), "middle");
  assert.equal(lookup("a.ts", 12), "end");
  assert.equal(lookup("a.ts", 13), null);
});

test("a single-line highlight is both ends at once", () => {
  const lookup = highlightedLines([{ path: "a.ts", start: 4, end: 4 }]);
  assert.equal(lookup("a.ts", 4), "only");
});

test("highlights are scoped to their own file", () => {
  const lookup = highlightedLines([{ path: "a.ts", start: 1, end: 5 }]);
  assert.equal(lookup("b.ts", 3), null);
});

test("overlapping ranges in one file do not double-count their ends", () => {
  const lookup = highlightedLines([
    { path: "a.ts", start: 1, end: 5 },
    { path: "a.ts", start: 3, end: 8 },
  ]);
  assert.equal(lookup("a.ts", 1), "start");
  assert.equal(lookup("a.ts", 5), "middle", "a run that continues is not an end");
  assert.equal(lookup("a.ts", 8), "end");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project node test/diff-model.test.ts -t highlight`
Expected: FAIL — `highlightedLines` is not exported.

- [ ] **Step 3: Implement the lookup**

Add to `src/diff-model.ts`. Merge overlapping ranges per file first — otherwise two adjoining ranges render as two bubbles where the reader sees one region. Export the type it returns.

- [ ] **Step 4: Render the tint**

In `src/components/FastDiff.tsx`, thread a `highlight` lookup down to `Side` and fold its result into the `bg` computed at line 214. The existing line is already a nested ternary; extract a named helper rather than nesting further:

```tsx
function rowBackground(kind: "add" | "del" | "ctx", mark: HighlightMark): string {
  const base = GAP[kind] ?? "";
  if (mark === null) return base;
  return `${base} ${HIGHLIGHT.tint} ${HIGHLIGHT.ends[mark]}`;
}
```

with

```tsx
/**
 * A lens marks a region, not a line. Tinting each row and rounding only the outer corners reads as
 * one translucent bubble over the region — and unlike an element spanning rows, it survives
 * virtualization, where the rows above and below simply do not exist.
 */
const HIGHLIGHT = {
  tint: "bg-violet-500/10 dark:bg-violet-400/15",
  ends: {
    start: "rounded-t",
    end: "rounded-b",
    only: "rounded",
    middle: "",
  },
} as const;
```

The tint composes over the add/delete backgrounds rather than replacing them, so a highlighted addition still reads as an addition. Verify the chosen hue clears 3:1 contrast against both `GAP.add` and `GAP.del` in light and dark themes; adjust the opacity if it does not.

In split mode, apply the tint only to the right-hand column — highlights are new-side. Render only when the file is in the applied lens, which Task 7's filter already guarantees.

Pass the lookup from `App.tsx`, built from `activeLens?.highlights ?? []`, and pass an empty lookup when no lens is applied.

- [ ] **Step 5: Add the e2e coverage**

Append to `e2e/lenses.spec.ts`:

```
- with a highlighting lens applied, the highlighted rows carry the tint and the surrounding rows do not
- the first and last highlighted rows carry the rounding classes
- a highlight whose range falls outside the file's hunks renders nothing and throws nothing
```

- [ ] **Step 6: Run everything**

Run: `pnpm vitest run --project node test/diff-model.test.ts && pnpm e2e lenses`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/diff-model.ts src/components/FastDiff.tsx src/App.tsx test/diff-model.test.ts e2e/lenses.spec.ts
git commit -m "feat(livediff): mark a lens's line ranges in the diff"
```

---

### Task 9: `.livediff` and the skills

**Files:**

- Create: `plugins/livediff/skills/lens/SKILL.md`
- Modify: all six existing `plugins/livediff/skills/*/SKILL.md`
- Modify: `plugins/livediff/skills/review/SKILL.md` (additionally)
- Modify: `server/doctor.ts`
- Test: `test/doctor.test.ts` (append), `test/plugin-packaging.test.ts` (may need the new skill added to an expected list — check)

**Interfaces:**

- Consumes: the CLI from Tasks 5 and 6.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the `.livediff` line to every existing skill**

At the top of the body of each of `comments`, `config`, `link`, `open`, `prune`, `review` `SKILL.md`, add:

```markdown
If `.livediff` exists at the worktree root, read it and follow it before doing anything else.
```

livediff never parses this file. That is the whole mechanism, and the reason it cannot break.

- [ ] **Step 2: Write the lens skill**

Create `plugins/livediff/skills/lens/SKILL.md` with frontmatter matching the other skills (`name`, `description`, `when_to_use`, `allowed-tools: Bash(livediff *)`). Content, in the terse imperative voice the other skills use:

- Build the set once, at handoff. Do not maintain lenses while working — that is a second artifact to keep in sync, and it will drift from the first.
- Source the set in order: what the user just asked for → `.livediff` defaults → the shape of the change.
- Emit exactly **one** `livediff lens set`, reading JSON on stdin. Never several `lens add` calls, never in parallel. One write cannot lose a lens; three can race.
- Then `livediff review . [--lens <name>]`.
- What makes a lens worth having: one covering 90% of the diff is worthless, and so is one covering a single file the user could have named. Aim for the cut a reviewer would want and would not have thought to ask for.
- Include the worked `lens set` heredoc from the spec as the copyable example.

- [ ] **Step 3: Teach the review skill the two-step handoff**

In `plugins/livediff/skills/review/SKILL.md`, note that handing off is two steps — set lenses, then review — and point at the lens skill.

- [ ] **Step 4: Report `.livediff` in doctor**

In `server/doctor.ts`, add a check reporting whether `.livediff` exists at the worktree root. Present is informational, absent is not a warning — most repos will not have one.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run --project node test/doctor.test.ts test/plugin-packaging.test.ts`
Expected: PASS. `plugin-packaging` asserts the shipped skill list; add `lens` to whatever it checks.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add plugins/livediff/skills server/doctor.ts test/
git commit -m "feat(livediff): teach the agent to hand off a review with lenses"
```

---

### Task 10: Documentation

**Files:**

- Modify: `DESIGN.md` (§3 Files, §7 Data, the SQLite subsection, §6 HTTP + SSE API, §9 CLI)
- Modify: `README.md`
- Modify: `docs/BACKLOG.md` (mark the shipped entries)
- Modify: `docs/AI-REVIEW-UX.md` (note what is now real)

- [ ] **Step 1: Update DESIGN.md**

- §3 Files: add `lenses.ts`, `glob.ts`, `locks.ts` to the tree with one-line descriptions.
- §7 Data: add the lens store beside the comment store, with the JSON shape from the spec, and say why it is an ordered array rather than keyed.
- §7 "Why not SQLite": correct the rotted argument. The doc cites `node:sqlite` needing 22.5+ "against a Node ≥18 target"; `package.json` now requires `>=24`, so that objection is dead. Keep the other two — native modules break global installs, and greppable JSON is load-bearing — and keep the revisit triggers.
- Add a short note under §7 that every read-modify-write runs inside `withLock`, and why: one process is not one thread of execution.
- §6: add the `/api/lenses` methods and the `lenses` SSE event.
- §9: mention `livediff lens`.

- [ ] **Step 2: Update README.md**

Add lenses to whatever feature list and command summary the README carries, with the `lens set` example.

- [ ] **Step 3: Update the backlog and UX doc**

In `docs/BACKLOG.md`, the "Lenses that filter and annotate" entry is now half-shipped — reword it to cover only the annotation half, and note that filtering and highlights landed. Leave "Lenses that render something other than a diff", walkthroughs, questions, and notes untouched.

In `docs/AI-REVIEW-UX.md`, add a line under **Lenses** noting that filtering and highlights are implemented and the rest is not, pointing at the spec.

- [ ] **Step 4: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add DESIGN.md README.md docs/
git commit -m "docs(livediff): record how lenses work"
```

---

### Task 11: Shell completion for lens names

Last deliberately: it is the only task that can be dropped without leaving the feature half-built.

**Files:**

- Modify: `server/cli.ts` (add a hidden `__complete-lenses` command)
- Modify: `server/cli-completion.ts` (bash, zsh, and fish arms)
- Test: `test/cli-completion.test.ts` (append)

**Interfaces:**

- Consumes: `GET /api/lenses`.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli-completion.test.ts`, matching how the file asserts on the generated scripts today:

```
- each generated script mentions __complete-lenses
- `livediff __complete-lenses` prints one name per line for the current worktree
- it prints nothing and exits 0 outside a registered worktree, so a shell never shows an error
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project node test/cli-completion.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the hidden `__complete-lenses` command beside the existing `__complete-workspaces` and `__complete-comments`, emitting `name\tsummary` lines in the same format `_livediff_dynamic` expects (it cuts on tab). Add the arms for `lens rm` and for `--lens` following `open`/`review` in all three generators.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project node test/cli-completion.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add server/cli.ts server/cli-completion.ts test/cli-completion.test.ts
git commit -m "feat(livediff): complete lens names in the shell"
```

---

## Final check

- [ ] `pnpm format:check` clean (the hook formats, but a file written and never staged can drift)
- [ ] `pnpm verify` clean — typecheck, lint, node tests, browser tests, e2e, in one run
- [ ] `livediff lens set` → `livediff review .` end to end by hand in this repo, with a real two-lens set, confirming: the filter narrows the tree, the picker reads out the lens, highlights render as bubbles, and `Full diff` returns everything.
