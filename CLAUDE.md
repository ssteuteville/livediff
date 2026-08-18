# LiveDiff

A local hub that shows the diff of a git worktree in a browser, collects review comments,
and hands them back to an agent through the CLI. See `docs/PRODUCT.md` for what it is for
and `docs/DECISIONS.md` for the choices that shape it.

## Scripts

Use `pnpm`, never `npm` or `yarn`.

| Command                     | Use it when                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`                  | Working on the UI. Vite, a watched hub, and a watched server build, together.  |
| `pnpm verify`               | Before handing anything over. Typecheck, lint, node tests, browser tests, e2e. |
| `pnpm build`                | Building both halves — `tsc -b` for the server, Vite for the client.           |
| `pnpm build:server`         | Only `server/` or `scripts/` changed and something needs the compiled output.  |
| `pnpm test`                 | Node tests. Rebuilds the server first via `pretest`.                           |
| `pnpm test:browser`         | Component tests that need a real DOM.                                          |
| `pnpm e2e`                  | Playwright. Builds fixtures and starts its own hub on a private port.          |
| `pnpm typecheck`            | Types only. Also emits `dist-server/`, which is easy to forget.                |
| `pnpm lint` / `pnpm format` | oxlint (warnings are errors) and oxfmt.                                        |
| `pnpm run docs:cli`         | After changing the command registry in `server/cli-help.ts`.                   |

### `pnpm run docs:cli`, not `pnpm docs:cli` … and never `pnpm docs`

`docs` is a **built-in pnpm command** that opens a package's documentation in a browser. It
shadows a script of the same name silently — no output, no error, exit 0 — so `pnpm docs`
regenerated nothing while `test/cli-docs.test.ts` kept failing on drift with no clue why.
The script is named `docs:cli` because pnpm has no built-in containing a colon, which makes
the collision impossible rather than merely documented. Do not rename it back.

### The build output is a real dependency of the tests

`test/helpers.ts` starts the hub from `dist-server/`, and `e2e/global-setup.ts` does the
same. `pnpm test` rebuilds first, but `pnpm vitest run <file>` does **not** — it will
happily test the previous build and report a pass for code you just changed. If a test
result surprises you, run `pnpm build:server` and try again.

Both spawn the hub with `stdio: "ignore"`, so a server that crashes on startup shows up as
a timeout rather than as the actual error. Run `node dist-server/server/index.js` directly
to see what it says.

## Layout

- `server/` — the hub, the CLI, and the git plumbing. `cli-help.ts` is the single registry
  every command's help, completion, flag parsing, and `docs/CLI.md` is generated from.
- `src/` — the React client. `FastDiff.tsx` is the virtualized renderer; the classic one is
  lazy-loaded because it pulls in about a megabyte of highlighter.
- `shared/` — types and constants both halves import.
- `test/` — node tests. `e2e/` — Playwright. `bench/` — fixture generators.

## Conventions

- Comments explain **why**, not what. JSDoc on public APIs and awkward types; skip it on
  internal helpers.
- React: no render functions (extract a component), Tailwind classes over `style`, and no
  nested ternaries — extract a named helper.
- TypeScript is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
  and `no-unsafe-type-assertion` is on. Parse and narrow rather than assert.
- Conventional Commits, scoped to the package: `fix(livediff): …`.

## Things that have bitten us

- **`git()` in `server/git.ts` swallows a non-zero exit** and returns whatever reached
  stdout. A bad ref therefore yields an empty diff and a clean result, not an error — it
  looks exactly like "nothing changed". Never infer that a ref is valid from a diff having
  loaded; ask `isValidRef`.
- **The diff and the staleness check must compare against the same thing.** `getDiff` and
  `changedPaths` both resolve through `mergeBase`. If they ever disagree, every comment in
  the worktree reads as stale.
- **A registry write is durable and shared.** Anything persisted there outlives the browser
  tab and is what the CLI and the background sweep see. Validate before storing.
