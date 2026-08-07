# CLI help redesign

**Status:** design approved, not yet implemented
**Date:** 2026-08-06
**Baseline:** LiveDiff 0.8.2
**Backlog item:** P2 in [docs/CLI-UX-BRAINSTORM.md](../../CLI-UX-BRAINSTORM.md)

## Why this work

LiveDiff's help is accurate but flat. A single screen carries eighteen commands, the
global options, four examples, and five environment variables, which means the first
thing a new user sees is an inventory rather than an explanation. Nothing on that screen
distinguishes the four commands somebody will run every day from the four they will run
once a year, and nothing tells them where the deeper subjects live, because the deeper
subjects have no home in the CLI at all. Configuration precedence, the JSON contract,
exit-code semantics, and the agent integration are documented only in the README, which
is exactly where a person in a terminal will not look.

The registry work finished in 0.8.0 makes this the natural next step. Command names,
aliases, arguments, options, and examples are already declared once and consumed by
validation, completion, and JSON introspection. Help is the last surface still hand-shaped,
and it is the surface a human actually reads.

The goal is a learning ladder rather than a bigger screen: a fast cheat sheet for people
who already know what they want, a switchboard for people who do not, real depth one level
down, and conceptual topics for the subjects that were never about a single command.

## Shape of the result

Four surfaces, each with one job.

### `livediff --help` — the cheat sheet

The happy path gets full lines with descriptions. Everything else collapses to grouped
name lists, which keeps the whole thing inside a short terminal window. Descriptions for
the non-happy-path commands move down a level rather than disappearing.

```
livediff v0.8.1 — live git worktree diff hub

USAGE
  livediff [command] [options]

GET STARTED
  livediff .                    review this worktree in the browser
  livediff comments             read feedback on this branch
  livediff resolve <id> [text]  answer and close a comment
  livediff status               see what LiveDiff is doing here

REVIEW   open  review  link  comments  reply  resolve
MANAGE   list  rm  archive  restore  prune
SETUP    hub  config  completion  status  restart  stop  doctor

OPTIONS
  --json  machine-readable    -h, --help    -v, --version

  livediff help             all commands, grouped
  livediff help <command>   one command in depth
  livediff help workflows   how the review loop fits together
```

The group rows are rendered from `group` with no exclusions, so a command named in
GET STARTED still appears in its group below. `comments`, `resolve`, and `status` are
therefore each listed twice. That repetition is deliberate: the two blocks answer different
questions — "what do I run today" versus "what exists" — and suppressing duplicates would
make the group rows an unreliable index of what a group contains.

### `livediff help` — the switchboard

Every command, grouped by intent, each with the one-line description that `--help` had to
drop. No options and no examples, so it stays a single screen. The topic list sits at the
bottom, which is the only place in the CLI that advertises the conceptual material exists.

```
livediff help — what would you like?

REVIEW
  open        register a worktree and open its focused view
  review      open a worktree and wait for the reviewer
  link        print a focused worktree URL, open nothing
  comments    print review comments for a worktree
  reply       reply to a comment without resolving it
  resolve     reply to a comment and mark it resolved

MANAGE
  list        list registered workspaces
  rm          unregister a workspace
  archive     archive comments that are no longer live
  restore     return an archived comment to the live view
  prune       delete archived comments

SETUP & SUPPORT
  hub         open the hub UI showing every registered workspace
  config      view and manage per-user LiveDiff settings
  completion  generate, install, or inspect shell completion
  status      show whether the hub is running and where settings live
  restart     restart the hub to apply cached settings
  stop        shut the hub down
  doctor      diagnose install and state problems

TOPICS
  livediff help workflows | json | exit-codes | environment | agents
  livediff help <command>    one command in depth
```

### `livediff <command> --help` versus `livediff help <command>`

Both render the same command, at two depths. The concise form gives usage, options, and
examples. The verbose form adds the `details` prose block that every registry entry already
carries, so this costs no new content — concise mode simply omits a field that exists today.

The concise form ends with a pointer to the verbose one, so the ladder is discoverable from
the rung below it.

### `livediff help <topic>` — the conceptual material

Five topics, each a short essay:

| Topic         | Covers                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| `workflows`   | the review loop end to end, from registering a worktree to resolving a thread |
| `json`        | which commands emit JSON, the shapes they emit, and `help --json`             |
| `exit-codes`  | what `0`, `1`, and `2` mean, and which failures map to which                  |
| `environment` | the `LIVEDIFF_*` variables and `NO_COLOR`, and how they rank against config   |
| `agents`      | using LiveDiff from Claude Code and Codex, and what those plugins do          |

## Prose voice

Help text is product copy, and the topic bodies are the largest piece of prose LiveDiff
will ship. They should read as narrative written for a person — complete sentences,
connected thoughts, a paragraph that explains why something works the way it does before
it explains how to invoke it. Concise is the goal; clipped is not. The README's voice is
the reference: it explains the reasoning behind the comment lifecycle and the idle hub
rather than listing their properties, and the topics should sound like they came from the
same hand.

This matters most for `workflows` and `agents`, which are teaching documents rather than
tables. Someone reading `livediff help workflows` is asking how the product fits together,
and a list of commands will not answer that.

Command summaries and option descriptions keep their current terse register — they are
labels in a table, and the constraint is real there.

## Architecture

Three modules, split by role rather than by feature.

### `server/cli-help.ts` — the registry

Gains one field on `CommandHelp`:

```ts
export type CommandGroup = "review" | "manage" | "setup";

export interface CommandHelp {
  // …existing fields…
  group: CommandGroup;
}
```

A union rather than a string means a command added without a group is a compile error, not
a row that silently vanishes from the index. `group` also flows into `CommandDescriptor`,
which is purely additive, so `INTROSPECTION_SCHEMA_VERSION` stays at `1` and no existing
consumer breaks.

Group assignments: `open`, `review`, `link`, `comments`, `reply`, `resolve` are `review`;
`list`, `rm`, `archive`, `restore`, `prune` are `manage`; `hub`, `config`, `completion`,
`status`, `restart`, `stop`, `doctor` are `setup`.

GET STARTED is a separate curated constant rather than a derived group, because two of its
four lines are invocations rather than command names — `livediff .` is the bare-path
shorthand and `livediff resolve <id> [text]` carries argument placeholders. There is
nothing in the registry to derive those from. That makes it a drift risk, so a test asserts
each line's leading token resolves to a real command or to the documented bare-path form.

### `server/cli-topics.ts` — new

```ts
export interface HelpTopic {
  name: string;
  summary: string;
  body: string;
}

export const TOPICS: readonly HelpTopic[];
export function findTopic(token: string): HelpTopic | null;
```

Topics live outside the registry deliberately. They have no arity, no aliases, and no
options, and DECISIONS.md has just committed to the registry being the single source for
the _command contract_. Filing prose there would weaken a claim made one commit ago.

### `server/cli-help-render.ts` — moved out of `cli-help.ts`

`cli-help.ts` is 761 lines already holding registry data, renderers, and JSON descriptors.
Adding two renderers and a topic system would push it past 1100 lines doing four jobs, so
the renderers move to their own module as part of this work:

```ts
export function renderMainHelp(version: string): string;
export function renderHelpIndex(version: string): string;
export function renderCommandHelp(cmd: CommandHelp, opts: { verbose: boolean }): string;
export function renderConfigCommandHelp(cmd: CommandHelp, opts: { verbose: boolean }): string;
export function renderCompletionCommandHelp(cmd: CommandHelp, opts: { verbose: boolean }): string;
export function renderTopic(topic: HelpTopic): string;
```

This is a targeted cleanup of code being modified anyway, not a speculative refactor.

### `server/cli.ts` — dispatch

`helpFor` takes the depth as a parameter:

```ts
function helpFor(tokens: readonly string[], opts: { verbose: boolean }): string | null;
```

`WANTS_HELP` passes `verbose: false`; the `help` command passes `true`. At zero tokens that
choice selects the switchboard or the cheat sheet. At one or more tokens it selects whether
`DETAILS` renders.

`resolveHelpCommand` gains topic lookup, placed _after_ command lookup so commands always
win the shared namespace. This matters because `config` and `completion` are both commands
today, and their conceptual material belongs in their command help regardless.

`suggest()` starts considering topic names alongside command names, so `livediff help
wrokflows` recovers the way a mistyped command already does.

## JSON contract

`CliDescriptor` gains a `topics` array so agents can discover the conceptual surface, not
just the command tree:

```ts
export interface TopicDescriptor {
  name: string;
  summary: string;
}

export interface CliDescriptor {
  // …existing fields…
  topics: readonly TopicDescriptor[];
}
```

`livediff help <topic> --json` emits `{ name, summary, body }`. Every `CommandDescriptor`
gains its `group`. All three changes are additive; `schemaVersion` remains `1`.

## Generated reference

`scripts/generate-cli-docs.ts` groups commands by `group` in both the table of contents and
the body, so `docs/CLI.md` picks up the same organization for free. The existing drift guard
in `test/cli-docs.test.ts` then requires `docs/CLI.md` to be regenerated in the same commit,
which is the mechanism working as intended.

## Testing

Contract tests, added to the existing `test/cli.test.ts` and a new `test/cli-topics.test.ts`:

- No topic name collides with any command name or alias. This is the one failure mode that
  would silently make a topic unreachable.
- Every GET STARTED line's leading token either resolves through `findCommand()` or is `.`,
  the documented bare-path shorthand. This is what keeps the curated block from drifting.
- `livediff open --help` omits the DETAILS block; `livediff help open` includes it.
- The `help` index lists every registered command exactly once, so a new command cannot be
  added without appearing.
- `help --json` carries `group` on every command and lists all five topics.
- `help <topic> --json` round-trips the topic body.
- Snapshots of `livediff --help` and `livediff help`, which are the two screens most likely
  to regress unnoticed.

Group coverage needs no test: the union type makes a missing group a compile error.

## Out of scope

Three things the brainstorm proposes that this design deliberately omits.

**The pager.** The brainstorm calls for paging long help, but under this shape nothing is
long — the index is one screen and command help is modest. Adding `$PAGER` resolution, TTY
detection, and the failure modes that come with them would be building for a screen that no
longer exists.

**`help --all`.** With the index carrying descriptions, a third depth has no distinct job.
`docs/CLI.md` is the exhaustive reference and is already generated.

**`mayPrompt` and `mutates` annotations.** Genuinely valuable for agents, and still worth
doing, but they are an introspection concern rather than a help-rendering one and belong in
their own change.

## Risks

The topic bodies are the bulk of the work and they are prose, not code, so the usual gates
cannot tell us whether they are any good. `workflows` and `agents` overlap heavily with
README material that is already written and already in the right voice; both should be
drafted from it rather than from scratch, which reduces the writing task and keeps the two
surfaces consistent.

The second risk is the GET STARTED constant drifting from reality, which the resolution test
addresses directly.
