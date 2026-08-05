# LiveDiff CLI “unicorn DX” brainstorm

**Status:** first implementation slice in progress; remaining ideas are deliberately retained below  
**Source snapshot:** LiveDiff 0.6.5, August 2026
**Scope:** the human and agent-facing CLI contract; no implementation decision is made here

## Implementation status — August 2026

This document remains the durable rationale and backlog, not a verbatim implementation plan. The
first slice now delivers the core P0/P1 contract:

- One typed command registry now owns names, aliases, flags, and positional arity for validation,
  help, and completion; handlers remain in the CLI by design.
- Canonical `open`, `hub`, `review`, and `link` commands while preserving the productive shorthands.
- Nested configuration help plus `config edit`, `unset`, `explain`, and schema refresh workflows.
- Schema-backed, atomic configuration drafts and editor precedence that is explicit in the CLI,
  documentation, and agent skill.
- `status` for a safe hub/config check, plus generated bash/zsh/fish completion with explicit
  install, status, and uninstall workflows. Startup-file activation is opt-in and marked for safe removal.
- State-aware completion for registered workspace paths and open/archived comment IDs, via hidden
  `__complete-workspaces`/`__complete-comments` commands that query a running hub and never start
  one — so a cold shell never blocks on Tab.

Still intentionally deferred: branch-name completion for `comments --branch`, a richer
machine-readable command-introspection protocol, consistent JSON contracts for every command, and
end-to-end runtime verification where the host permits local port binding. Those are the next
highest-value items, rather than a parser-framework rewrite for its own sake.

## Executive take

LiveDiff already has a better CLI foundation than most young developer tools:

- `livediff .` gets from a worktree to a useful browser view with no setup ceremony.
- The hub starts itself; users do not have to understand the process model first.
- Current-worktree defaults remove repetitive path arguments.
- Command help includes behavior, defaults, examples, and safety notes—not just syntax.
- `--json`, meaningful exit codes, typo suggestions, `--dry-run`, and confirmation for deletion
  show that both automation and human trust are being treated as product concerns.

The biggest opportunity is not adding isolated conveniences. It is making the command language
**trustworthy and explorable**. Today, help metadata, parsing, dispatch, config metadata, docs, and
eventual completion are separate concerns. That separation is already creating small but important
contradictions. A unicorn-quality CLI should have one typed command model from which all of those
surfaces are derived.

The recommended north star is:

> A user should be able to guess a command, press Tab, ask for help, or make a mistake—and each path
> should move them toward the correct command without requiring external documentation.

## Product principles

1. **Zero memorization tax.** The common path should be guessable; the uncommon path should be one
   `--help` or Tab away.
2. **One obvious phrase per job.** Keep intentional aliases, but make one spelling canonical and
   teach it consistently.
3. **Errors are interactive documentation.** Say what was wrong, show the nearest valid form, and
   give the exact next command when recovery is possible.
4. **Shortcuts are additive.** Keep delightful shorthand such as `livediff .`, while also supporting
   explicit, discoverable forms such as `livediff open .`.
5. **Current state is visible.** Users should not have to infer whether the hub is running, which
   config source won, or whether a restart is required.
6. **Human-friendly input, lossless storage.** Accept durations, sizes, shell-parsed argv, and enum
   names naturally; store and emit unambiguous typed values.
7. **Safe by default, fast when explicit.** Destructive operations preview scope and effects;
   `--yes` remains available for automation.
8. **Humans and agents share a grammar.** JSON output and command metadata are stable product APIs,
   not secondary renderings.
9. **No silent acceptance.** Unknown flags, extra arguments, invalid values, and unsupported
   combinations fail early and specifically.
10. **Backward compatibility is part of DX.** Published spellings remain aliases through a visible
    deprecation path; improvements should not turn working scripts into surprises.

These principles match LiveDiff's existing decision that the CLI—not an MCP server or a particular
agent plugin—is the portable integration surface.

## Source-backed audit

### What is already strong

| Area                  | Current strength                                                                                  | Preserve                                       |
| --------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| First useful action   | `livediff .` registers, starts the hub, and opens the focused view                                | Yes; this is the signature interaction         |
| Context defaults      | Most review commands resolve the current worktree                                                 | Yes                                            |
| Help prose            | Each top-level command has details, flags, examples, aliases, and defaults                        | Yes; generate it from the command model        |
| Safety                | `prune` supports dry-run, interactive confirmation, and `--yes`                                   | Yes; make scope even more visible              |
| Honest browser output | Open failures are reported rather than claimed as success                                         | Yes                                            |
| Agent use             | JSON output, stable exit-code categories, comment IDs, and no direct state-file access            | Yes; formalize the contract                    |
| Recovery              | Unknown top-level commands get edit-distance suggestions                                          | Yes; extend to flags, config actions, and keys |
| Configuration         | JSONC, schema completion, atomic writes, typed validation, XDG placement, and explicit precedence | Yes                                            |

### Where the CLI currently breaks its own mental model

#### 1. Help, dispatch, and parsing are not actually one model

**Status: resolved in 0.6.5.** Command metadata now owns names, aliases, flags, and positional
arity. Handler implementation remains separate from that product contract intentionally.

[`server/cli-help.ts`](../server/cli-help.ts) says one table drives dispatch, help, and suggestions,
but [`server/cli.ts`](../server/cli.ts) still has a separate dispatch switch and a global parser.
That creates observable inconsistencies:

- The help table contains conceptual `open` and `hub` entries whose displayed names are `<path>`
  and `(no arguments)`. `livediff help open` and `livediff help hub` cannot find them because lookup
  only checks displayed names and aliases.
- `livediff open .` is the form many users will guess, but only `livediff .` performs the action.
- `livediff config set --help` can only show generic `config` help because config actions are a
  private switch, not real nested commands.
- Adding a command requires keeping metadata, global flag parsing, dispatch, tests, and docs aligned
  manually.

This is the highest-leverage architectural problem because it blocks strict errors, nested help,
completion, and generated documentation at the same time.

#### 2. Unknown flags are silently discarded

The global parser classifies any `--word` or single-letter option as a flag, but it does not validate
that the selected command supports it. A typo such as `--sttaus` can disappear or cause the next
token to be interpreted as a positional path. Missing values can also collapse into defaults—for
example, a missing `--timeout` becomes the no-timeout behavior.

For an intuitive CLI, this is worse than a hard failure: it tells the user their command was
accepted while doing something else. The desired response is closer to:

```text
error: unknown option '--sttaus' for 'livediff comments'
  tip: did you mean '--status'?

usage: livediff comments [path] [options]
  try: livediff comments --help
```

#### 3. Config actions are discoverable only as a compressed usage string

`livediff help config` has good overview prose and examples, but it does not list each action with a
description, and no action has its own help page. Users must remember the set
`path|init|validate|list|get|set|schema`, then infer each action's arguments.

The initialized config file also recommends `livediff config list --effective`, but `--effective`
is not a real option. It appears to work only because unknown flags are ignored. This is exactly the
kind of paper cut a strict command model would prevent.

#### 4. Config values expose storage representation instead of user intent

- Durations are raw integer days or milliseconds.
- Archive warnings are raw bytes.
- Keys are long camel-cased dotted paths that are easy to mistype.
- `browser.opener` has special parsing rules unlike other values.
- The current opener convenience splits whitespace inside every received argument, so an
  intentionally quoted argument containing spaces cannot be preserved in normal argv mode.
- There is no `unset` or reset-to-default operation.
- `list` shows effective values but not whether each value came from a built-in default, the JSONC
  file, or an environment variable.
- A setting can say a restart is required, but there is no memorable `livediff restart` command.

The schema is strongly typed; the CLI should use that metadata to accept friendlier forms such as
`10 MiB`, `30d`, `1s`, enum names, and completion-backed keys without weakening storage types.

#### 5. Editing configuration is needlessly indirect

The proposed `livediff config edit` is a high-value addition. Repeated `set` commands are useful for
scripts and quick changes, but a commented, schema-backed file is the better interface for exploring
multiple options.

Opening the live file directly would be easy but fragile: an invalid save can break every later
LiveDiff invocation. A unicorn implementation can do better:

1. Create a minimal schema-linked config if none exists.
2. Copy it to an adjacent temporary file so relative schema completion still works.
3. Open the temporary file in the chosen editor and wait for it to close.
4. Validate it, including friendly line/column diagnostics and unknown-key suggestions.
5. Atomically replace the real config only when valid.
6. If invalid, preserve the edited draft and offer the exact command to reopen it.
7. Report which effective values changed and whether the hub must restart.

Recommended editor resolution:

1. `--editor <command...>` for this invocation
2. `LIVEDIFF_EDITOR`
3. a typed LiveDiff setting
4. `VISUAL`
5. `EDITOR`
6. `vim` on Unix-like systems and a sensible platform fallback on Windows

External tools should remain argv arrays and should never be sent through a shell. During planning,
revisit the naming as a family rather than adding a one-off `command` key. A semantic shape such as
`tools.openUrl` and `tools.editFile` is clearer and scales better than unrelated settings named
`browser.opener` and `editor.command`. The published `browser.opener` key can remain as a compatible
alias with migration messaging.

#### 6. Help is good locally but lacks progressive disclosure

The main help is concise and readable, but it has to carry commands, options, examples, and
environment variables in one screen. Meanwhile deeper subjects—configuration precedence, JSON
shape, exit codes, waiting/review behavior, and completion—have no built-in topic pages.

A stronger learning ladder would be:

- `livediff --help`: quick start, common workflows, grouped commands, and the next help action.
- `livediff <command> --help`: concise syntax, common options, and examples.
- `livediff help <command>`: long help with defaults, behavior, output, exit codes, related commands,
  and a direct documentation link.
- `livediff help <command> <subcommand>`: real nested help at every level.
- `livediff help workflows|config|environment|json|exit-codes|completion`: conceptual help topics.
- `livediff help --all`: a complete, pageable local reference generated from the same registry.

This follows uv's useful distinction between condensed `--help` and longer, pageable `help`, while
keeping LiveDiff's current examples and explanatory prose.

#### 7. `--json` is promised more broadly than it is defined

The README says every command accepts `--json`, but help output remains human text and the command
tree itself has no machine-readable form. For agents, shell completion, docs generation, and plugin
skills, LiveDiff would benefit from a stable introspection surface:

```text
livediff help --json
livediff help config set --json
```

The output should describe commands, aliases, positional arguments, flags, accepted values,
defaults, examples, exit codes, and whether a command may prompt or mutate state. This makes the CLI
self-describing for agents without requiring an always-loaded MCP server. Static docs and completion
scripts can use the same contract.

#### 8. Important state is spread across several commands

`list`, `doctor`, `comments`, and config commands each expose part of the system, but there is no
single answer to “what is LiveDiff doing here?” A `livediff status [path]` command could show:

- installed CLI version and running hub version
- hub URL, port, and health
- current or selected worktree and branch
- changed-file and open-comment counts
- active review/wait state
- config path and any pending restart-requiring changes

Human output should be a compact snapshot; JSON should be a stable object. This also gives support
and agents one first diagnostic command before reaching for the broader `doctor`.

#### 9. Completion can remove most remembering

**Status: partially resolved in 0.7.** Static command, alias, action, flag, and config-key
completion, plus dynamic workspace-path and comment-ID completion, are generated from the same
registry and shell out to a hidden completion protocol that queries a running hub without ever
starting one. Branch names for `comments --branch` remain deferred.

Generated completion is the best “shell plugin” starting point. A separate resident plugin is not
needed. A single command registry can generate standard completion scripts, while a small hidden
completion protocol supplies live candidates.

```text
livediff completion bash|zsh|fish|powershell|nushell
livediff completion install [--shell <shell>]
livediff completion uninstall [--shell <shell>]
```

High-value dynamic candidates include:

- commands, aliases, nested actions, and only the flags valid in the current context
- paths for `open`, `review`, and scoped comment commands
- registered workspace names and IDs
- open comment IDs for `reply` and `resolve`, archived IDs for `restore`
- branches for `comments --branch`
- config keys, enum values, and typed value hints such as `<duration>` or `<size>`
- supported shells and renderer names

Jujutsu's distinction between standard and dynamic completion is a good model: static command and
option completion should always be available, while state-aware candidates can be an additive
enhancement. Installation should not silently edit shell profiles. An explicit, idempotent
`completion install` may do so after showing the exact file and change; otherwise the installer can
print a copyable one-liner and `doctor` can report whether completion is active.

## Proposed command language

The goal is not to replace the short commands users already know. It is to add explicit canonical
forms, make nested objects consistent, and keep the best shortcuts as aliases.

### Everyday review loop

| Intent                      | Canonical form                    | Convenient form retained    |
| --------------------------- | --------------------------------- | --------------------------- |
| Open current worktree       | `livediff open .`                 | `livediff .`                |
| Open hub                    | `livediff hub`                    | `livediff`                  |
| Open and wait for review    | `livediff review [path]`          | `livediff [path] --wait`    |
| Print a shareable/local URL | `livediff link [path]`            | `livediff [path] --no-open` |
| Inspect local state         | `livediff status [path]`          | new                         |
| Read feedback               | `livediff comments [path]`        | current form                |
| Answer feedback             | `livediff reply <id> <text...>`   | current form                |
| Finish feedback             | `livediff resolve <id> [text...]` | current form                |

`open`, `hub`, `review`, and `link` make the command vocabulary match the existing plugin skills and
the words users naturally guess. The shorthand remains the fastest path once learned.

### Workspace and comment lifecycle

Do not force a taxonomy migration immediately. The existing short commands are memorable. Introduce
grouped canonical forms only where they improve discovery, and retain top-level forms indefinitely
as documented aliases if they are already public.

```text
livediff workspace list                 # aliases: livediff list, livediff ls
livediff workspace remove [path|id]     # aliases: livediff rm, livediff remove

livediff comments archive [path]
livediff comments restore <id>
livediff comments prune [path]
```

Before adopting the grouped lifecycle forms, test whether the extra noun makes frequent agent
commands harder to scan. The likely compromise is to group them in help while retaining the concise
top-level verbs as canonical for now.

### Configuration

```text
livediff config                         # effective summary plus where to learn more
livediff config edit [--editor <command...>]
livediff config path
livediff config list [--sources|--overrides]
livediff config get <key> [--source]
livediff config set <key> <value...>
livediff config unset <key>
livediff config explain [key]
livediff config validate [path]
livediff config schema [--update]
```

Recommended behavior:

- `config edit` creates the file if needed, uses the schema, validates before replacing, and reports
  restart impact.
- `config list` shows effective values; `--sources` adds origin and precedence; `--overrides` shows
  only values written by the user.
- `config explain <key>` shows description, accepted type/forms, default, configured value,
  effective value, source, environment override, and restart behavior.
- `config set` and `unset` print the before/after effective value and exact next action.
- Unknown actions and keys get typo suggestions.
- Completion makes dotted keys discoverable instead of requiring memorization.
- `config init` remains for compatibility and scripting, but `edit` makes it unnecessary for normal
  interactive use.
- `config schema --update` remains an advanced maintenance action and need not occupy prime help
  space.

### Process control and repair

```text
livediff status
livediff restart
livediff stop
livediff doctor [--fix]
```

`doctor --fix` should only perform individually safe, deterministic repairs. It should preview every
change, require confirmation on a TTY, and support `--dry-run` and `--yes`. Findings that require a
user choice should continue to print an exact manual command.

## Help and error design

### Main help should teach workflows, not just inventory

Group commands by user intent and put the four-command happy path first:

```text
GET STARTED
  livediff .                    review this worktree in the browser
  livediff comments             read feedback from the current branch
  livediff resolve <id> [text]  answer and close a comment
  livediff status               see what LiveDiff is doing here

REVIEW
  open, review, link, comments, reply, resolve

MANAGE
  workspace, archive, restore, prune

SETUP & SUPPORT
  config, completion, status, doctor, restart, stop
```

The full command list remains available, but the first screen answers “how do I use this?” before
“what exists?” Add a documentation/support URL at the bottom.

### Every failure should contain a recovery route

Use one compact error grammar:

```text
error: <what failed, in user language>
  tip: <nearest correction or exact recovery command>

usage: <only when the invocation shape is wrong>
  try: <specific --help command>
```

Examples:

```text
error: '--status' needs a value
  tip: choose one of: open, resolved, all

usage: livediff comments [path] --status <status>
```

```text
error: config key 'retention.archiveWarningByte' does not exist
  tip: did you mean 'retention.archiveWarningBytes'?
  try: livediff config explain retention.archiveWarningBytes
```

```text
error: config draft is invalid at line 8, column 29
  hub.port must be an integer from 1 to 65535

Your current config was not changed.
  try: livediff config edit --resume
```

Expected runtime failures should also remain distinguishable. A disconnected review event stream
should not be reported as “timed out after 0s”; timeout, cancellation, hub exit, and transport failure
need separate messages and exit semantics.

### Output should end with the useful fact

- Long-running commands print an immediate state line in under a perceptible delay.
- `review --wait` prints the URL, what it is waiting for, and how Ctrl-C behaves.
- Successful config edits end with “applied now” or the exact `livediff restart` command.
- Empty states teach the next likely action without becoming noisy.
- Color and symbols clarify status but are never the only signal; `NO_COLOR` remains respected.
- Long local help uses a pager only on a TTY.

## Completion and agent introspection should share a protocol

The command registry should be able to emit a versioned description of itself. Shell completion,
Markdown reference generation, plugins, and agents can then consume the same data.

Illustrative shape:

```json
{
  "schemaVersion": 1,
  "command": ["config", "set"],
  "summary": "Set a user configuration override",
  "arguments": [
    { "name": "key", "required": true, "completion": "config-key" },
    { "name": "value", "required": true, "variadic": true }
  ],
  "options": [],
  "mayPrompt": false,
  "mutates": ["user-config"],
  "examples": ["livediff config set retention.archiveWarningBytes 10MiB"]
}
```

This is more useful to agents than prose-only skills and keeps those skills small: teach the review
workflow, then let the installed CLI describe the exact capabilities of its version.

## Parser/command-framework direction

The current hand-rolled parser is small, but the next DX tier requires strict option ownership,
nested commands, typed coercion, suggestions, two help depths, completion, and introspection. Adding
those independently would make the parser a product inside the product.

Three credible directions should be spiked before planning the migration:

| Direction                                 | Strengths                                                                                                                 | Risks                                                                                               | Current read                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Typed internal registry                   | Total control over LiveDiff's unusual path shorthand and output; no new dependency                                        | We own parsing edge cases, completion generation, wrapping, and future compatibility                | Viable only if the registry truly drives every surface |
| Commander + `@commander-js/extra-typings` | Mature strict parsing, nested help, unknown-option/command suggestions, flexible rendering, strong inferred handler types | No first-class dynamic completion; customization must preserve LiveDiff's concise voice             | Pragmatic baseline                                     |
| Stricli                                   | Type-first, zero dependencies, dependency injection, and first-class dynamic autocomplete                                 | Younger ecosystem and deliberately limited feature scope; shorthand and custom help need validation | Most interesting unicorn-DX spike                      |

oclif offers parsing, JSON behavior, generated docs, plugins, installers, and autocomplete, but it is
likely too much framework and dependency surface for LiveDiff's small local architecture.

The spike should implement only a representative grammar—`open`, `comments`, `config edit`, and
`config set`—and compare:

- inferred types without `any`
- exact argv preservation
- unknown/missing/extra argument errors
- nested short and long help
- `livediff .` compatibility
- static and dynamic completion hooks
- JSON command introspection
- startup overhead and package weight
- testability without process-wide globals

Do not migrate command handlers during the spike. Choose the grammar engine first, then plan a
behavior-preserving cutover with snapshot and process-level tests.

## Priority map

### P0 — make the grammar trustworthy

- Reject unknown flags and unexpected positional arguments.
- Validate missing flag values before any hub starts.
- Make `open` and `hub` real, runnable, help-addressable commands while retaining shorthand.
- Make config actions real nested commands with their own help.
- Put dispatch, parsing, help, suggestions, and aliases behind one typed registry.
- Add UX contract tests for every command's help, errors, and exit code.

This is foundational work; doing `config edit` first on the current parser would add another special
case that later has to be migrated.

### P1 — make configuration delightful

- Add validated, atomic `config edit` with editor precedence and draft recovery.
- Add `config unset`, `config explain`, and value-source reporting.
- Add `restart` and exact apply/restart messaging.
- Accept human sizes and durations while storing canonical integers.
- Fix opener argv semantics and settle the external-tool key family.
- Generate config command metadata from the same typed descriptors as the JSON Schema.

### P2 — make the CLI teach itself

- Redesign main help around workflows and grouped commands.
- Separate concise `--help` from long `help`.
- Add nested and conceptual help topics, docs links, and pageable `help --all`.
- Standardize actionable error rendering and suggestions for commands, flags, actions, and keys.
- Define `help --json` and version its schema.
- Generate the CLI reference in README/docs from the registry to prevent drift.

### P3 — remove memorization with completion

- Generate Bash, Zsh, Fish, PowerShell, and Nushell completion.
- Add dynamic candidates for workspaces, comment IDs, branches, config keys, and enums.
- Provide explicit idempotent install/uninstall commands; never silently edit profiles.
- Teach `doctor` to detect missing or stale completion setup.

### P4 — test higher-order delight

- Add `status` as the one-screen local system snapshot.
- Consider TTY-only pickers when `resolve`, `restore`, or `rm` lacks an identifier.
- Consider safe `doctor --fix` repairs.
- Consider user-defined aliases only after the canonical vocabulary is stable; shell aliases already
  cover most needs, and a product alias system expands the compatibility surface.
- Run five-minute first-use tests with people who have never seen LiveDiff and record every guess.

## Recommended first planning slice

Plan P0 and P1 together, but execute them as reviewable checkpoints:

1. **Command contract:** write a versioned command grammar and black-box UX fixtures for current
   behavior, including intentional compatibility aliases.
2. **Framework spike:** compare the typed internal registry, Commander extra typings, and Stricli
   against the representative grammar; record the decision in `docs/DECISIONS.md`.
3. **Strict cutover:** move routing/help/errors to the chosen model without changing business logic.
4. **Config delight:** implement `edit`, `unset`, `explain`, provenance, human units, and `restart`.
5. **Learning pass:** rewrite help and error copy only after the grammar can guarantee it is true.
6. **Completion pass:** generate static completion, then add dynamic candidates behind a stable
   protocol.

The acceptance bar for every checkpoint should include:

- zero `any` and type-aware linting remains a release gate
- every valid invocation has help generated from its actual parser definition
- every invalid invocation fails before mutation or hub startup
- every usage error names the correction or exact help command
- human and JSON output have explicit snapshot/contract tests
- old public spellings either still work or emit a tested deprecation message
- lint, format, typecheck, unit, browser, and end-to-end suites are clean before release

## Decisions to make during planning

The brainstorm's recommended defaults are shown in **bold**:

1. Parser foundation: internal registry, Commander extra typings, or Stricli?  
   **Run the small spike; prefer Stricli if it handles shorthand/help customization cleanly,
   otherwise use Commander extra typings.**
2. External tool keys: retain unrelated names or establish a semantic family?  
   **Establish a family such as `tools.openUrl` and `tools.editFile`, with compatibility aliases.**
3. Editor fallback: portable `vi` or requested `vim`?  
   **Use `vim` on Unix-like systems, with an actionable fallback if unavailable.**
4. Completion profile edits: installer, CLI command, or documentation only?  
   **Use an explicit idempotent `livediff completion install`; do not silently modify profiles.**
5. Group lifecycle commands now?  
   **Defer taxonomy migration; group help first and retain the short top-level verbs.**
6. Auto-restart after config changes?  
   **Do not surprise the browser session; report impact and offer `livediff restart`, with an
   explicit `--restart` option later if demand appears.**

## Inspiration and references

- [Command Line Interface Guidelines](https://clig.dev/) — human-first CLI design, actionable
  errors, strict validation, visible state, future-proof subcommands, XDG config, conventional
  environment variables, and consent before editing external config.
- [uv: getting help](https://docs.astral.sh/uv/getting-started/help/) — concise `--help` versus long,
  pageable `help`, plus repeatable verbosity.
- [uv: installation and shell completion](https://docs.astral.sh/uv/getting-started/installation/#shell-autocompletion)
  — generated completion commands and copyable per-shell setup.
- [Jujutsu: installation and dynamic completion](https://docs.jj-vcs.dev/latest/install-and-setup/#command-line-completion)
  — standard versus state-aware completion for commands, files, revisions, bookmarks, and aliases.
- [Jujutsu configuration](https://docs.jj-vcs.dev/latest/config/) — `config edit`, `config path`,
  explicit scopes, precedence, and schema-backed editor validation.
- [Git config](https://git-scm.com/docs/git-config) — `edit`, `set`, `unset`, value typing,
  `--show-origin`, and `--show-scope` as mature config-management vocabulary.
- [GitHub CLI manual](https://cli.github.com/manual/) — nested noun/verb commands, aliases, generated
  reference, configuration, and examples.
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment) — explicit
  editor/browser precedence and documented terminal-behavior controls.
- [Commander](https://github.com/tj/commander.js/) — strict unknown-option and excess-argument
  handling, nested commands, generated help, typo suggestions, custom help, and optional inferred
  TypeScript handler types.
- [Stricli](https://bloomberg.github.io/stricli/) — zero-dependency, type-first command definitions,
  dependency injection, and dynamic autocomplete.
- [oclif features](https://oclif.io/docs/features/) — useful reference for generated docs, JSON
  behavior, installers, and completion, even if the full framework is likely too large here.
