# The server migration is all-or-nothing, and the tests are why

**Found:** 2026-08-03, by renaming one leaf module and running the suite.
**Status:** open. Task 2 of the TypeScript migration plan needs the extra steps below.

## The probe

`git mv server/atomic.js server/atomic.ts` — 21 lines, no code change — and the suite went from
173 passing to **54 failing** across six files: `cli`, `ensure-hub`, `hub-startup`, `dormancy`,
`reviews`, `doctor`.

## Why

Two separate resolution failures, and only the first is obvious.

**1. `.js` importers do not resolve a `.ts` target.** Nine files import `./atomic.js` or
`../server/atomic.js`. TypeScript's `moduleResolution: nodenext` remaps that specifier when the
_importer_ is TypeScript, which is why the plan says to keep `.js` extensions after renaming. But
these importers are still JavaScript, and Vite gives them no such remapping.

**2. The server is executed by Node directly, not bundled.** This is the real blocker.
`test/helpers.js` spawns `node server/index.js`, `test/cli.test.js` shells out to `server/cli.js`,
and `package.json` points `bin` at it. Node resolves `./atomic.js` literally: no file, no start. No
amount of import rewriting fixes this, because nothing is transforming those files at all.

So the migration cannot proceed file by file. Every `server/*.js` must move together **and** the
things that execute the server must switch to the compiled output in the same commit.

## What Task 2 actually needs

Beyond what the plan already lists:

- `tsconfig.server.json` with `noEmit: false`, `outDir: dist-server`, and `rootDir: .` so `shared/`
  lands beside `server/` in the output rather than above it.
- `pnpm test` must build first — the node project spawns a real hub, so `dist-server/index.js` has
  to exist before the suite runs. A `pretest` script, or a `globalSetup` that builds once.
- `test/helpers.js`: `SERVER` becomes `dist-server/server/index.js`.
- `test/cli.test.js`: the CLI path it spawns moves the same way.
- `bench/*.mjs` import `../server/git.js` directly — five files, same treatment.
- `e2e/global-setup.ts` imports `server/registry.js` and spawns `server/index.js`. Both move.

The build-before-test requirement is the part worth designing rather than discovering: it makes the
node suite depend on a compile step it has never needed, and a stale `dist-server/` would then let
tests pass against code that is no longer the source. Building in `globalSetup` rather than a
`pretest` script keeps that honest, at the cost of a second or two per run.

## Recommendation

Do Task 3 (`src/` to TypeScript) **first**. It has none of this: Vite already transforms everything
under `src/`, nothing spawns it, and `.jsx` files can become `.tsx` a few at a time with the browser
and e2e suites verifying each step. That banks most of the migration's value while leaving the one
genuinely coupled change — server plus packaging plus test harness — as a single deliberate commit.
