---
name: prune
description: Show what livediff would delete from its comment archive, then clean it up.
disable-model-invocation: true
allowed-tools: Bash(livediff *)
---

If `.livediff` exists at the worktree root, read it and follow it before doing anything else.

!`livediff prune --dry-run`

Report exactly what would be deleted. If nothing would be, say so and stop.

Otherwise ask the user how much to keep before running anything. Never prune without
an answer — this is the only livediff command that destroys data.

Once they answer, run one of:

```bash
livediff prune --keep-days <n> --yes
livediff prune --all --yes
```
