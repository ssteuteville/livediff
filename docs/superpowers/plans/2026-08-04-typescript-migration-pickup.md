# TypeScript Migration Pickup Plan

## Starting point

The working tree is clean on `main`. The existing migration plan remains the source of truth.
Five frontend files have already migrated: `src/api.ts`, `src/syntax.ts`, `src/main.tsx`,
`src/components/CommentComposer.tsx`, and `src/components/ReviewBanner.tsx`.

## Execution order

1. Define and migrate the discriminated diff-row model in `src/diff-model.ts`.
2. Migrate the remaining frontend consumers, starting with direct model consumers:
   `useVirtualRows`, `DiffSearch`, and `FastDiff`; then the remaining leaf components and `App`.
3. Migrate the server as one compiled `dist-server/` cutover, including its execution and package entry points.
4. Migrate the remaining node tests and benchmarks, then enable type-aware linting.

## Guardrails

- Keep the implementation uncommitted until the user requests a commit.
- Treat `any` as disallowed: use concrete types, or `unknown` with runtime narrowing for untrusted data.
- Preserve behavior with focused tests before each migration group and run the relevant verification after it.
- Do not treat `cli.test.js` failures as a code regression until checking for a stray `server/index.js` process holding the hub port.
