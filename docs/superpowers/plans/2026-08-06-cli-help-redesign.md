# CLI Help Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LiveDiff's single flat help screen with a learning ladder — a concise `--help` cheat sheet, a grouped `help` index, two depths of per-command help, and five conceptual topics.

**Architecture:** The typed command registry in `server/cli-help.ts` gains a `group` field and stays the single source for the command contract. Rendering moves out to a new `server/cli-help-render.ts`, and conceptual prose lives in a new `server/cli-topics.ts`. `server/cli.ts` picks a depth by passing `verbose` into `helpFor`.

**Tech Stack:** TypeScript 7 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node ≥ 24, vitest, oxlint, oxfmt. Zero runtime dependencies in the server — do not add any.

**Spec:** [docs/superpowers/specs/2026-08-06-cli-help-redesign-design.md](../specs/2026-08-06-cli-help-redesign-design.md)

## Global Constraints

- **Do not commit without asking Shane first.** Each task below ends with a commit step; run it only after Shane approves that task's diff. This overrides the plan template's default.
- Shell rules for any agent running commands: never chain or pipe (`&&`, `||`, `|`, `;`), one command per invocation; never pass `git -C <path>`; use `pnpm`, never `npm` or `yarn`.
- Conventional Commits: `type(scope): subject`, scope is `livediff`.
- Prefer no comments. Where one is genuinely needed it explains _why_, never _what_. JSDoc is welcome on exported APIs.
- `INTROSPECTION_SCHEMA_VERSION` stays `1`. Every JSON change in this plan is additive.
- Zero `any`. `pnpm typecheck`, `pnpm lint` (`oxlint --deny-warnings`), and `pnpm format:check` must all pass before each commit.
- Do not add a pager, `help --all`, or `mayPrompt`/`mutates` annotations. All three are explicitly out of scope.
- Topic prose voice: narrative written for a person — complete sentences, connected thoughts, explain _why_ before _how_. Match the README's register. Command summaries and option descriptions keep their existing terse register.

---

## File Structure

| File                                    | Responsibility                                                         |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `server/cli-help.ts` (modify)           | Registry data, arity, descriptors, lookup, `suggest`. Renderers leave. |
| `server/cli-help-render.ts` (create)    | All human-facing help rendering.                                       |
| `server/cli-topics.ts` (create)         | Conceptual topic prose and lookup.                                     |
| `server/cli.ts` (modify)                | Help dispatch and depth selection.                                     |
| `scripts/generate-cli-docs.ts` (modify) | Group commands in the generated reference.                             |
| `docs/CLI.md` (regenerate)              | Generated output; never hand-edited.                                   |
| `test/cli-help-render.test.ts` (create) | Rendering contract tests.                                              |
| `test/cli-topics.test.ts` (create)      | Topic collision and lookup tests.                                      |
| `test/cli.test.ts` (modify)             | End-to-end help invocation tests.                                      |

---

### Task 1: Extract renderers into their own module

Pure move. No behavior changes, no test changes beyond imports. Doing this first keeps every later diff readable.

**Files:**

- Create: `server/cli-help-render.ts`
- Modify: `server/cli-help.ts` (remove `pad`, `renderMainHelp`, `renderCommandHelp`, `renderConfigCommandHelp`, `renderCompletionCommandHelp`)
- Modify: `server/cli.ts:14-30` (import block)

**Interfaces:**

- Consumes: `CommandHelp`, `COMMANDS`, `GLOBAL_FLAGS`, `HelpRow` from `cli-help.ts`
- Produces: `renderMainHelp(version: string): string`, `renderCommandHelp(cmd: CommandHelp): string`, `renderConfigCommandHelp(cmd: CommandHelp): string`, `renderCompletionCommandHelp(cmd: CommandHelp): string`

- [ ] **Step 1: Export the `HelpRow` type from `cli-help.ts`**

It is currently module-private on line 6. The renderer module needs it.

```ts
export type HelpRow = readonly [string, string];
```

- [ ] **Step 2: Create `server/cli-help-render.ts` with the moved functions**

Move `pad`, `renderMainHelp`, `renderCommandHelp`, `renderConfigCommandHelp`, and `renderCompletionCommandHelp` verbatim.

Also move the three colour helpers on `server/cli-help.ts:63-65` — `useColor`, `bold`, and `dim`. They are module-private and used only by the render functions, so after the move `cli-help.ts` has no remaining reference to them. Copy them exactly:

```ts
/**
 * Human-facing help rendering. The registry in cli-help.ts owns what the commands are;
 * this module owns how they read.
 */

import { COMMANDS, GLOBAL_FLAGS, type CommandHelp, type HelpRow } from "./cli-help.js";

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
```

Confirm nothing else needs them: `git grep -n "bold(\|dim(" -- server/cli-help.ts` must return nothing after the move.

- [ ] **Step 3: Update imports in `server/cli.ts`**

The five moved names now come from `./cli-help-render.js`. Everything else stays on `./cli-help.js`.

- [ ] **Step 4: Update imports in `scripts/generate-cli-docs.ts` if it imports any renderer**

Check with `git grep -n "cli-help" -- scripts/`. It imports `describeCli` and types only, so it likely needs no change — confirm rather than assume.

- [ ] **Step 5: Run the full gates**

Run: `pnpm typecheck`
Expected: clean.

Run: `pnpm test`
Expected: 210 passed. A pure move must not change any count.

Run: `pnpm lint`
Expected: clean.

Run: `pnpm format:check`
Expected: clean.

- [ ] **Step 6: Commit (after Shane approves)**

```bash
git add server/cli-help.ts server/cli-help-render.ts server/cli.ts
git commit -m "refactor(livediff): move help rendering out of the registry"
```

---

### Task 2: Add `group` to the registry and the JSON descriptor

**Files:**

- Modify: `server/cli-help.ts` (`CommandHelp`, all 18 `COMMANDS` entries, `CommandDescriptor`, `describeCommand`)
- Modify: `scripts/generate-cli-docs.ts`
- Regenerate: `docs/CLI.md`
- Test: `test/cli-docs.test.ts` (existing drift guard covers the regeneration)

**Interfaces:**

- Produces: `export type CommandGroup = "review" | "manage" | "setup"`, `CommandHelp.group: CommandGroup`, `CommandDescriptor.group: CommandGroup`

- [ ] **Step 1: Add the type and the field**

In `server/cli-help.ts`, above `CommandHelp`:

```ts
export type CommandGroup = "review" | "manage" | "setup";
```

Add to the `CommandHelp` interface:

```ts
export interface CommandHelp {
  id: string;
  name: string;
  usage: string;
  summary: string;
  details: string;
  group: CommandGroup;
  args: readonly ArgSpec[];
  flags: readonly HelpRow[];
  examples: readonly HelpRow[];
  aliases?: readonly string[];
}
```

- [ ] **Step 2: Run typecheck to enumerate every entry needing a group**

Run: `pnpm typecheck`
Expected: FAIL, one error per `COMMANDS` entry missing `group`. This error list is the worklist for the next step — the union type is doing the job a test would otherwise do.

- [ ] **Step 3: Assign a group to every entry in `COMMANDS`**

Add `group:` to each, immediately after `summary`:

| Command ids                                                          | Group      |
| -------------------------------------------------------------------- | ---------- |
| `open`, `review`, `link`, `comments`, `reply`, `resolve`             | `"review"` |
| `list`, `rm`, `archive`, `restore`, `prune`                          | `"manage"` |
| `hub`, `config`, `completion`, `status`, `restart`, `stop`, `doctor` | `"setup"`  |

`COMMANDS` has a `help` entry at `server/cli-help.ts:381`. Give it `"setup"`. It is filtered out of rendering by `c.id !== "help"`, so the value is never displayed, but the type still demands one.

`CONFIG_COMMANDS` and `COMPLETION_COMMANDS` are nested actions rendered under their parent, never in a group list. If they share the `CommandHelp` type they will also need a `group`; give every entry in both arrays `"setup"` to satisfy the type. Do not render it.

- [ ] **Step 4: Run typecheck to confirm the worklist is empty**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Add `group` to the JSON descriptor**

In `server/cli-help.ts`:

```ts
export interface CommandDescriptor {
  name: string;
  path: readonly string[];
  summary: string;
  usage: string;
  group: CommandGroup;
  aliases: readonly string[];
  arguments: readonly ArgSpec[];
  options: readonly OptionDescriptor[];
  examples: readonly { command: string; description: string }[];
}
```

And in `describeCommand`, add `group: command.group,` to the returned object.

- [ ] **Step 6: Write the failing test for group in JSON**

Add to `test/cli.test.ts`:

```ts
test("help --json reports a group for every command", async () => {
  const res = await cli(["help", "--json"]);
  assert.equal(res.code, 0);
  const descriptor = JSON.parse(res.stdout) as {
    commands: { name: string; group: string }[];
  };
  assert.ok(descriptor.commands.length > 0);
  for (const command of descriptor.commands) {
    assert.ok(
      ["review", "manage", "setup"].includes(command.group),
      `${command.name} has group ${command.group}`,
    );
  }
});
```

- [ ] **Step 7: Run it**

Run: `pnpm test -- -t "help --json reports a group"`
Expected: PASS (steps 1-5 already implemented it).

- [ ] **Step 8: Group the generated reference**

In `scripts/generate-cli-docs.ts`, replace `renderTableOfContents` so the TOC is grouped, and emit commands in group order:

```ts
const GROUP_TITLES: Record<string, string> = {
  review: "Review",
  manage: "Manage",
  setup: "Setup & support",
};

const GROUP_ORDER = ["review", "manage", "setup"] as const;

function renderTableOfContents(commands: readonly CommandDescriptor[]): string {
  const sections = GROUP_ORDER.flatMap((group) => {
    const inGroup = commands.filter((command) => command.group === group);
    if (inGroup.length === 0) return [];
    return [
      "",
      `### ${GROUP_TITLES[group]}`,
      "",
      ...inGroup.map((command) => `- [${command.name}](#${slugify(command.name)})`),
    ];
  });
  return ["## Commands", ...sections].join("\n");
}

function orderedCommands(commands: readonly CommandDescriptor[]): readonly CommandDescriptor[] {
  return GROUP_ORDER.flatMap((group) => commands.filter((command) => command.group === group));
}
```

In `renderCliReference`, replace `descriptor.commands.flatMap(...)` with `orderedCommands(descriptor.commands).flatMap(...)`.

- [ ] **Step 9: Regenerate the reference**

Run: `pnpm docs:cli`
Expected: `wrote docs/CLI.md`.

- [ ] **Step 10: Confirm the drift guard is satisfied**

Run: `pnpm test`
Expected: 211 passed (210 plus the new group test). If `test/cli-docs.test.ts` fails, `pnpm docs:cli` was not re-run after the last edit.

- [ ] **Step 11: Gates and commit (after Shane approves)**

Run: `pnpm lint`, then `pnpm format:check`, each as its own command. Both clean.

```bash
git add server/cli-help.ts scripts/generate-cli-docs.ts docs/CLI.md test/cli.test.ts
git commit -m "feat(livediff): group commands by intent in the registry"
```

---

### Task 3: Rewrite `--help` as the cheat sheet

**Files:**

- Modify: `server/cli-help-render.ts` (`renderMainHelp`)
- Modify: `server/cli-help.ts` (add `GET_STARTED`)
- Test: `test/cli-help-render.test.ts` (create)

**Interfaces:**

- Consumes: `CommandGroup`, `COMMANDS` from Task 2
- Produces: `export const GET_STARTED: readonly HelpRow[]`, rewritten `renderMainHelp(version: string): string`

- [ ] **Step 1: Add the curated GET STARTED block to `cli-help.ts`**

```ts
/**
 * Curated rather than derived: two of these lines are invocations, not command names, so
 * there is nothing in COMMANDS to generate them from. A test keeps them from going stale.
 */
export const GET_STARTED: readonly HelpRow[] = [
  ["livediff .", "review this worktree in the browser"],
  ["livediff comments", "read feedback on this branch"],
  ["livediff resolve <id> [text]", "answer and close a comment"],
  ["livediff status", "see what LiveDiff is doing here"],
];
```

- [ ] **Step 2: Write the failing drift test**

Create `test/cli-help-render.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { COMMANDS, GET_STARTED, findCommand } from "../server/cli-help.js";
import { renderMainHelp } from "../server/cli-help-render.js";

test("every GET STARTED line names a real command or the bare-path shorthand", () => {
  for (const [invocation] of GET_STARTED) {
    const token = invocation.split(" ")[1];
    assert.ok(token, `${invocation} has no token after "livediff"`);
    assert.ok(
      token === "." || findCommand(token) !== null,
      `${invocation} does not resolve to a command`,
    );
  }
});

test("the cheat sheet lists every command in a group row", () => {
  const help = renderMainHelp("0.0.0-test");
  for (const command of COMMANDS) {
    if (command.id === "help") continue;
    if (command.name.startsWith("<") || command.name.startsWith("(")) continue;
    assert.ok(help.includes(command.name), `${command.name} is missing from --help`);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test -- test/cli-help-render.test.ts`
Expected: the second test FAILS — the current `renderMainHelp` does list every name, so it may pass; the first test PASSES. If both pass, that is fine: they are drift guards, and the point is that they hold through the rewrite in the next step.

- [ ] **Step 4: Rewrite `renderMainHelp`**

In `server/cli-help-render.ts`:

```ts
const GROUP_LABELS: Record<CommandGroup, string> = {
  review: "REVIEW",
  manage: "MANAGE",
  setup: "SETUP",
};

const GROUP_ORDER: readonly CommandGroup[] = ["review", "manage", "setup"];

function visibleCommands(): readonly CommandHelp[] {
  return COMMANDS.filter(
    (c) => c.id !== "help" && !c.name.startsWith("<") && !c.name.startsWith("("),
  );
}

function groupRows(): HelpRow[] {
  return GROUP_ORDER.flatMap((group) => {
    const names = visibleCommands()
      .filter((command) => command.group === group)
      .map((command) => command.name);
    return names.length === 0 ? [] : [[GROUP_LABELS[group], names.join("  ")] as HelpRow];
  });
}

export function renderMainHelp(version: string): string {
  return [
    `${bold("livediff")} ${dim(`v${version}`)} — live git worktree diff hub`,
    "",
    bold("USAGE"),
    "  livediff [command] [options]",
    "",
    bold("GET STARTED"),
    pad(GET_STARTED),
    "",
    pad(groupRows()),
    "",
    bold("OPTIONS"),
    pad(GLOBAL_FLAGS),
    "",
    pad([
      ["livediff help", "all commands, grouped"],
      ["livediff help <command>", "one command in depth"],
      ["livediff help workflows", "how the review loop fits together"],
    ]),
  ].join("\n");
}
```

Note the EXAMPLES and ENVIRONMENT blocks are deliberately gone. GET STARTED replaces EXAMPLES, and ENVIRONMENT moves to the `environment` topic in Task 6.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- test/cli-help-render.test.ts`
Expected: both PASS.

- [ ] **Step 6: Eyeball the actual output**

Run: `pnpm build:server`, then `node dist-server/server/cli.js --help` as a separate command.
Expected: matches the spec's cheat-sheet mockup. Confirm it fits in about 25 lines.

- [ ] **Step 7: Gates and commit (after Shane approves)**

Run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` — each its own command, all clean.

```bash
git add server/cli-help.ts server/cli-help-render.ts test/cli-help-render.test.ts
git commit -m "feat(livediff): make --help a workflow-first cheat sheet"
```

---

### Task 4: Add the `help` index and split it from `--help`

**Files:**

- Modify: `server/cli-help-render.ts` (add `renderHelpIndex`)
- Modify: `server/cli.ts` (`helpFor`, `cmdHelp`, dispatch at line ~1011)
- Test: `test/cli-help-render.test.ts`, `test/cli.test.ts`

**Interfaces:**

- Produces: `renderHelpIndex(version: string): string`; `helpFor(tokens: readonly string[], opts: { verbose: boolean }): string | null`

- [ ] **Step 1: Write the failing test**

Add to `test/cli-help-render.test.ts`:

```ts
import { renderHelpIndex } from "../server/cli-help-render.js";

test("the index lists every command with its summary exactly once", () => {
  const index = renderHelpIndex("0.0.0-test");
  for (const command of COMMANDS) {
    if (command.id === "help") continue;
    if (command.name.startsWith("<") || command.name.startsWith("(")) continue;
    const occurrences = index.split(command.summary).length - 1;
    assert.equal(occurrences, 1, `${command.name} summary appears ${occurrences} times`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- test/cli-help-render.test.ts`
Expected: FAIL — `renderHelpIndex` is not exported.

- [ ] **Step 3: Implement `renderHelpIndex`**

```ts
const INDEX_GROUP_TITLES: Record<CommandGroup, string> = {
  review: "REVIEW",
  manage: "MANAGE",
  setup: "SETUP & SUPPORT",
};

export function renderHelpIndex(version: string): string {
  const sections = GROUP_ORDER.flatMap((group) => {
    const rows = visibleCommands()
      .filter((command) => command.group === group)
      .map((command) => [command.name, command.summary] as HelpRow);
    return rows.length === 0 ? [] : ["", bold(INDEX_GROUP_TITLES[group]), pad(rows)];
  });
  return [
    `${bold("livediff help")} ${dim(`v${version}`)} — what would you like?`,
    ...sections,
    "",
    bold("TOPICS"),
    pad([
      ["livediff help <topic>", "workflows | json | exit-codes | environment | agents"],
      ["livediff help <command>", "one command in depth"],
    ]),
  ].join("\n");
}
```

The TOPICS row is hard-coded here for now. Task 6 replaces it with a derivation from `TOPICS`.

- [ ] **Step 4: Run the test**

Run: `pnpm test -- test/cli-help-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `verbose` through `helpFor`**

In `server/cli.ts`, change the signature and the zero-token branch:

```ts
function helpFor(tokens: readonly string[], opts: { verbose: boolean }): string | null {
  const [token] = tokens;
  if (!token) return opts.verbose ? renderHelpIndex(hubVersion()) : renderMainHelp(hubVersion());
  const resolved = resolveHelpCommand(tokens);
  if (resolved === null) return null;
  // Only a resolved nested action renders with its parent prefix; bare `help config` is the
  // top-level command and must not become "config config".
  if (resolved.path.length === 2) {
    return resolved.path[0] === "config"
      ? renderConfigCommandHelp(resolved.command)
      : renderCompletionCommandHelp(resolved.command);
  }
  return renderCommandHelp(resolved.command);
}
```

- [ ] **Step 6: Pass the depth from both call sites**

`cmdHelp` gains the option and forwards it:

```ts
async function cmdHelp(
  tokens: readonly string[] = [],
  opts: { verbose: boolean } = { verbose: true },
): Promise<void> {
  const text = helpFor(tokens, opts);
  // …rest unchanged…
}
```

At line ~1011, the `--help` flag path passes `verbose: false`:

```ts
if (WANTS_HELP) {
  return cmdHelp(cmd === undefined ? [] : [cmd, ...rest], { verbose: false });
}
```

The `help` command's dispatch case keeps the default, which is `verbose: true`.

- [ ] **Step 7: Write the end-to-end test**

Add to `test/cli.test.ts`:

```ts
test("--help is the cheat sheet and help is the index", async () => {
  const concise = await cli(["--help"]);
  const index = await cli(["help"]);
  assert.equal(concise.code, 0);
  assert.equal(index.code, 0);
  assert.match(concise.stdout, /GET STARTED/);
  assert.match(index.stdout, /what would you like\?/);
  assert.notEqual(concise.stdout, index.stdout);
});
```

- [ ] **Step 8: Run it**

Run: `pnpm test -- -t "cheat sheet and help is the index"`
Expected: PASS.

- [ ] **Step 9: Gates and commit (after Shane approves)**

Run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`. All clean.

```bash
git add server/cli-help-render.ts server/cli.ts test/cli-help-render.test.ts test/cli.test.ts
git commit -m "feat(livediff): split the help index from the concise cheat sheet"
```

---

### Task 5: Two depths of per-command help

**Files:**

- Modify: `server/cli-help-render.ts` (`renderCommandHelp`, `renderConfigCommandHelp`, `renderCompletionCommandHelp`)
- Modify: `server/cli.ts` (`helpFor` forwards `verbose`)
- Test: `test/cli.test.ts`

**Interfaces:**

- Produces: `renderCommandHelp(cmd: CommandHelp, opts: { verbose: boolean }): string` and the same second parameter on both nested renderers

- [ ] **Step 1: Write the failing test**

Add to `test/cli.test.ts`:

```ts
test("concise command help omits details, verbose includes them", async () => {
  const concise = await cli(["open", "--help"]);
  const verbose = await cli(["help", "open"]);
  assert.equal(concise.code, 0);
  assert.equal(verbose.code, 0);
  assert.match(concise.stdout, /USAGE/);
  assert.doesNotMatch(concise.stdout, /never registers twice/);
  assert.match(verbose.stdout, /never registers twice/);
  assert.match(concise.stdout, /livediff help open/);
});
```

The phrase `never registers twice` is real text from the `open` entry's `details` in `server/cli-help.ts`. If that prose has changed, pick another distinctive phrase from the same block.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- -t "concise command help omits details"`
Expected: FAIL — both spellings currently render `details`.

- [ ] **Step 3: Add the parameter to `renderCommandHelp`**

```ts
export function renderCommandHelp(cmd: CommandHelp, opts: { verbose: boolean }): string {
  const out = [
    `${bold(`livediff ${cmd.name === "(no arguments)" ? "" : cmd.name}`.trim())} — ${cmd.summary}`,
    "",
    bold("USAGE"),
    `  ${cmd.usage}`,
  ];
  if (opts.verbose && cmd.details)
    out.push(
      "",
      cmd.details
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  if (cmd.aliases?.length) out.push("", bold("ALIASES"), `  ${cmd.aliases.join(", ")}`);
  if (cmd.flags.length) out.push("", bold("OPTIONS"), pad([...cmd.flags, ...GLOBAL_FLAGS]));
  else out.push("", bold("OPTIONS"), pad(GLOBAL_FLAGS));
  if (cmd.examples.length) out.push("", bold("EXAMPLES"), pad(cmd.examples));
  if (!opts.verbose && cmd.details)
    out.push("", dim(`  Run \`livediff help ${cmd.name}\` for full behavior and notes.`));
  return out.join("\n");
}
```

- [ ] **Step 4: Forward the parameter through both nested renderers**

```ts
export function renderConfigCommandHelp(command: CommandHelp, opts: { verbose: boolean }): string {
  return renderCommandHelp({ ...command, name: `config ${command.name}` }, opts);
}

export function renderCompletionCommandHelp(
  command: CommandHelp,
  opts: { verbose: boolean },
): string {
  return renderCommandHelp({ ...command, name: `completion ${command.name}` }, opts);
}
```

- [ ] **Step 5: Forward `opts` from `helpFor`**

Every `renderCommandHelp` / `renderConfigCommandHelp` / `renderCompletionCommandHelp` call inside `helpFor` gains `, opts`.

- [ ] **Step 6: Fix the render test's call sites**

`test/cli-help-render.test.ts` does not call `renderCommandHelp`, but `pnpm typecheck` will name any other caller. Update each to pass `{ verbose: true }`.

- [ ] **Step 7: Run the tests**

Run: `pnpm test`
Expected: all pass, including the new one.

- [ ] **Step 8: Verify the `help config` regression test still passes**

`test/cli.test.ts` has an existing test asserting `livediff help config` does not render as "livediff config config". Confirm it is still green — the `path.length === 2` guard must survive this change untouched.

Run: `pnpm test -- -t "config"`
Expected: PASS.

- [ ] **Step 9: Gates and commit (after Shane approves)**

Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. All clean.

```bash
git add server/cli-help-render.ts server/cli.ts test/cli.test.ts
git commit -m "feat(livediff): give every command a concise and a full help depth"
```

---

### Task 6: Conceptual topics

The largest task, and most of it is prose. Write the bodies in the voice described in Global Constraints.

**Files:**

- Create: `server/cli-topics.ts`
- Create: `test/cli-topics.test.ts`
- Modify: `server/cli-help-render.ts` (`renderTopic`, derive the index TOPICS row)
- Modify: `server/cli.ts` (`resolveHelpCommand`, `cmdHelp`), `server/cli-help.ts` (`suggest`)

**Interfaces:**

- Produces: `HelpTopic { name: string; summary: string; body: string }`, `TOPICS: readonly HelpTopic[]`, `findTopic(token: string): HelpTopic | null`, `topicNames(): string[]`, `renderTopic(topic: HelpTopic): string`

- [ ] **Step 1: Write the failing collision test**

Create `test/cli-topics.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { TOPICS, findTopic, topicNames } from "../server/cli-topics.js";
import { commandNames } from "../server/cli-help.js";

test("no topic name collides with a command name or alias", () => {
  const commands = new Set(commandNames());
  for (const topic of TOPICS) {
    assert.ok(
      !commands.has(topic.name),
      `topic "${topic.name}" is shadowed by a command and is unreachable`,
    );
  }
});

test("every topic has a summary and a body", () => {
  assert.equal(TOPICS.length, 5);
  for (const topic of TOPICS) {
    assert.ok(topic.summary.length > 0, `${topic.name} has no summary`);
    assert.ok(topic.body.length > 200, `${topic.name} body is too thin to be useful`);
  }
});

test("findTopic resolves exact names and rejects everything else", () => {
  assert.equal(findTopic("workflows")?.name, "workflows");
  assert.equal(findTopic("nope"), null);
  assert.deepEqual(topicNames().sort(), [
    "agents",
    "environment",
    "exit-codes",
    "json",
    "workflows",
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- test/cli-topics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/cli-topics.ts`**

```ts
/**
 * Conceptual help. Topics are prose, not commands — they have no arity, aliases, or options,
 * so they live outside the command registry that owns the command contract.
 */

export interface HelpTopic {
  name: string;
  summary: string;
  body: string;
}

export const TOPICS: readonly HelpTopic[] = [
  {
    name: "workflows",
    summary: "the review loop end to end",
    body: [
      "LiveDiff is built around a single loop: you register a worktree, look at it in the",
      "browser, leave comments on the lines that need attention, and then an agent — or you —",
      "works through those comments and closes them out.",
      "",
      "Registering is the only setup, and it happens implicitly. `livediff .` takes the",
      "worktree you are standing in, adds it to the registry, starts the hub if nothing is",
      "listening yet, and opens the diff. There is no server to start first and nothing written",
      "into the repository itself. Running it from a subdirectory still registers the worktree",
      "root, so the same worktree never ends up in the registry twice; the subdirectory just",
      "narrows what you see.",
      "",
      "Reviewing happens in the browser. Comments attach to a line and record the branch they",
      "were left on, which is why a comment written on one branch does not follow you to",
      "another. If you want the command to block while you review — useful when an agent is",
      "waiting on your feedback before it continues — `livediff review` waits until you click",
      '"Done reviewing".',
      "",
      "Answering happens back in the terminal. `livediff comments` prints the open threads for",
      "the current branch. `livediff reply <id> <text>` adds to a thread without closing it, and",
      "`livediff resolve <id> [text]` answers and closes in one step. Leaving comments open is a",
      "normal outcome rather than a failure; they are the product of the review.",
      "",
      "Comments that outlive their code are not deleted. Once the file they point at leaves the",
      "diff they become orphaned and drop out of the default views, still reachable with",
      "`--stale`. After long enough they are archived, and archived comments can be restored",
      "until they are eventually pruned. `livediff help archive` and `livediff help prune` cover",
      "the timing.",
    ].join("\n"),
  },
  {
    name: "json",
    summary: "machine-readable output for agents and scripts",
    body: [
      "Every command accepts `--json`, and the intent is that anything you can read on screen",
      "you can also parse. Human output is free to change wording; JSON output is treated as a",
      "contract.",
      "",
      "Exit codes carry the same meaning in both modes, so a script can branch on the code and",
      "only parse the payload when it needs the detail. See `livediff help exit-codes`.",
      "",
      "The command tree describes itself. `livediff help --json` prints a versioned descriptor",
      "of every command, nested action, argument, and option, and `livediff help <command>",
      "--json` prints a single entry. An agent can therefore ask the installed binary what it",
      "supports instead of relying on documentation that may describe a different version. The",
      "descriptor carries a `schemaVersion` field; fields are added over time, but existing",
      "fields do not change meaning without that version changing.",
      "",
      "Agents should talk to the CLI rather than to LiveDiff's files. The hub is the only writer",
      "of the registry and the comment store, which is what keeps concurrent commands from",
      "losing each other's work.",
    ].join("\n"),
  },
  {
    name: "exit-codes",
    summary: "what 0, 1, and 2 mean",
    body: [
      "LiveDiff uses three exit codes, and the distinction between them is meant to be useful in",
      "a script rather than merely conventional.",
      "",
      "  0  the command did what it was asked to do",
      "  1  the command was valid but something went wrong while running it",
      "  2  the command itself was wrong",
      "",
      "A `2` means the invocation never should have run: an unknown command, a misspelled flag, a",
      "missing required argument, an option given a value it does not accept. These are caught",
      "before anything starts a hub or touches state, so a `2` never leaves work half done.",
      "",
      "A `1` means LiveDiff tried and failed — the hub could not be reached, a path is not a git",
      "worktree, a comment id does not exist. Retrying may be reasonable.",
      "",
      "A review that ends with comments still open exits `0`. Open comments are the expected",
      "output of a review, not an error condition.",
    ].join("\n"),
  },
  {
    name: "environment",
    summary: "environment variables and how they rank against config",
    body: [
      "LiveDiff reads a handful of environment variables. They exist for the cases where a",
      "setting belongs to a shell session rather than to you permanently — a one-off port, a",
      "scripted run, a CI job.",
      "",
      "  LIVEDIFF_PORT      preferred hub port; the next free port is used if it is busy",
      "  LIVEDIFF_POLL_MS   live-update poll interval in milliseconds",
      "  LIVEDIFF_BROWSER   command used to open URLs, arguments allowed",
      "  LIVEDIFF_EDITOR    command used by `config edit`, arguments allowed",
      "  LIVEDIFF_RENDERER  default diff renderer, `fast` or `classic`",
      "  LIVEDIFF_OPEN      set to 1 to open a browser when the hub starts",
      "  NO_COLOR           disable colored output",
      "",
      "Two more control where state lives rather than how LiveDiff behaves: XDG_CONFIG_HOME",
      "decides where the registry and comments are kept, and XDG_STATE_HOME decides where the",
      "hub records its runtime port. Nothing is ever written inside a registered worktree.",
      "",
      "Environment variables win over the configuration file, which wins over built-in defaults.",
      "When a value is not doing what you expect, `livediff config explain <key>` names the",
      "source that won.",
    ].join("\n"),
  },
  {
    name: "agents",
    summary: "using LiveDiff from Claude Code and Codex",
    body: [
      "LiveDiff is built for working alongside agents, each in its own worktree, and the CLI is",
      "the integration surface. Anything an agent needs is a command, which means any",
      "shell-capable agent can participate without a resident server or a platform-specific",
      "plugin protocol.",
      "",
      "`./install.sh` registers this clone as a local marketplace and installs the LiveDiff",
      "plugin into whichever of Claude Code and Codex it finds. Restart the agent afterwards so",
      "it picks up the skills. Re-running the installer refreshes both after a pull.",
      "",
      'In practice the loop is conversational. Saying "show me the diff" gets the agent to run',
      "`livediff .` and hand back a URL. You leave inline comments in the browser, then say",
      '"address my comments" and the agent reads them with `livediff comments`, makes the edits,',
      "and closes each thread with `livediff resolve`.",
      "",
      "A few actions are typed rather than spoken, deliberately. `/livediff:link` prints a URL",
      "and opens nothing, `/livediff:review` opens the diff and waits for you to finish, and",
      "`/livediff:prune` previews what would be deleted before asking. Each has side effects",
      "whose timing you should own rather than delegate.",
      "",
      "Agents never read or write LiveDiff's storage directly. Comments are keyed per worktree,",
      "so parallel agents do not see each other's review threads.",
    ].join("\n"),
  },
];

export function findTopic(token: string): HelpTopic | null {
  return TOPICS.find((topic) => topic.name === token) ?? null;
}

export function topicNames(): string[] {
  return TOPICS.map((topic) => topic.name);
}
```

- [ ] **Step 4: Run the topic tests**

Run: `pnpm test -- test/cli-topics.test.ts`
Expected: all three PASS.

- [ ] **Step 5: Add `renderTopic` and derive the index TOPICS row**

In `server/cli-help-render.ts`:

```ts
import { TOPICS, topicNames, type HelpTopic } from "./cli-topics.js";

export function renderTopic(topic: HelpTopic): string {
  return [
    `${bold(`livediff help ${topic.name}`)} — ${topic.summary}`,
    "",
    topic.body
      .split("\n")
      .map((line) => (line === "" ? "" : `  ${line}`))
      .join("\n"),
  ].join("\n");
}
```

Replace the hard-coded TOPICS row in `renderHelpIndex` so it derives from the module:

```ts
    bold("TOPICS"),
    pad([
      ...TOPICS.map((topic) => [`livediff help ${topic.name}`, topic.summary] as HelpRow),
      ["livediff help <command>", "one command in depth"],
    ]),
```

- [ ] **Step 6: Resolve topics in `helpFor`**

In `server/cli.ts`, after the command lookup fails, try a topic. Commands must win, so the topic branch comes second:

```ts
function helpFor(tokens: readonly string[], opts: { verbose: boolean }): string | null {
  const [token] = tokens;
  if (!token) return opts.verbose ? renderHelpIndex(hubVersion()) : renderMainHelp(hubVersion());
  const resolved = resolveHelpCommand(tokens);
  if (resolved === null) {
    const topic = tokens.length === 1 ? findTopic(token) : null;
    return topic ? renderTopic(topic) : null;
  }
  // …unchanged nested-action and command branches…
}
```

- [ ] **Step 7: Teach `suggest` about topic names**

In `server/cli-help.ts`, `suggest` currently iterates `commandNames()`. It must not import `cli-topics.ts` — that would make the registry depend on prose. Take the candidate list as an optional parameter instead:

```ts
export function suggest(token: string, extra: readonly string[] = []): string | null {
  let best = null;
  let bestScore = Infinity;
  for (const name of [...commandNames(), ...extra]) {
    const score = distance(token.toLowerCase(), name.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore <= Math.max(2, Math.floor(token.length / 3)) ? best : null;
}
```

In `cmdHelp`, pass the topic names: `const hint = suggest(tokens[0] ?? "", topicNames());`

Leave every other `suggest` call site alone — the default keeps their behavior identical.

- [ ] **Step 8: Emit topics in JSON**

In `server/cli-help.ts`, add the descriptor type and the field:

```ts
export interface TopicDescriptor {
  name: string;
  summary: string;
}

export interface CliDescriptor {
  schemaVersion: number;
  version: string;
  globalOptions: readonly OptionDescriptor[];
  commands: readonly CommandDescriptor[];
  topics: readonly TopicDescriptor[];
}
```

`describeCli` must not import `cli-topics.ts` either. Take the topics as a parameter with an empty default so `scripts/generate-cli-docs.ts` keeps working unchanged:

```ts
export function describeCli(
  version: string,
  topics: readonly TopicDescriptor[] = [],
): CliDescriptor {
  // …existing body…, plus:
  //   topics,
}
```

In `server/cli.ts`, the `help --json` branch passes them:

```ts
if (JSON_OUT && tokens.length === 0) {
  console.log(
    JSON.stringify(
      describeCli(
        hubVersion(),
        TOPICS.map((topic) => ({ name: topic.name, summary: topic.summary })),
      ),
      null,
      2,
    ),
  );
  return;
}
```

Add a topic branch to `cmdHelp` before the command branch's `resolved` check, so `livediff help json --json` emits the topic rather than falling through:

```ts
const topic = tokens.length === 1 ? findTopic(tokens[0] ?? "") : null;
if (JSON_OUT && topic) {
  console.log(JSON.stringify(topic, null, 2));
  return;
}
```

- [ ] **Step 9: Write the end-to-end topic tests**

Add to `test/cli.test.ts`:

```ts
test("help renders each conceptual topic", async () => {
  for (const name of ["workflows", "json", "exit-codes", "environment", "agents"]) {
    const res = await cli(["help", name]);
    assert.equal(res.code, 0, `livediff help ${name} exited ${res.code}`);
    assert.ok(res.stdout.length > 200, `livediff help ${name} printed almost nothing`);
  }
});

test("a mistyped topic suggests the right one", async () => {
  const res = await cli(["help", "wrokflows"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /workflows/);
});

test("help --json lists the topics", async () => {
  const res = await cli(["help", "--json"]);
  assert.equal(res.code, 0);
  const descriptor = JSON.parse(res.stdout) as { topics: { name: string }[] };
  assert.equal(descriptor.topics.length, 5);
});

test("a command wins the namespace over a topic", async () => {
  const res = await cli(["help", "config"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /livediff config/);
  assert.doesNotMatch(res.stdout, /livediff config config/);
});
```

- [ ] **Step 10: Run everything**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 11: Read the topics as a user would**

Run `pnpm build:server`, then `node dist-server/server/cli.js help workflows` and each of the other four, one command each. Read them. Fix anything that reads as a bulleted list pretending to be a paragraph, or that explains _how_ before _why_.

- [ ] **Step 12: Gates and commit (after Shane approves)**

Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. All clean.

```bash
git add server/cli-topics.ts server/cli-help.ts server/cli-help-render.ts server/cli.ts test/cli-topics.test.ts test/cli.test.ts
git commit -m "feat(livediff): add conceptual help topics"
```

---

### Task 7: Update the README and the brainstorm status

**Files:**

- Modify: `README.md:103-118`
- Modify: `docs/CLI-UX-BRAINSTORM.md:7-32, 196-213`
- Regenerate: `docs/CLI.md`

- [ ] **Step 1: Point the README at the new help ladder**

In the paragraph after the `Use` block, replace the sentence describing `livediff help <command>` so it names all four rungs: `livediff --help` for the cheat sheet, `livediff help` for the grouped index, `livediff help <command>` for full behavior, and `livediff help workflows|json|exit-codes|environment|agents` for the conceptual topics. Keep the existing `docs/CLI.md` link.

- [ ] **Step 2: Verify the README coverage test still passes**

`test/cli-docs.test.ts` contains a README coverage assertion. Run: `pnpm test -- test/cli-docs.test.ts`
Expected: PASS. If it fails, the README's command list no longer matches the registry — fix the README, not the test.

- [ ] **Step 3: Mark P2 resolved in the brainstorm**

In `docs/CLI-UX-BRAINSTORM.md`, add to the "Implementation status" list a bullet describing the help ladder, and update section 6 ("Help is good locally but lacks progressive disclosure") with a `**Status: resolved in 0.9.**` line in the same style as sections 1, 7, and 9. Note in that status line that the pager and `help --all` were deliberately not built, and why.

- [ ] **Step 4: Update the deferred list**

The paragraph beginning "Still intentionally deferred" currently lists branch-name completion, JSON contracts, and runtime verification. Add `mayPrompt`/`mutates` annotations and `config list --sources`. Remove nothing else.

- [ ] **Step 5: Regenerate and run the gates**

Run: `pnpm docs:cli`
Run: `pnpm test`
Run: `pnpm lint`
Run: `pnpm format:check`
All clean.

- [ ] **Step 6: Decide on a version bump**

This adds user-visible CLI behavior — new output shapes, new `help <topic>` invocations, a new JSON field. That is a minor bump, not a patch. Bump `package.json`, `plugins/livediff/.claude-plugin/plugin.json`, and `plugins/livediff/.codex-plugin/plugin.json` to `0.9.0` together; `livediff doctor` cross-checks all three.

- [ ] **Step 7: Commit (after Shane approves)**

```bash
git add README.md docs/CLI-UX-BRAINSTORM.md docs/CLI.md package.json plugins/livediff/.claude-plugin/plugin.json plugins/livediff/.codex-plugin/plugin.json
git commit -m "docs(livediff): document the help ladder and release 0.9.0"
```

---

## Self-Review

**Spec coverage.** Cheat sheet → Task 3. Index → Task 4. Two per-command depths → Task 5. Five topics → Task 6. `group` on registry and descriptor → Task 2. `cli-topics.ts` → Task 6. `cli-help-render.ts` → Task 1. Dispatch and `suggest` → Tasks 4 and 6. `CliDescriptor.topics` and `help <topic> --json` → Task 6. Grouped `docs/CLI.md` → Task 2. All seven listed tests → Tasks 2, 3, 4, 5, 6. Out-of-scope items appear nowhere. No gaps.

**Type consistency.** `renderCommandHelp` gains `opts: { verbose: boolean }` in Task 5 and every caller is updated in the same task. `renderHelpIndex` is introduced in Task 4 and its TOPICS row is replaced in Task 6 — flagged inline at both points. `describeCli` gains an optional second parameter in Task 6, which is what keeps `scripts/generate-cli-docs.ts` compiling without a change. `suggest` gains an optional second parameter, so existing call sites are untouched.

**Two deliberate dependency rules**, both to stop the registry from depending on prose: `cli-help.ts` never imports `cli-topics.ts`, which is why `suggest` and `describeCli` take parameters rather than importing. Verify with `git grep -n "cli-topics" -- server/cli-help.ts`, which must return nothing.
