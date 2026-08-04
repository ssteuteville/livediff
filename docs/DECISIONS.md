# Decisions

These are the durable choices that shape LiveDiff. Detailed implementation history is intentionally left in Git history.

## CLI-first integration

**Decision:** The CLI is the primary integration surface; editor and agent plugins provide skills, not a required service API.

**Why:** Any shell-capable agent can use the same commands as a human. This avoids permanently loading an MCP tool for a local, authenticated-free binary and keeps integrations independent of a single agent platform.

**Consequence:** The CLI's structured output, help, suggestions, and exit codes are product interfaces. Claude Code and Codex plugin packages improve discoverability but do not own the workflow.

## One local hub, many worktrees

**Decision:** A loopback-only hub serves registered worktrees; CLI commands are HTTP clients and start the hub when needed.

**Why:** A single browser view can switch among worktrees while every CLI invocation sees the same registry and review state.

**Consequence:** The hub has explicit liveness, port-discovery, and migration behavior. It becomes dormant when no client is attached instead of exiting solely because a browser tab closed.

## JSON state with atomic writes

**Decision:** Persist workspace and comment data as JSON files, written atomically; do not use SQLite.

**Why:** The state is small, local, inspectable, and needs no schema runtime or database lifecycle. Atomic replacement prevents partial writes without changing the operational model.

**Consequence:** State lives outside reviewed repositories under platform configuration/state directories. Migrations are explicit and run when the hub starts.

## Local-only trust boundary

**Decision:** Bind the hub to loopback and treat the local machine as the trust boundary.

**Why:** LiveDiff handles local working-copy contents and needs no remote collaboration service.

**Consequence:** There is no authentication layer. Network exposure is intentionally out of scope.

## Comment lifecycle is explicit

**Decision:** Comments retain review context through source changes and move through visible lifecycle states rather than disappearing silently.

**Why:** A reviewer needs to know whether a comment is open, resolved, orphaned, archived, or eligible for pruning.

**Consequence:** Retention and pruning are deliberate user-facing behavior, with dry-run support and diagnostics rather than implicit cleanup.

## Performance favors useful review

**Decision:** Bound the amount of diff UI that is actively rendered and address avoidable server work before adopting more invasive virtualization.

**Why:** DOM node count, not parsing, is the limiting factor on very large diffs. Full virtualization complicates variable-height inline comments and browser find.

**Consequence:** Large-diff work proceeds from low-risk improvements—such as reducing unnecessary diff process spawning and constraining pathological minified lines—before more complex renderer changes.

## Type safety is a release gate

**Decision:** The project uses strict TypeScript, type-aware linting, formatting checks, and CI quality gates; warnings fail lint.

**Why:** The server, web app, tests, and package boundary share structured data. Static checks make migrations and refactors safer.

**Consequence:** New code must avoid `any`, preserve typed boundaries, and pass typecheck, lint, formatting, and relevant tests before release.
