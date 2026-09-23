# npm distribution and agent setup implementation plan

Status: implementation plan only; no setup functionality or publication has been implemented by this document.

**Goal:** Deliver the one-command installation, agent integration, cmux configuration, repair, and update experience in the [approved specification](../specs/2026-09-23-distribution-and-setup-design.md).

**Approach:** Keep the CLI dispatcher thin. Add a setup coordinator with small modules for npm installation, prerequisites, owned state, prompts, browser configuration, and native/portable adapters. Reuse configuration, atomic writes, command metadata, and test fixtures. Build/test locally with pnpm; use npm for the consumer installation and release channel.

## Execution boundaries

- Implement in an isolated worktree. Preserve the spec and other existing work; do not execute this plan in the primary `dev-claude` checkout. Verify the remote default before creating a new worktree or PR.
- No registry publication, stable-source promotion, changes to the developer's live agent installations, or global package replacement as an incidental test. Use temporary HOME/XDG/npm prefixes and disposable harness profiles for verification. If a harness cannot isolate its profile, stop that live check and report the limitation.
- Prefer `const`, named helpers, and early returns; no nested ternaries or unnecessary comments. Use subprocess argument arrays, never interpolated shell commands.
- Do not create a general-purpose installer framework, action language, plugin runtime manager, or second authoritative browser setting. Add modules only for boundaries actually needed by this flow.
- Use concrete behavior tests for setup's external effects. Do not add tests that merely repeat implementation constants. External registry/harness tests are distinct from mocked adapter tests.
- Source review is required before committing implementation. Review the terminal UX in a PTY; if browser behavior is changed, verify it with the appropriate browser tooling and actual cmux where available.

## Dependency order and delegated ownership

```text
1. Confirm external capabilities and stable release sources
2. Establish distributable artifact and Node 22 compatibility
3. Define setup contracts, command registration, and state
4. Implement persistent npm installation and verification
5. Implement prerequisites and guided terminal UX
6. Add native and portable agent integrations
7. Package cmux behavior and configure it through setup
8. Complete repair, updates, and doctor
9. Add release automation
10. Document and verify the complete user journeys
```

Tasks 1 and 2 can run in parallel. Task 3 can proceed while their external checks finish. Task 4 depends on Tasks 2–3; Tasks 5–7 depend on the Task 3 contracts, with their complete flows requiring Task 4. Task 8 joins Tasks 4–7. Task 9 follows the artifact/source decisions and can be prepared alongside Task 8. Task 10 is the final integration gate.

When implementing with agents:

| Owner                     | Responsibility                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Main implementer          | Setup contracts/coordinator, npm persistence, ownership/state/locking, prompts, update handoff, integration and final acceptance |
| Agent integrations worker | Native adapters, portable skill content/adapter, their focused tests, external capability evidence                               |
| cmux worker               | Packaged cmux opener, browser setup adapter, saved-config inspection, source-script delegation, focused tests                    |
| Release worker            | Artifact inspection/runtime smoke runner, CI matrix, version synchronization, release workflow                                   |

Stagger workers to available concurrency. Establish contracts before parallel edits. Workers must know they share the codebase, must not revert others' edits, and must coordinate edits to shared `package.json`, lockfile, CLI registry, and docs. The main implementer integrates those shared-file changes.

## Task 1 — Resolve external capability and release-source gates

**Files:** add `docs/DISTRIBUTION.md` as the maintained installation/support reference; update it with verified facts throughout implementation. Do not maintain a second competing spec.

- [ ] Inspect supported Claude/Codex versions and record native install, inspection, conflict detection, update, and version-verification commands.
- [ ] Prove the Codex installed-plugin upgrade path in an isolated profile. A successful marketplace refresh is insufficient. If no supported verifiable upgrade is available, record that capability as unavailable and design the adapter to report it honestly.
- [ ] Confirm npm package ownership/name and integration-repository accessibility. Read-only availability checks do not claim or publish a package.
- [ ] Verify how both harnesses accept a stable Git source/ref. Prefer a release-only source containing both catalogs and their relative plugin directories; validate a release branch/ref approach before choosing exact syntax. Do not register a development branch as the stable release channel by accident.
- [ ] Verify the pinned skills installer supports the selected source, exact skill selection, user scope, update ownership, and all four agent IDs.
- [ ] Record tested host versions/platforms and unresolved capabilities. Mark integration support as verified only after Task 10's workflow checks.

**Done when:** adapter commands, source/ref syntax, and ownership rules have evidence sufficient to implement. Unresolved external capabilities are explicit gates, not invented commands. Do not block unrelated core work while waiting on a gate.

## Task 2 — Prove the npm artifact and Node 22 runtime

**Files:** `package.json`, `pnpm-lock.yaml`, `install.sh`, `.github/workflows/ci.yml`; new `scripts/check-package.ts` and `scripts/smoke-package.ts`.

- [ ] Audit the package allowlist and runtime imports. Preserve required `jsonc-parser`, UI assets, schemas, and package metadata. Do not broaden this into dependency cleanup without a demonstrated packaging benefit.
- [ ] Build on Node 24, pack once, and install that artifact into an isolated npm prefix from outside the checkout. Inspect the tarball for missing runtime assets, unwanted developer files, and consumer lifecycle scripts.
- [ ] Make the smoke runner execute the installed CLI with isolated configuration and a disposable Git repository. Exercise hub startup, HTTP assets/schema access, comments/lenses persistence, shutdown, and restart. Always clean up test processes.
- [ ] Run that same artifact on the selected Node 22 floor and Node 24 on macOS/Linux. Select a concrete patched Node 22 minimum from passing evidence. Keep `.node-version` and build tooling on Node 24.
- [ ] Only after the runtime matrix passes, change consumer engine declarations and the source installer's version check consistently. Add accurate package/repository/publish metadata once the package identity is confirmed.
- [ ] Keep publication disabled while packaging is unfinished. Removing `private` is part of final release readiness, not proof that publication is authorized.

**Verification:** the consumer can install and run without pnpm, TypeScript/Vite, source checkout, or Lefthook. Do not try to run the entire developer toolchain on Node 22 to establish consumer compatibility; exercise the built artifact there.

## Task 3 — Add setup command contracts and ownership state

**Files:** modify `server/cli.ts`, `server/cli-help.ts`; create `server/setup/index.ts`, `options.ts`, `types.ts`, `state.ts`, and `lock.ts`. Regenerate `docs/CLI.md`. Tests: `test/setup-options.test.ts`, `test/setup-state.test.ts`, existing CLI/help/docs/completion tests.

- [ ] Define the small request/result types: selected aliases, browser choice, CLI-only/update/yes intent, component outcomes, installed version/source identity, and targeted retry details.
- [ ] Register `setup` and its flags through the existing command registry so help, machine-readable descriptions, completion, and generated docs stay aligned.
- [ ] Parse repeatable `--agent` values with `flagValues(RAW_ARGV, "--agent")`; the existing parsed-value map retains only the last occurrence. Normalize/deduplicate aliases and reject conflicts before any mutation.
- [ ] Dispatch setup without repository resolution, `ensureHub()`, or browser opening. Keep implementation outside the large `cli.ts` module.
- [ ] Store a versioned setup ownership record under existing `configDir()` using `writeJsonAtomic`. Record live-verified successes per component; keep browser preference authoritative in existing configuration only.
- [ ] Add a separate PID-owned setup lock with exclusive acquisition, owner verification, and safe interruption cleanup. Do not reuse the hub's fixed lock or its 30-second age heuristic for long npm operations. Never remove another live setup's lock based on age alone.
- [ ] Keep adapter boundaries narrow: inspect, choose required actions, apply, verify. Use injectable subprocess execution and prompts for tests; do not create a general workflow engine.
- [ ] Preserve exit conventions: invalid usage is 2, requested installation failure is 1, successful/explicitly skipped optional work is 0. Cancellation must not report success. Keep progress on stderr and support the existing CLI JSON mode with a structured summary and no interactive prompts.

**Verification:** repeated flags, invalid flags, conflicting selections, non-TTY behavior, atomic state, concurrent invocation, interrupted owners, partial state recovery, and no repository/hub/browser side effects.

## Task 4 — Install the persistent CLI through npm

**Files:** new `server/setup/npm.ts`, `server/executable-path.ts`; modify coordinator. Tests: `test/setup-npm.test.ts` and shared fake-executable fixtures where useful.

- [ ] Resolve the executing package's actual name/version and whether it is temporary or persistent. Do not hardcode an unscoped npm name.
- [ ] For temporary invocation, install exactly the executing release into npm's configured global prefix. Reuse an existing installation only when its verified package identity/version matches the intended release.
- [ ] Inspect npm's supported global package/prefix commands; do not depend on removed npm CLI subcommands or assume one fixed filesystem layout.
- [ ] Verify package identity, executable realpath, version, and ordinary-shell PATH resolution independently. Exclude only positively identified npm-exec temporary PATH entries. Do not strip legitimate project `.bin` directories indiscriminately.
- [ ] Detect collisions, permission failures, and a missing global-bin PATH entry. Provide specific remediation; do not uninstall competing packages, change npm prefixes, edit shell startup files, or invoke `sudo` automatically.
- [ ] Return verified persistent runtime/helper locations for adapters. Never configure a harness or browser with the temporary npx package path.

**Verification:** exact-version bootstrap, newer/older existing globals, scoped names, npm prefix errors, npm/pnpm PATH collisions, temporary PATH shadowing, paths with spaces, and running the installed command after temporary npm execution ends. Use real local tarballs with isolated prefixes in addition to subprocess fixtures; no developer-global installs.

## Task 5 — Implement prerequisite checks and the guided UX

**Files:** new `server/setup/prerequisites.ts`, `prompts.ts`, and `process.ts` if a shared executor is warranted; modify coordinator and package/lockfile for the prompt dependency. Tests: `test/setup-prerequisites.test.ts`, `test/setup.test.ts`.

- [ ] Use a small prompt library for the specified multiselect/select/cancellation behavior rather than writing a terminal widget framework. Evaluate and pin a published `@clack/prompts` release, checking its full runtime dependency tree on the chosen Node 22 floor. Keep the library behind a narrow prompt boundary.
- [ ] Detect Node/npm, Git, selected harness capabilities, cmux executable availability, and optional `gh` authentication using read-only checks. Editor executable detection is a useful hint, not the only way to select an editor integration.
- [ ] Show detected harnesses first but configure only confirmed selections. CLI-only is mutually exclusive. Explicit flags suppress answered questions; preserve existing choices on reruns.
- [ ] Ask about the browser only for a fresh preference when supported cmux is available. Delegate actual browser configuration to Task 7.
- [ ] For missing Git/`gh`, offer a concrete command through an already installed, supported OS package manager. Run it only after explicit selection. Otherwise provide instructions and a resume command. Do not install package managers or elevate privileges silently.
- [ ] Offer native `gh` login interactively when selected; never read tokens. Distinguish skipped optional PR support from failed requested work. Document separate Git credentials and repository/organization access checks.
- [ ] Implement `--yes` and non-TTY behavior exactly as specified; neither silently authorizes prerequisite installs or auth. Ensure output works without color and progress names the current operation.
- [ ] Summarize verified CLI and integration versions, browser preference, restart requirements, skipped features, failures, and one first-use instruction. Do not launch a review.

**Verification:** use a PTY to walk through first install, multi-select, cancellation, missing Git/`gh`, no cmux, no color, explicit flags, and optional-skip behavior. Scripted prompt responses test branching; the PTY walkthrough validates actual usability.

## Task 6 — Add native adapters and the portable skill

**Files:** create `server/setup/adapters/claude.ts`, `codex.ts`, `skills.ts`, and a small adapter selector; add `plugins/livediff/skills/livediff/SKILL.md` and contained `references/`; adjust existing native skill references and both catalogs/manifests only where needed. Tests: `test/setup-integrations.test.ts`, `test/plugin-packaging.test.ts`.

- [ ] Implement native inspection/conflict handling/installation/version verification using Task 1's commands. Reuse healthy registrations. Treat same-name local developer marketplaces as conflicts requiring deliberate migration, not permission to replace them.
- [ ] Keep Codex upgrade support conditional on the proven installed-plugin procedure. Report unverified/unavailable outcomes without pretending a catalog refresh updated the plugin.
- [ ] Create a self-contained portable `livediff` skill. Supporting references must remain inside that directory so targeted installation includes them.
- [ ] Share workflow guidance with native skills while preserving existing native command names. Remove Claude-only inline execution and command references from portable guidance; keep destructive-action confirmation explicit.
- [ ] Pin the verified skills installer and use the exact owned skill, stable source, user scope, and selected target IDs. Install no duplicate loose skills into native Claude/Codex targets.
- [ ] Record shared canonical skill ownership. Before a targeted update affects additional harnesses, disclose and obtain acknowledgement; with `--yes`/non-TTY, require every affected agent explicitly selected.
- [ ] Enforce the release's CLI compatibility range. Integrations invoke the shared persistent `livediff`, not independently pinned `npx` runtimes.
- [ ] Extend packaging checks to verify referenced resources actually ship, version/source metadata agrees, and native/portable targets remain discoverable. Do not mistake these checks for live harness verification.

**Verification:** fixture tests cover no-op reruns, local-source collisions, auth/network errors, partial success, unknown installed versions, compatibility mismatch, and shared update effects. Actual harness install/update and review workflows are Task 10 gates.

## Task 7 — Package cmux behavior and reuse it from setup

**Files:** create `server/cmux-open.ts` with a runnable compiled entry and `server/setup/browser.ts`; modify `server/config.ts`, `scripts/cmux-browser-setup.sh`, and `scripts/livediff-cmux-open` to delegate; tests in `test/cmux-open.test.ts`, `test/setup-browser.test.ts`, and existing config tests.

- [ ] Move the existing workspace-selection behavior into one Node implementation: selected workspace, then inherited `CMUX_WORKSPACE_ID`, then cmux's default. Keep focus enabled and URL arguments separate.
- [ ] Compile the helper under `server/`, which already ships in the npm allowlist. A helper under `dist-server/scripts` would currently be excluded.
- [ ] Configure `browser.opener` with argv containing the persistent Node executable and compiled helper path. This avoids a new copied shell shim and its extra PATH requirement. Verify those paths survive normal npm updates; detect/repair changed version-manager installations on rerun.
- [ ] Add a narrow saved-browser inspection function to distinguish stored preference from the effective environment-overridden value. Reuse existing set/unset configuration functions.
- [ ] Skip the fresh browser question when cmux is absent; preserve stored custom preferences on reruns. Explicit unavailable `--browser cmux` is a failure. Explicit system choice removes the custom opener and reports any environment override.
- [ ] Recognize the old LiveDiff-owned shim without deleting arbitrary files. Migrate configuration only when requested. Source scripts delegate to the common implementation; do not leave two workspace-selection algorithms.
- [ ] Preserve opener-failure behavior: report and print the URL, without an automatic second browser launch. Setup performs no test-pane opening by default.

**Verification:** fake cmux executable covers workspace precedence, malformed listings, missing commands, focus, URL argument handling, and failure. Actual macOS cmux checks must prove selected-workspace behavior despite stale hub environment. Test absent-cmux prompts, saved/environment preference precedence, and helper validity after an isolated npm upgrade.

## Task 8 — Finish reconciliation, coordinated updates, and doctor

**Files:** coordinator/state/npm/adapters; `server/doctor.ts`; new `test/setup-update.test.ts` and focused doctor tests.

- [ ] Reconcile actual installed state on reruns, using recorded ownership only as a guide. Preserve unselected integrations, unrelated marketplaces/skills, custom preferences, and user edits. Verify and record each component independently.
- [ ] Implement `--update`: resolve the npm target once, install/verify it, then continue integration work using the new persistent CLI. Use a bounded internal continuation mechanism, not recursive public `--update` calls.
- [ ] Define lock ownership across parent/child handoff. Test that the handoff cannot deadlock, allow simultaneous mutations, replay a stale continuation, or leave a permanent lock. Keep credentials out of continuation data.
- [ ] Preserve selected targets/browser choices through the handoff. Do not claim complete version pinning for independently resolved plugin sources.
- [ ] Extend doctor with shared read-only inspection of prerequisite readiness, persistent executable, recorded adapters, actual installed versions, and stale owned opener paths. Replace the current highest-cached-Claude-version heuristic for setup health.
- [ ] Reuse executable-path inspection instead of doctor's `sh`/`sed` PATH probe where this change applies. Do not turn doctor into an automatic installer.
- [ ] Produce targeted retries after interruption or component failure. Do not remove successful integrations as an assumed rollback.

**Verification:** fresh setup → no-op rerun → add agent → delete one owned integration → repair → CLI/plugin update → partial failure/retry. Include hub data preservation and prove ordinary use performs the expected version restart without setup itself unnecessarily restarting the hub.

## Task 9 — Automate release assembly and publication readiness

**Files:** `package.json`, both native manifests, both catalogs, `scripts/release-version.ts`, one shared release metadata file, `.github/workflows/release.yml`, CI artifact job, `docs/DISTRIBUTION.md`.

- [ ] Keep one product version initially. Add a focused script that updates/checks package and native plugin versions and the declared compatible CLI range. Derive release values from one source; avoid scattered hardcoded version strings.
- [ ] Choose the smallest release mechanism that prepares a reviewable version/changelog change. Use release-please only if configured commit parsing matches the repository's actual conventions; otherwise explicit release input plus synchronized metadata is sufficient for MVP.
- [ ] Build and validate one immutable tarball, then publish that exact file. Do not rebuild a different package during the publish step. Attach or retain artifact identity for verification.
- [ ] Configure GitHub-hosted npm trusted publishing with a compatible npm CLI. Keep developer pnpm usage separate from the actual npm publish operation. Document account-side bootstrap requirements without embedding credentials.
- [ ] Sequence release as artifact validation → authorized npm publication → registry version/integrity verification → compatible stable Git integration-source promotion. Failure before registry verification must not advance stable catalogs.
- [ ] Validate source-relative plugin paths in the promoted source. Document recovery when npm succeeds but source promotion fails; do not try to republish the immutable npm version.
- [ ] Include a dry-run/artifact-only path. Keep the publishing/promotion boundary explicitly gated and do not run it as part of implementation acceptance.

**Verification:** exercise artifact assembly and metadata checks without publication; verify failed or unauthorized runs cannot promote sources. Actual first publication and stable-source promotion require separate release authorization.

## Task 10 — Verify complete journeys and finish documentation

**Files:** `README.md`, `docs/DISTRIBUTION.md`, `docs/CONFIGURATION.md`, command registry/help topics as needed, generated `docs/CLI.md`, docs index, acceptance evidence retained with the task/release.

- [ ] Make npm setup the consumer entry point; retain source installation under contributor instructions. Document the Node/npm prerequisite before the `npx` command.
- [ ] Include guided install, explicit agent/browser selection, multiple agents, adding an agent, CLI-only, missing `gh`, safe rerun/repair, and explicit updates. Show actual tested behavior rather than aspirational output.
- [ ] Explain user scope, shared browser preference, shared portable-skill updates, native update ownership, and limits on historical plugin pinning. List verified platforms/harnesses and minimum versions.
- [ ] Regenerate command documentation rather than hand-editing it. Extend existing docs drift checks only where new registry behavior requires it.
- [ ] Run the clean packed-artifact matrix and the scenario checks below. For each advertised harness, verify discovery, opening the intended repository, review waiting/completion, feedback retrieval/reply, and destructive confirmation.
- [ ] Have an independent reviewer compare implementation and observable behavior against the approved spec. Resolve concrete correctness/compatibility issues; do not expand into unrelated cleanup.

| Acceptance scenario    | Required evidence                                                         |
| ---------------------- | ------------------------------------------------------------------------- |
| npm first install      | Persistent CLI works outside source tree and temporary npx PATH           |
| Node/platform support  | Same packed artifact passes chosen Node 22 floor/24 on macOS/Linux        |
| No cmux                | No browser prompt/config change on fresh installation                     |
| Existing configuration | Custom opener and environment override remain correctly distinguished     |
| Multiple agents        | Only selected integrations configured; one shared CLI                     |
| Portable updates       | Shared effects disclosed; unrelated skills untouched                      |
| Native updates         | Actual installed version inspected; catalog-only success rejected         |
| Failure and retry      | Component outcomes truthful, completed work preserved, retry targeted     |
| Update handoff         | New CLI runs remaining setup once; lock ownership and state remain sound  |
| cmux                   | Correct selected workspace/focus with stale inherited hub context         |
| No GitHub CLI          | Local review usable; PR support clearly unavailable/skipped               |
| No unintended actions  | No repository mutation, review launch, or test-pane creation during setup |

## Verification commands and cadence

Install developer dependencies when preparing the implementation worktree. Run every shell command separately. Use focused tests after each behavior change, then full gates once at integration completion unless a failure or later change warrants repeating them.

```sh
pnpm install --frozen-lockfile
pnpm build:server
pnpm exec vitest run --project node test/setup-options.test.ts test/setup-state.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:browser
pnpm e2e
git diff --check
```

The focused test paths above are introduced by Task 3; substitute the relevant task's tests during development. Browser checks need the repository's Playwright browser installation. Register separate package-inspection/smoke scripts as Tasks 2 and 9 are implemented, and run those in isolated environments as part of the final gates.

Do not publish npm packages, promote Git refs, or alter live agent installations to make verification pass. Report environment-limited checks explicitly.

## Completion and release handoff

Implementation is complete when the supported setup paths satisfy the spec, package/runtime checks pass, and documentation reflects verified capabilities. An unavailable external capability must remain explicitly gated; do not call the affected feature complete based on mocked tests.

The handoff should contain the final diff, checks performed and remaining environment limitations, package identity, supported runtime/harness matrix, artifact identity, and the exact pending release actions. Committing, merging, publishing, and stable-source promotion follow the user's authorization separately.

## Supporting references

- [Approved distribution and setup spec](../specs/2026-09-23-distribution-and-setup-design.md)
- [Clack prompt package metadata](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/package.json) — a suitable candidate whose published version and transitive runtime requirements must still be validated.
- External npm, harness, skills, and cmux sources are collected in the spec; Task 1 verifies the exact versions and commands used by implementation.
