# `?ws=` deep links only work for the first workspace

**Found:** 2026-08-03, while writing the e2e navigation suite.
**Status:** open. Pinned by a `test.fail()` in `e2e/navigation.spec.ts`.

## What happens

Opening `http://localhost:4180/?ws=<id>` shows the **first** workspace in the registry, not the one
the id names — whenever the target is not already first. With four workspaces registered, a deep
link to the second showed the first: 1 changed file instead of 40.

Adding `&focus=1` makes it work.

## Why

Two effects in `src/App.jsx` race on mount, and the second wins.

```js
// 147: preselect from the URL
useEffect(() => {
  const ws = urlParams.get("ws");
  if (ws) setSelected(ws);
}, [urlParams]);

// 155: keep a valid selection as the workspace list changes
useEffect(() => {
  if (workspaces.length === 0) {
    if (!focused) setSelected(null);   // ← clobbers the line above
    return;
  }
  ...
  setSelected(workspaces[0].id);
}, [workspaces, selected, focused]);
```

On mount `workspaces` is still `[]`, because the fetch has not resolved. The URL effect sets the
selection; the guard effect immediately clears it. When the list arrives, `selected` is null, so it
falls back to `workspaces[0]`.

`?focus=1` avoids it because both branches of the guard return early when `focused` is true.

## Why it was never caught

Every manual test used one workspace, or the target happened to be first. The bug needs two
registered worktrees and a link to the non-first one — which is exactly the setup the e2e fixtures
create and nothing before them did.

## The fix, when someone takes it

Distinguish "no workspaces yet" from "workspaces loaded and empty". A `loaded` flag set by the first
successful `fetchWorkspaces`, gating the clearing branch, is the smallest change. Clearing a
selection because data has not arrived yet is the actual mistake.

Until then, `e2e/harness.ts` exposes `focusUrl()` and every e2e test uses it.
