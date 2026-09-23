# npm distribution and agent setup

Status: proposed implementation specification. The setup commands below are target UX, not existing commands.

## Outcome

A developer with supported Node.js/npm can install a persistent LiveDiff CLI and integrate their chosen local coding agents with one command:

```sh
npx livediff@latest setup
```

The setup flow checks prerequisites, installs only selected integrations, optionally configures the existing cmux browser integration, and reports what is ready to use. It works outside a Git repository and does not require a LiveDiff source checkout, pnpm, or a build toolchain.

`livediff` is the proposed npm package name and existing executable name. Confirm registry ownership before publication; use a scoped package if necessary and update every installation example consistently. A scoped package can still expose the `livediff` executable.

## Scope and decisions

- npm is the only CLI distribution channel for MVP. Native plugin marketplaces continue to distribute integration files from Git; this does not introduce another CLI runtime distribution channel.
- One persistent CLI serves all selected harnesses. Plugins and skills do not download or launch separate CLI versions.
- Claude Code and Codex use the existing native plugin packages.
- Cursor, GitHub Copilot, Gemini CLI, and OpenCode use a shared portable `livediff` skill, after their workflows pass compatibility verification.
- CLI-only installation is a first-class choice.
- Default installation scope is per-user. Project-scoped integration installation is deferred.
- Target user runtime support is Node 22 and newer supported release lines, initially verified on Node 22 and 24. Node 24 remains the development/release-build baseline. Lowering the current `>=24` declaration requires passing packaged-runtime checks first; choose and document the tested Node 22 minor floor.
- Initial platform targets are macOS and Linux. Advertise a platform only after its package and setup checks pass. Native Windows support is deferred. Offer cmux only on platforms where its integration has been verified.
- No Homebrew tap, standalone binary, self-updater, remote service, or MCP server in MVP.

## Explicit UX targets

| Scenario                    | Required experience                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First installation          | One command; no source clone, build, manual marketplace registration, or separate cmux script                                                          |
| Agent selection             | One multi-select screen; detected agents appear first; selection controls all harness changes                                                          |
| Browser selection           | Ask only when cmux is available and no browser preference already exists                                                                               |
| No cmux                     | No browser question; a fresh installation uses the system browser                                                                                      |
| Existing browser preference | Preserve it, even if cmux is absent in the current terminal; report an unusable saved opener                                                           |
| Explicit flags              | Do not ask questions already answered by flags                                                                                                         |
| Additional agent            | Add the requested integration without resetting existing integrations or preferences                                                                   |
| Repeated setup              | Reconcile existing installation; do not duplicate registrations or reinstall healthy components unnecessarily                                          |
| Missing optional dependency | Explain the unavailable feature and let core setup finish                                                                                              |
| Failure                     | Identify the failed component, retain successful work, and provide a targeted retry                                                                    |
| Completion                  | Confirm a persistent CLI, identify each installed integration, state the browser choice and required agent restart, and show one first-use instruction |

On a healthy first installation, the required decisions are agent selection and, only if available, browser selection. GitHub PR support is an optional additional decision when `gh` is missing or not authenticated. No performance promise depends on registry/network download speed. Setup must show the current operation rather than appearing frozen.

Detection is not authorization to configure every detected application. The agent picker must require an explicit selection/confirmation; it must not silently select all installed agents. An empty selection offers CLI-only installation. CLI-only is mutually exclusive with agent selection.

Do not automatically open a repository, start a review, change branches, create worktrees, or launch a test browser during installation. Completion can suggest the next action without performing it.

## Command contract

| Command                                                     | Behavior                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npx livediff@latest setup`                                 | Guided persistent CLI installation and agent setup                                      |
| `npx livediff@latest setup --agent codex --browser cmux`    | Install the CLI and Codex integration; explicitly configure cmux                        |
| `npx livediff@latest setup --agent claude --browser system` | Install the CLI and Claude integration; use the system browser                          |
| `npx livediff@latest setup --agent claude --agent cursor`   | Configure both selected targets; ask only unanswered applicable questions               |
| `npx livediff@latest setup --cli-only`                      | Install the CLI without changing harness configuration                                  |
| `livediff setup --agent gemini`                             | Add or repair Gemini integration using the installed CLI                                |
| `livediff setup`                                            | Inspect and reconcile setup; preserve existing choices and offer additions/repairs      |
| `livediff setup --update`                                   | Explicitly update the npm CLI and recorded LiveDiff integrations, verifying each result |
| `livediff setup --update --agent cursor`                    | Update the CLI and Cursor's LiveDiff integration; disclose shared-skill effects         |

Public agent aliases are `claude`, `codex`, `cursor`, `copilot`, `gemini`, and `opencode`. Map these to each installer's actual identifiers. Reject unknown agents, conflicting flags, and invalid browser values before mutations.

`--browser` accepts `cmux` or `system`. It is a user-wide LiveDiff preference, affecting ordinary CLI use and every harness. Explicit `--browser system` removes the configured custom opener. If `LIVEDIFF_BROWSER` overrides the setting, explain that precedence rather than claiming the saved choice is currently effective.

Support `--yes` for unattended use only with explicit `--agent` selections or `--cli-only`. With no browser flag, preserve the saved preference or use the system default. `--yes` does not authorize prerequisite installation, interactive authentication, privilege elevation, or modification of unselected agents. Non-TTY execution without sufficient choices exits with usage guidance rather than waiting for input.

Running an explicitly versioned npm package installs that exact CLI version. MVP does not promise a historical matching plugin version unless the harness supports it and the release source is verified. Report independently resolved integration versions and enforce their CLI compatibility requirements. Full reproducible CLI-plus-plugin version pinning is deferred.

## Guided first installation

```text
$ npx livediff@latest setup

✓ Node.js supported
✓ Git available
✓ Claude Code and Cursor detected

Which agents should LiveDiff integrate with?
[x] Claude Code — detected
[x] Cursor — detected
[ ] Codex
[ ] GitHub Copilot
[ ] Gemini CLI
[ ] OpenCode
[ ] CLI only

Where should LiveDiff open? This applies to all your agents.
❯ cmux browser — detected
  System browser

Installing LiveDiff…
Installing Claude plugin…
Installing Cursor skill…

✓ LiveDiff installed and available on PATH
✓ Claude plugin installed
✓ Cursor skill installed
✓ Browser: cmux

Start a new agent session if required, open your repository, and ask:
“Use LiveDiff to review my changes.”
```

The checked entries illustrate user selections, not automatically authorized defaults. Success lines represent verified outcomes. The installed-version summary must distinguish the CLI version from plugin/skill versions or source revisions. A detected editor is not proof that its skill integration works.

When cmux is absent, omit its question entirely. When a browser preference already exists, show it in the summary without asking again; explicit flags can change it.

## Prerequisites and assistance

| Dependency       | Requirement                                                                   | Setup response                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js/npm      | Needed before `npx` can start; supported Node required for runtime            | Document this before the command; check the actual runtime and give upgrade instructions when executable                                   |
| Git              | Required for repository review; also used by Git-based integration installers | Check availability; explain remediation and stop before claiming core readiness                                                            |
| Selected harness | Required for its integration                                                  | Verify its native command or documented skill-install location; guide missing-harness installation without blocking other selected targets |
| `gh`             | Optional for PR URL/number lookup in the PR skill                             | Offer GitHub PR support setup; local Git reviews remain usable without it                                                                  |
| cmux             | Optional browser integration                                                  | Detect its executable; do not rely solely on inherited environment variables                                                               |

The npm entry point cannot bootstrap Node on a machine that lacks Node/npm. Do not imply otherwise. Installing LiveDiff must not change a user's project Node version, version-manager defaults, shell startup files, or system runtime.

For missing Git or `gh`, show an OS-appropriate installation command. Where a supported package manager is already installed, offer to run that specific command after the user chooses it. Do not install a package manager or silently escalate privileges. If installation needs privileged/manual action, leave the command with an exact resume instruction.

For GitHub support, check `gh auth status` and offer the native interactive login when needed. Never read or print access tokens. Authentication does not prove repository access; the PR workflow must still report repository/host access failures and any required organization SSO authorization. Git fetch credentials are separate from `gh` API authentication.

Skipped optional setup is a successful limited installation. A requested integration that failed is a partial failure, not success. The summary must make this distinction clear.

## Persistent CLI installation

1. Determine whether setup is running from a temporary npm invocation or an existing persistent installation.
2. Resolve the intended CLI release once. A temporary setup invocation installs the exact package version that is executing; do not resolve `latest` again midway through installation.
3. Install through npm using its configured global prefix. Reuse a healthy persistent installation only when it matches the intended version. Thus `npx livediff@latest setup` cannot silently retain an older CLI. Plain `livediff setup` reuses its current version and does not silently upgrade it.
4. Verify the installed executable and version independently of the temporary PATH injected by npm execution. A successful `npx` command is not proof that `livediff` works in the user's normal shell.
5. Detect conflicting PATH entries or permission failures and provide specific remediation. Do not automatically uninstall npm/pnpm installations, change npm's prefix, or invoke `sudo`.

The npm package includes built server JavaScript, browser assets, schemas, metadata required at runtime, and the cmux helper. Runtime dependencies must be accurately declared. Consumer installation must not invoke TypeScript/Vite builds, install developer hooks, or require pnpm. Lefthook remains contributor-only.

Keep `install.sh` as a documented source-development route. Its current behavior of removing global installations is not the model for public setup.

## Agent integration adapters

### Claude Code and Codex

Reuse the native manifests and shared skills already under `plugins/livediff`. Register a reachable Git-hosted marketplace rather than a source checkout that users must retain. Resolve the release source before publication; do not expose unreleased development changes as stable integrations.

Use the harness's native commands instead of rewriting its configuration files:

```sh
claude plugin marketplace add ssteuteville/livediff
claude plugin install livediff@livediff
```

```sh
codex plugin marketplace add ssteuteville/livediff
codex plugin add livediff@livediff
```

Detect existing marketplace registrations, including local developer registrations with the same name. Do not silently repoint them or delete an existing installation. Explain conflicts and offer a deliberate migration where supported.

Record and verify the actual installed plugin version. Claude marketplace auto-updates are not assumed enabled for third-party marketplaces. Setup does not change that preference unless explicitly chosen.

Codex marketplace refresh alone is not proof that the installed plugin updated. Validate a supported installed-plugin upgrade procedure against the supported Codex versions before promising it. If installed-version verification is unavailable, report that limitation and supported manual steps; do not print a successful plugin-upgrade result. Do not invent an update subcommand or assume remove/reinstall is a safe universal upgrade.

### Portable skill

Publish one discoverable skill named `livediff` with supporting reference material. It teaches opening a review, creating useful review context, retrieving/responding to comments, and using the CLI's own help. Reuse shared instructions rather than maintaining independent workflow implementations for each harness.

| Public setup alias | Skills installer target |
| ------------------ | ----------------------- |
| `cursor`           | `cursor`                |
| `copilot`          | `github-copilot`        |
| `gemini`           | `gemini-cli`            |
| `opencode`         | `opencode`              |

Use a verified version of the external skills installer with explicit source, skill name, selected agent targets, and user scope. The conceptual invocation is:

```sh
npx skills add ssteuteville/livediff --skill livediff --global --agent cursor
```

The implementation must pin/test the installer dependency rather than resolving an unbounded tool version for every operation. Native Claude/Codex plugin installation must not additionally install a duplicate loose skill. Never use wildcard skill/agent selection or update unrelated skills.

Remove dependence on Claude-only inline command execution and slash-command cross-references in portable instructions. Destructive-action confirmation must be stated in the workflow itself, not entrusted only to host-specific invocation metadata. Verify that review waiting/background execution survives the target harness's execution model.

A shared canonical skill may be linked into several harnesses. Record and disclose that updating this skill changes every LiveDiff installation referencing it; do not claim per-agent version isolation. If a targeted update would affect an unselected harness, list those harnesses and require acknowledgement before expanding the operation. In noninteractive mode or with `--yes`, stop that integration update and instruct the user to explicitly include all affected agents. Do not silently create independent copies to evade this check. If the installer cannot limit changes to the owned LiveDiff skill, do not use that operation.

### Other agents

CLI-only setup changes no harness configuration. Provide a copyable instruction to use `livediff` and consult its help. Do not edit arbitrary `AGENTS.md`, rules files, or project instructions automatically.

These integrations support local agents with access to the repository and CLI. Cloud agents do not gain access to the user's local hub or browser merely by installing a skill.

## cmux integration

Bring the behavior of `scripts/cmux-browser-setup.sh` and `scripts/livediff-cmux-open` into npm-installed setup. The script must not remain a separate onboarding step.

- On first setup, offer cmux only when its executable is available on a supported platform. Recommend it when detected, with the system browser as the other choice.
- With `--browser cmux`, missing cmux is an actionable configuration failure; do not silently ignore the explicit request.
- Package the helper and configure a persistent absolute executable path. Never save a path into a temporary npx cache or a source worktree.
- Preserve the helper's selected-workspace lookup. The workspace currently selected in cmux takes precedence over stale `CMUX_WORKSPACE_ID` inherited by the hub. Preserve the existing fallback to the inherited workspace, then cmux's default targeting when no workspace is resolved.
- Open with focus enabled. Check cmux's supported command availability without creating a test pane unless the user requests a test.
- Preserve XDG-aware configuration placement and the existing `LIVEDIFF_BROWSER` override.
- Reconcile an existing legacy helper configuration only when it is recognized as LiveDiff-owned and cmux configuration is requested; do not delete arbitrary executables or overwrite custom openers.
- Verify the saved opener remains valid after npm updates, including npm installations associated with a version manager. Report and repair stale owned paths when setup is rerun.

The source setup script should delegate to the same behavior once implemented. Maintain one implementation of workspace selection and configuration.

MVP retains the existing failure behavior when a configured opener fails: report the problem and provide the review URL. Automatic fallback to a different browser is deferred. This is distinct from choosing the system browser during fresh setup when cmux is absent.

## State, reruns, and failures

Record minimal setup ownership data alongside LiveDiff's existing per-user configuration: selected agents, adapter type, source identity, verified version/revision, installed paths, shared skill ownership, and last operation outcome. Use a versioned record and atomic writes. Do not store tokens or duplicate the existing browser preference in a second authoritative location.

Inspect live harness/package state on reruns; the record is a reconciliation aid, not proof that an installation still exists. Preserve unselected integrations, unrelated marketplaces, user-edited instructions, and custom browser settings. Detect owned-file modifications and explain them before replacement.

Perform read-only prerequisite and conflict checks before mutations. Serialize setup runs using a setup-specific lock; the existing hub lock is not a setup lock. Handle interruption with an actionable retry rather than leaving a permanent lock.

Verify and record each successful component independently. On partial failure, retain completed installations and identify exactly what failed. A retry should resume the missing work without duplicating healthy registrations. Do not report rollback unless it actually occurred.

Map usage errors, success, and installation failures into the existing CLI exit-code conventions. A requested component that fails must produce a nonzero result even when the CLI itself installed successfully. Progress and output must remain usable without color.

## Updates and release coherence

npm owns CLI installation and updates. The basic manual update remains:

```sh
npm install -g livediff@latest
```

`livediff setup --update` adds explicit coordinated integration updates. Resolve the target npm version, complete CLI installation, then run setup from the newly installed version so adapter behavior matches that release. Guard against recursive update invocation.

No silent background CLI updates or per-agent runtime downloads. Native plugin auto-update behavior is controlled by each harness and must be described accurately.

Release the CLI and plugin metadata under one product version initially, with an explicit supported CLI range for integration instructions. Integrations can update independently, so verify compatibility rather than assuming equal versions. On mismatch, show the required npm upgrade or supported integration remediation; do not force a CLI downgrade.

The existing hub restarts when an invoking CLI has a different version. Retain the shared-runtime design and verify upgrade/restart persistence. Do not create plugin-bundled runtimes that cause competing versions to replace the hub repeatedly. Setup itself should not restart a running hub unnecessarily; normal use applies the existing version transition.

Build a release workflow that synchronizes versions, validates the packed artifact, publishes through npm trusted publishing, and exposes compatible stable marketplace/skill sources. Publish the required CLI before making an integration that requires it discoverable. A failed publication must not advance stable integration metadata. Record exact artifacts/source revisions for recovery.

The release automation tool is an implementation choice; Changesets and release-please are suitable candidates. No production publication is part of implementing this specification without release authorization.

## Acceptance and verification

### Package and runtime

- A clean user can install the npm tarball and run LiveDiff without a checkout, pnpm, compiler, or developer hook installation.
- On the chosen Node 22 minimum and Node 24, verify server startup, UI assets, schemas, local Git review, comments/lenses persistence, and stop/restart. `--version` alone is insufficient.
- Perform clean package/setup checks on macOS and Linux. Do not infer Windows support from Node portability.
- Verify the persistent executable after temporary npm execution exits, including an npm version-manager installation and PATH collision.

### Setup UX

- First install succeeds with one entry command and only applicable decisions.
- No cmux means no browser question or cmux configuration on a fresh install.
- Existing browser settings survive reruns; explicit flags change them; environment overrides are disclosed.
- Explicit unavailable cmux is reported, without silently selecting another browser.
- Multiple selected agents share one persistent CLI; unselected harness configuration and unrelated skills remain unchanged. Shared LiveDiff skill updates affect additional harnesses only after explicit acknowledgement or selection of every affected target.
- Adding one agent and rerunning setup do not duplicate existing integrations.
- Missing Git blocks core readiness. Missing/skipped `gh` does not block local review. Failed requested components produce partial-failure output and targeted retries.
- Noninteractive execution never waits for an unanswered prompt or starts authentication unexpectedly.

### Integrations and upgrades

- In each advertised harness, a new session discovers LiveDiff, opens the intended repository, supports the review/feedback cycle, and preserves destructive-action confirmation.
- Verify actual installed native plugin versions after both install and update. Catalog refresh alone does not satisfy this check.
- Verify portable-skill discovery, update ownership, and shared effects across two selected agents.
- A CLI update preserves registry/review data and transitions the hub correctly on subsequent use.
- The packaged cmux helper focuses the selected workspace even when the hub inherited a different workspace ID, and survives npm updates.
- Network failure, authentication failure, permission failure, and cancellation leave a truthful resumable state without removing successful components.

## Release gates and deferred work

Resolve these before declaring the corresponding capability available:

1. npm package ownership/name and public or authenticated integration-source access.
2. Tested Node 22 minor floor and supported host/platform versions.
3. Stable release-source strategy for marketplace catalogs and portable skill downloads.
4. Verified Codex installed-plugin upgrade and version inspection procedure.
5. End-to-end verification of each additional harness; list unverified targets as unavailable/experimental rather than fully supported.

Deferred: native binaries, Homebrew/Windows package managers, automatic runtime installation, native Windows support, project-scoped integrations, managed uninstall, background auto-updates, fully pinned historical plugin bundles, automatic browser fallback, MCP, and remote/cloud-agent connectivity.

## References

- Current implementation: `package.json`, `install.sh`, `server/ensure-hub.ts`, `server/doctor.ts`, `server/open-browser.ts`, `scripts/cmux-browser-setup.sh`, `scripts/livediff-cmux-open`, and both native marketplace catalogs.
- [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Claude plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude plugin discovery and updates](https://code.claude.com/docs/en/discover-plugins)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Agent Skills specification](https://agentskills.io/specification)
- [Vercel skills tooling](https://github.com/vercel-labs/skills)
- [cmux browser commands](https://cmux.com/docs/browser-automation)
