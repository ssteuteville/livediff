# TypeScript Migration Pickup Plan

## Starting point

The working tree is clean on `main`. The existing migration plan remains the source of truth.
Five frontend files have already migrated: `src/api.ts`, `src/syntax.ts`, `src/main.tsx`,
`src/components/CommentComposer.tsx`, and `src/components/ReviewBanner.tsx`.

## Execution order

1. Define and migrate the discriminated diff-row model in `src/diff-model.ts`.
2. Migrate the remaining frontend consumers, starting with direct model consumers:
   `useVirtualRows`, `DiffSearch`, and `FastDiff`; then the remaining leaf components and `App`.
3. Migrate the server as one compiled `dist-server/` cutover, including its execution and package entry points. **Done 2026-08-04.**
4. Migrate the remaining node tests and benchmarks, then enable type-aware linting.

## Completed checkpoint — 2026-08-04

- All `server/` modules are TypeScript and compile to `dist-server/server/`.
- Package scripts, CLI bin, installer, runtime tests, e2e setup, and benchmark fixture generation use the compiled server.
- `typescript/no-explicit-any` is enforced as an error; warnings already fail the lint command.
- `pnpm verify` passed: 174 Node tests, 6 browser tests, and 17 E2E tests.
- The installer completed its build and `livediff doctor` reported "All good." Its global pnpm install attempt warned about a pre-existing store-version mismatch, but the existing global command remained runnable.

## Guardrails

- Keep the implementation uncommitted until the user requests a commit.
- Treat `any` as disallowed: use concrete types, or `unknown` with runtime narrowing for untrusted data.
- Preserve behavior with focused tests before each migration group and run the relevant verification after it.
- Do not treat `cli.test.js` failures as a code regression until checking for a stray `server/index.js` process holding the hub port.
