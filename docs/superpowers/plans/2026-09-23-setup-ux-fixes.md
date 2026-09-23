# Fix doctor diagnostics and setup retry commands

Status: ready for implementation; this branch contains the plan only.

**Goal:** A clean Linux installation should pass doctor's executable check, and setup failure messages should offer a retry that preserves the user's version and choices.

**Baseline:** verified against `main` at `d0ec5fc` and the published `livediff@0.12.0-rc.2` artifact. Both issues were reproduced in disposable Debian Docker containers. Refresh the target branch before implementation and confirm the fixes have not already landed.

## Scope

Implement only these two fixes:

1. Replace doctor's shell-output parsing with the existing executable lookup.
2. Preserve relevant public setup arguments and the pinned package version in bootstrap, prerequisite, and interruption retry commands.

Do not change shared portable-skill placement, native plugin behavior, cmux integration, release automation, update policy, or the existing `--update --yes` contract. Do not publish a release or change real user installations as part of this task.

## Confirmed failures

### Doctor reports two installations when only one exists

In a clean Node 24 Debian container, install rc.2 and run doctor:

```sh
docker run --rm -it node:24-bookworm bash
npx --yes livediff@0.12.0-rc.2 setup --cli-only --yes
livediff doctor --json
```

The last command exits 1 and includes:

```text
livediff resolves to more than one binary
/usr/local/bin/livediff
a tracked alias for /usr/local/bin/livediff
```

`server/doctor.ts` parses `sh` output from `command -v` and `type`. Debian's shell describes a tracked alias; that description becomes a second apparent path. Doctor then recommends removing a stale installation even though no second installation exists.

### Retry changes the failed operation

An ordinary user without write access to npm's global prefix can reproduce the bootstrap failure:

```sh
docker run --rm --user node --env HOME=/home/node node:22.12.0-bookworm npx --yes livediff@0.12.0-rc.2 setup --cli-only --yes --json
```

The permission explanation is appropriate, but the emitted retry is:

```sh
npx livediff@latest setup
```

That drops the version, selected targets, and unattended/output choices. After permissions are fixed, the retry can select another release or fail for missing noninteractive selection. Missing-Git guidance similarly emits bare `livediff setup`.

## Task 1 — Correct doctor's PATH inspection

**Files:** `server/doctor.ts`, `test/doctor.test.ts`; use `server/executable-path.ts` without changing its general semantics unless the regression requires it.

- [ ] Add a controlled-PATH regression test before changing the implementation. Invoke doctor with the Node executable directly so the test does not depend on the host shell's command lookup.
- [ ] Replace `checkPath`'s shell command and text parsing with `findExecutables("livediff", userPath(env))`, following the existing setup convention. Preserve actual executable resolution order and current missing/duplicate diagnostic meanings.
- [ ] Remove subprocess/promisify imports that become unused. Do not add a second PATH resolver or parse another shell's output.
- [ ] Keep diagnostics useful when two genuinely distinct executable paths exist. Do not suppress all duplicate warnings to make the clean-container test pass.

**Focused cases:**

- Exactly one executable: one installation, no duplicate error.
- Repeated PATH directory: still one installation.
- Two different executable paths: retain the duplicate diagnostic and show actual paths.
- No executable: preserve existing missing-installation guidance.
- npm-exec temporary PATH entries: reuse the resolver's existing filtering, without dropping ordinary user entries.

The current `test/doctor.test.ts` clean-install check inherits host PATH, so it does not reproduce Debian's shell behavior. Keep a real clean-Debian artifact check in final verification; a mocked string alone is insufficient.

## Task 2 — Build retry commands from typed public setup intent

**Files:** introduce `server/setup/retry.ts` if a shared helper is needed; update `server/setup/npm.ts`, `server/setup/prerequisites.ts`, `server/setup/index.ts`, and narrowly affected types/call sites. Add `test/setup-retry.test.ts`; extend existing npm/prerequisite/setup tests at their output boundaries.

**Current producers to inspect:**

- `server/setup/npm.ts`: `setupRetryCommand` and npm bootstrap/verification failures.
- `server/setup/prerequisites.ts`: missing-prerequisite retry construction.
- `server/setup/index.ts`: `run.retry`, interruption outcomes, and failed-required-CLI outcomes.

- [ ] Define one small renderer from package identity, invocation mode, and validated public setup request to a copyable retry command. Preserve a scoped package name and prerelease version; do not replace a known executing version with `latest`.
- [ ] For a temporary bootstrap, use pinned npm execution. Include npm's own noninteractive confirmation option when producing an unattended bootstrap retry; distinguish it from setup's separate `--yes` flag.
- [ ] For an existing persistent CLI, retain `livediff setup` and the relevant public arguments. Do not force every ordinary retry to reinstall through npm.
- [ ] Preserve all selected `--agent` values or `--cli-only`, explicit browser choice, `--yes`, and `--json`. Preserve `--update` only when that retry still needs to perform the requested update; after a verified update handoff, do not reintroduce another update loop.
- [ ] If interactive selection has completed before failure, retain the confirmed choices available in the setup request/context. Do not invent a choice that the user never made.
- [ ] Render a narrow allowlist of public flags. Never forward raw internal continuation arguments, operation tokens, credentials, environment assignments, or unrelated CLI arguments.
- [ ] Use appropriate shell quoting for displayed argument values. Execute subprocesses using argv arrays; the rendered command is guidance, not a shell-execution mechanism.
- [ ] Wire the helper through bootstrap, prerequisite, and interruption failures so JSON `retry` and human guidance agree. Preserve existing error descriptions and exit codes.
- [ ] Keep existing integration-specific retries limited to their failed target. Do not expand this fix into reinstalling all successful integrations on every adapter error.

Do not reuse `continuationArgs` as-is: it currently adds `--update` for the internal handoff. A user-facing retry has different semantics.

**Representative expected bootstrap retry:**

```sh
npx --yes livediff@0.12.0-rc.2 setup --cli-only --yes --json
```

Flag ordering can differ; preserved intent and correct quoting are the contract.

**Focused cases:**

- Pinned prerelease + CLI-only + unattended JSON preserves every relevant value.
- Scoped package name remains correctly pinned.
- Two agents and an explicit browser choice survive bootstrap failure.
- Missing Git after explicit selection produces a usable noninteractive retry.
- Cancellation/failure after confirmed interactive choices retains those choices where known.
- Plain setup retry does not acquire `--update`; an unfinished explicit update preserves its intent; post-handoff retry cannot recursively update.
- Internal handoff fields never appear in user-visible text.
- Integration-specific retries remain targeted and unrelated success results remain unchanged.

Verify at least one emitted command by executing it against an isolated fixture after removing the original failure condition, not just by comparing strings. Use the local built artifact/fixture package mapping for this test; do not mistake rerunning the unfixed published rc.2 for verification of the patch.

## Delegation and integration order

- A doctor worker can own Task 1's two files and focused regressions.
- A setup worker can own Task 2's helper, setup call sites, and related tests.
- The main implementer owns the final diff review and packed-artifact Docker verification.

The two fixes can proceed independently. Tell workers they share the codebase and must not revert each other's changes. Keep any shared fixture edits coordinated. No browser UI or agent-configuration changes are needed.

## Verification and completion

Run shell commands separately. Install development dependencies if needed, build server output, then run the focused suite:

```sh
pnpm install --frozen-lockfile
pnpm build:server
pnpm exec vitest run --project node test/doctor.test.ts test/setup-retry.test.ts test/setup-npm.test.ts test/setup-prerequisites.test.ts test/setup.test.ts test/setup-cli.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm package:check
git diff --check
```

`test/setup-retry.test.ts` is created by this plan. Adjust only if the same coverage belongs in an existing test module. No full browser suite is required for these two CLI-only changes unless implementation expands into browser code.

- [ ] Pack the fixed checkout into a local tarball. Copy only that generated artifact into disposable Docker containers; do not mount the user's home, repository, npm config, or credentials.
- [ ] On Node 24/Debian, install the local tarball and verify doctor's executable check is clean. Introduce a genuinely second executable in the container and verify duplicate detection still works.
- [ ] On Node 22.12.0, verify the fixed package runs and that an isolated unwritable npm prefix produces preserved retry arguments. Verify the retry after making only the container's test prefix writable, with no host changes.
- [ ] Exercise both human output and JSON; verify exit 1 remains an actionable failure and successful retry exits 0 without unexpected prompts.
- [ ] Remove the test containers and retain concise reproduction/results evidence.
- [ ] Run the required code review before committing the implementation. Sweep new comments and keep the fix bounded.

Completion means both reproduced defects are fixed and independently verified in the built artifact. Deliver a short handoff stating the tested artifact, cases passed, any remaining limitations, and the two bug fixes. Leave shared-skill duplication deferred. Version bumps, npm publication, and stable-source promotion require separate release authorization.
