/**
 * One table drives command grammar, help, completion, and did-you-mean suggestions. Dispatch
 * handlers live in cli.ts, but names, aliases, options, and positional arity have one source.
 */

type HelpRow = readonly [string, string];

export interface PositionalArity {
  min: number;
  max: number | null;
}

export type CompletionKind =
  | "path"
  | "workspace"
  | "comment-open"
  | "comment-archived"
  | "config-key"
  | "lens"
  | "shell";

export interface ArgSpec {
  name: string;
  required: boolean;
  variadic?: boolean;
  completion?: CompletionKind;
}

export interface CommandHelp {
  id: string;
  name: string;
  usage: string;
  summary: string;
  details: string;
  args: readonly ArgSpec[];
  flags: readonly HelpRow[];
  examples: readonly HelpRow[];
  aliases?: readonly string[];
}

export function arity(args: readonly ArgSpec[]): PositionalArity {
  return {
    min: args.filter((arg) => arg.required).length,
    max: args.some((arg) => arg.variadic) ? null : args.length,
  };
}

const flagNamePattern = /(?<!\S)(?:--[a-z][a-z-]*|-[a-zA-Z])(?=\s|,|$)/g;

export function optionNamesForRows(options: readonly HelpRow[]): readonly string[] {
  return options.flatMap(([usage]) => usage.match(flagNamePattern) ?? []);
}

export function optionNames(command: CommandHelp): readonly string[] {
  return optionNamesForRows(command.flags);
}

export function valueOptionNames(command: CommandHelp): readonly string[] {
  return command.flags.flatMap(([usage]) =>
    /<[^>]+>/.test(usage) ? (usage.match(flagNamePattern) ?? []) : [],
  );
}

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

export const GLOBAL_FLAGS: readonly HelpRow[] = [
  ["--json", "machine-readable output"],
  ["-h, --help", "show help for a command"],
  ["-v, --version", "print the livediff version"],
];

export const GLOBAL_OPTION_NAMES = new Set(optionNamesForRows(GLOBAL_FLAGS));

export const COMMANDS: readonly CommandHelp[] = [
  {
    id: "open",
    name: "open",
    usage:
      "livediff open [path] [--base <ref>] [--no-open] [--wait] [--timeout <sec>] [--lens <name>]",
    summary: "register a worktree and open its focused view",
    args: [{ name: "path", required: false, completion: "workspace" }],
    details:
      "Registers the selected worktree (the current directory by default) and opens it in the browser.\n" +
      "The shorthand `livediff <path>` remains supported. Any subdirectory resolves to its worktree\n" +
      "root, so the same worktree never registers twice — the subdirectory becomes a view filter\n" +
      "instead, showing only files under it. The hub is started automatically if it is not running.\n" +
      "\n" +
      'With --wait, the command blocks until you click "Done reviewing" in the\n' +
      "browser, then prints a summary. Open comments are expected at that point —\n" +
      "they are the output of the review, not a failure.\n" +
      "\n" +
      "--base sets what this worktree is reviewed against, and it sticks: the browser,\n" +
      "`livediff comments`, and the archive sweep all use it until you change it. Set it\n" +
      "when the work is already committed to a branch, or every comment looks stale.",
    flags: [
      ["--base <ref>", "review against <ref> instead of the last commit, and remember it"],
      ["--no-open", "register only; print the URL instead of launching a browser"],
      ["--wait", 'block until "Done reviewing" is clicked in the browser'],
      ["--timeout <sec>", "give up waiting after <sec> seconds (default: never)"],
      ["--lens <name>", "open with one lens already applied"],
    ],
    examples: [
      ["livediff open", "register the current worktree and open it"],
      ["livediff .", "the shorthand for opening the current worktree"],
      ["livediff ~/work/feat-a", "register a worktree by path"],
      ["livediff apps/expo", "open the worktree, scoped to one directory"],
      ["livediff . --base main", "review everything this branch adds on top of main"],
      ["livediff . --no-open --json", "register quietly and print JSON"],
      ["livediff . --wait", "open, then wait for the review to be marked done"],
    ],
  },
  {
    id: "hub",
    name: "hub",
    usage: "livediff hub [--no-open]",
    summary: "open the hub UI showing every registered workspace",
    args: [],
    details:
      "Starts the hub if needed, then opens the browser to the workspace rail.\n" +
      "`livediff` without arguments is the shorthand for this command.",
    flags: [["--no-open", "start the hub and print its URL without launching a browser"]],
    examples: [
      ["livediff hub", "open the hub UI"],
      ["livediff", "the shorthand for opening the hub UI"],
      ["livediff --no-open", "start the hub and print its URL"],
    ],
  },
  {
    id: "review",
    name: "review",
    usage: "livediff review [path] [--base <ref>] [--no-open] [--timeout <sec>] [--lens <name>]",
    summary: "open a worktree and wait for the reviewer to finish",
    args: [{ name: "path", required: false, completion: "workspace" }],
    details:
      "Equivalent to `livediff open [path] --wait`. This is the clearest command for\n" +
      "agent and human review handoffs; it prints the comment summary after Done reviewing.\n" +
      "\n" +
      "If you have already committed the work, pass --base <branch>. Without it the diff\n" +
      "is only what is uncommitted, and comments left on committed files read as stale.",
    flags: [
      ["--base <ref>", "review against <ref> instead of the last commit, and remember it"],
      ["--no-open", "register only; print the URL instead of launching a browser"],
      ["--timeout <sec>", "give up waiting after <sec> seconds (default: never)"],
      ["--lens <name>", "open with one lens already applied"],
    ],
    examples: [
      ["livediff review", "review the current worktree and wait"],
      ["livediff review --base main", "review the whole branch, not just uncommitted work"],
      ["livediff review . --lens retry", "hand off with one lens applied on arrival"],
    ],
  },
  {
    id: "link",
    name: "link",
    usage: "livediff link [path]",
    summary: "print a focused worktree URL without opening a browser",
    args: [{ name: "path", required: false, completion: "workspace" }],
    details: "Registers the worktree if needed, then prints its URL for a human, script, or agent.",
    flags: [],
    examples: [["livediff link .", "print the current worktree's focused URL"]],
  },
  {
    id: "list",
    name: "list",
    aliases: ["ls"],
    usage: "livediff list",
    summary: "list registered workspaces",
    args: [],
    details: "Shows each workspace's id, label, and path, with live branch and change counts.",
    flags: [],
    examples: [["livediff list --json", "list workspaces as JSON"]],
  },
  {
    id: "rm",
    name: "rm",
    aliases: ["remove"],
    usage: "livediff rm [path|id]",
    summary: "unregister a workspace",
    args: [{ name: "path|id", required: false, completion: "workspace" }],
    details:
      "Unregisters the workspace. The repository and its comments are left untouched,\n" +
      "so re-registering the same path restores its comment history.",
    flags: [],
    examples: [
      ["livediff rm", "unregister the current worktree"],
      ["livediff rm a1b2c3d4", "unregister by id"],
    ],
  },
  {
    id: "comments",
    name: "comments",
    usage:
      "livediff comments [path] [--status open|resolved|all] [--branch <name>] [--base <ref>] [--stale|--archived]",
    summary: "print review comments for a worktree",
    args: [{ name: "path", required: false, completion: "workspace" }],
    details:
      "Defaults to the worktree containing the current directory, to the branch that is\n" +
      "checked out, and to open comments only. Each comment prints the quoted source line\n" +
      "it was left on — trust that text over the line number, which drifts as you edit.\n" +
      "\n" +
      "Comments whose file has left the diff are hidden; --stale shows them. What counts\n" +
      "as the diff is the worktree's stored base — set it with `livediff open --base <ref>`\n" +
      "or the browser's compare-against box. If everything looks stale, that is the reason:\n" +
      "the base is the last commit and the work is already committed. --base overrides it\n" +
      "for one command without changing what is stored.",
    flags: [
      ["--status <which>", "open (default), resolved, or all"],
      ["--branch <name>", "a branch name, or all (default: the current branch)"],
      ["--base <ref>", "judge staleness against <ref> for this command only"],
      ["--stale", "only comments whose file has left the diff"],
      ["--archived", "only archived comments, with days until they are purged"],
    ],
    examples: [
      ["livediff comments", "open comments on this worktree's current branch"],
      ["livediff comments --base main", "judge staleness against main, just this once"],
      ["livediff comments --stale", "comments whose file is no longer in the diff"],
      ["livediff comments --archived", "what is archived and when it will be deleted"],
    ],
  },
  {
    id: "lens",
    name: "lens",
    usage: "livediff lens <set|add|list|rm|clear> [...]",
    summary: "define the ways to read this change",
    args: [{ name: "subcommand", required: false }],
    details:
      "A lens narrows the diff to a set of files and marks ranges inside them. A lens set\n" +
      "belongs to a review handoff: the agent writes the whole set when it stops working,\n" +
      "and the next handoff replaces it.\n" +
      "\n" +
      "`lens set` reads the whole set as JSON on stdin and is the path an agent should use —\n" +
      "one write, no chance of two concurrent commands dropping each other's lenses.",
    flags: [],
    examples: [
      ["livediff lens list", "show this workspace's lenses and what each one matches"],
      ["livediff lens add tests --path 'test/**'", "add one lens by hand"],
    ],
  },
  {
    id: "restore",
    name: "restore",
    usage: "livediff restore <id>",
    summary: "return an archived comment to the live view",
    args: [{ name: "id", required: true, completion: "comment-archived" }],
    details:
      "Clears the archive flag and resets the comment's age, so the next sweep does not\n" +
      "immediately archive it again. Resolves the workspace from the current directory.",
    flags: [],
    examples: [["livediff restore a1b2c3d4", "un-archive a comment"]],
  },
  {
    id: "archive",
    name: "archive",
    usage: "livediff archive [path] [--stale] [--resolved]",
    summary: "archive comments that are no longer live",
    args: [{ name: "path", required: false, completion: "workspace" }],
    details:
      "Archives comments whose file has left the diff for more than 5 days, and resolved\n" +
      "comments untouched for more than 30. Archived comments are hidden but restorable\n" +
      "for 200 days.\n" +
      "\n" +
      "Defaults to EVERY registered workspace, unlike the review commands — pass a path\n" +
      "to narrow it. --stale and --resolved override only the age gates.",
    flags: [
      ["--stale", "archive every orphaned comment, whatever its age"],
      ["--resolved", "archive every resolved comment, whatever its age"],
    ],
    examples: [
      ["livediff archive", "archive what qualifies, everywhere"],
      ["livediff archive . --stale", "archive this worktree's orphaned comments now"],
    ],
  },
  {
    id: "prune",
    name: "prune",
    usage: "livediff prune [path] [--keep-days <n> | --all] [--dry-run] [--yes]",
    summary: "delete archived comments",
    args: [{ name: "path", required: false, completion: "workspace" }],
    details:
      "Deletes archived comments older than 200 days by default. Deleting sooner than that\n" +
      "asks for confirmation first, unless --yes is passed.\n" +
      "\n" +
      "Defaults to EVERY registered workspace, unlike the review commands — pass a path\n" +
      "to narrow it. This is the only command that destroys data; --dry-run shows what it\n" +
      "would remove.",
    flags: [
      ["--keep-days <n>", "delete archived comments older than n days"],
      ["--all", "delete every archived comment"],
      ["--dry-run", "report what would be deleted without deleting it"],
      ["--yes", "skip the confirmation prompt"],
    ],
    examples: [
      ["livediff prune --dry-run", "see what would be deleted"],
      ["livediff prune --keep-days 30 --yes", "keep only the last 30 days of archive"],
    ],
  },
  {
    id: "resolve",
    name: "resolve",
    usage: "livediff resolve <id> [text...]",
    summary: "reply to a comment and mark it resolved",
    args: [
      { name: "id", required: true, completion: "comment-open" },
      { name: "text", required: false, variadic: true },
    ],
    details: "The reply text is optional; omitting it resolves the comment silently.",
    flags: [],
    examples: [["livediff resolve a1b2c3d4 fixed in the latest commit", "reply and resolve"]],
  },
  {
    id: "reply",
    name: "reply",
    usage: "livediff reply <id> <text...>",
    summary: "reply to a comment without resolving it",
    args: [
      { name: "id", required: true, completion: "comment-open" },
      { name: "text", required: true, variadic: true },
    ],
    details: "",
    flags: [],
    examples: [["livediff reply a1b2c3d4 what did you mean here?", "reply only"]],
  },
  {
    id: "config",
    name: "config",
    usage: "livediff config [edit|path|init|validate|list|get|set|unset|explain|schema]",
    summary: "view and manage per-user LiveDiff settings",
    args: [
      { name: "action", required: false },
      { name: "key", required: false, completion: "config-key" },
      { name: "value", required: false, variadic: true },
    ],
    details:
      "Settings live in $XDG_CONFIG_HOME/livediff/config.jsonc (default: ~/.config/livediff).\n" +
      "Built-in defaults are overridden by this file, then LIVEDIFF_* environment variables,\n" +
      "then explicit command flags. Hub settings take effect after the hub restarts.",
    flags: [],
    examples: [
      ["livediff config edit", "open a validated, schema-backed config draft in an editor"],
      ["livediff config init", "create a commented config file without overwriting"],
      ["livediff config set browser.opener cmux browser open", "use cmux to open URLs"],
      ["livediff config set retention.archiveWarningBytes 10485760", "warn at 10 MiB"],
      ["livediff config list", "show effective settings"],
      ["livediff config schema --update", "refresh editor completion without changing settings"],
    ],
  },
  {
    id: "restart",
    name: "restart",
    usage: "livediff restart",
    summary: "restart the hub to apply cached settings",
    args: [],
    details:
      "Stops the running hub if there is one, then starts the current CLI version.\n" +
      "Use this after changing hub, retention, or default-renderer configuration.",
    flags: [],
    examples: [["livediff restart", "apply cached configuration changes"]],
  },
  {
    id: "status",
    name: "status",
    usage: "livediff status",
    summary: "show whether the hub is running and where settings live",
    args: [],
    details:
      "Does not start the hub. A stale result means LiveDiff found previous hub state but could not\n" +
      "reach that process; run `livediff restart` to recover.",
    flags: [],
    examples: [["livediff status", "check LiveDiff without changing anything"]],
  },
  {
    id: "stop",
    name: "stop",
    usage: "livediff stop",
    summary: "shut the hub down",
    args: [],
    details:
      "The hub normally runs until you stop it or the machine reboots. Any command\n" +
      "will start it again.",
    flags: [],
    examples: [["livediff stop", "shut the hub down"]],
  },
  {
    id: "setup",
    name: "setup",
    usage:
      "livediff setup [--agent <name>]... [--browser <cmux|system>] [--cli-only] [--update] [--yes]",
    summary: "install livediff persistently and integrate it with your agents",
    args: [],
    details:
      "Installs the livediff CLI through npm, then installs the LiveDiff integration for each\n" +
      "selected agent: claude, codex, cursor, copilot, gemini, or opencode. Rerunning it\n" +
      "reconciles what is installed without resetting other agents or your browser choice.\n" +
      "Nothing opens a repository or starts a review. Without a terminal, or with --json or\n" +
      "--yes, pass --agent, --cli-only, or --update; setup never prompts, installs Git or gh,\n" +
      "or signs in unattended. Exits 1 if any requested component failed (skipped optional\n" +
      "features such as GitHub PR support are not failures) and 2 on invalid usage.",
    flags: [
      ["--agent <name>", "integrate with an agent; repeat for several"],
      ["--browser <cmux|system>", "where reviews open, for every agent"],
      ["--cli-only", "install the CLI without changing any agent"],
      ["--update", "update the CLI and recorded integrations"],
      ["--yes", "run without prompts (needs --agent, --cli-only, or --update)"],
    ],
    examples: [
      ["npx livediff@latest setup", "guided first installation"],
      ["npx livediff@latest setup --agent codex --browser cmux", "Codex, opening in cmux"],
      ["livediff setup --agent gemini", "add Gemini CLI to an existing install"],
      ["livediff setup --update", "update the CLI and its integrations"],
    ],
  },
  {
    id: "doctor",
    name: "doctor",
    usage: "livediff doctor",
    summary: "diagnose install and state problems",
    args: [],
    details:
      "Checks that livediff resolves to exactly one binary, that the running hub\n" +
      "matches this CLI's version, that no stale state or unmigrated registry\n" +
      "entries remain, and that the Claude plugin is at a matching version.\n" +
      "Exits non-zero if anything is actually broken.",
    flags: [],
    examples: [
      ["livediff doctor", "check the install"],
      ["livediff doctor --json", "machine-readable findings"],
    ],
  },
  {
    id: "completion",
    name: "completion",
    usage: "livediff completion <bash|zsh|fish|install|path|status|uninstall> [shell]",
    summary: "generate, install, or inspect shell completion",
    args: [
      { name: "action", required: false },
      { name: "shell", required: false, completion: "shell" },
    ],
    details:
      "Source the generated script in your shell startup file. It is generated from LiveDiff's\n" +
      "own command metadata, so installed completions track the CLI's documented commands.",
    flags: [],
    examples: [
      ["source <(livediff completion zsh)", "enable completions in the current zsh session"],
      [
        "livediff completion fish > ~/.config/fish/completions/livediff.fish",
        "install fish completions",
      ],
    ],
  },
  {
    id: "help",
    name: "help",
    usage: "livediff help [command]",
    summary: "show help for livediff or a specific command",
    args: [
      { name: "command", required: false },
      { name: "subcommand", required: false },
    ],
    details: "",
    flags: [],
    examples: [["livediff help resolve", "show help for the resolve command"]],
  },
];

export const CONFIG_COMMANDS: readonly CommandHelp[] = [
  {
    id: "edit",
    name: "edit",
    usage: "livediff config edit [--editor <command>]",
    summary: "edit configuration safely in your preferred editor",
    args: [],
    details:
      "Creates a schema-linked config if needed, edits a sibling draft, and only installs it after\n" +
      "validation succeeds. Editor precedence: --editor, LIVEDIFF_EDITOR, tools.editor, VISUAL, EDITOR, vim.",
    flags: [["--editor <command>", "override the editor command for this edit"]],
    examples: [
      ["livediff config edit", "edit with the configured or detected editor"],
      ["livediff config edit --editor 'code --wait'", "edit with a one-off editor command"],
    ],
  },
  {
    id: "path",
    name: "path",
    usage: "livediff config path",
    summary: "print the config file path",
    args: [],
    details: "",
    flags: [],
    examples: [],
  },
  {
    id: "init",
    name: "init",
    usage: "livediff config init",
    summary: "create a minimal config without overwriting",
    args: [],
    details: "",
    flags: [],
    examples: [],
  },
  {
    id: "validate",
    name: "validate",
    usage: "livediff config validate",
    summary: "validate effective configuration",
    args: [],
    details: "",
    flags: [],
    examples: [],
  },
  {
    id: "list",
    name: "list",
    usage: "livediff config list",
    summary: "show effective configuration values",
    args: [],
    details: "",
    flags: [],
    examples: [],
  },
  {
    id: "get",
    name: "get",
    usage: "livediff config get <key>",
    summary: "print one effective setting",
    args: [{ name: "key", required: true, completion: "config-key" }],
    details: "",
    flags: [],
    examples: [],
  },
  {
    id: "set",
    name: "set",
    usage: "livediff config set <key> <value...>",
    summary: "set one user configuration override",
    args: [
      { name: "key", required: true, completion: "config-key" },
      { name: "value", required: true, variadic: true },
    ],
    details: "Use ordinary shell arguments for command settings, or a JSON array for exact argv.",
    flags: [],
    examples: [],
  },
  {
    id: "unset",
    name: "unset",
    usage: "livediff config unset <key>",
    summary: "remove one user configuration override",
    args: [{ name: "key", required: true, completion: "config-key" }],
    details: "The next lower-precedence source becomes effective.",
    flags: [],
    examples: [],
  },
  {
    id: "explain",
    name: "explain",
    usage: "livediff config explain <key>",
    summary: "explain one setting's effective value and source",
    args: [{ name: "key", required: true, completion: "config-key" }],
    details: "",
    flags: [],
    examples: [],
  },
  {
    id: "schema",
    name: "schema",
    usage: "livediff config schema [--update]",
    summary: "print or refresh the editor schema",
    args: [],
    details: "",
    flags: [["--update", "replace only the bundled schema file"]],
    examples: [],
  },
];

export const LENS_COMMANDS: readonly CommandHelp[] = [
  {
    id: "set",
    name: "set",
    usage: "livediff lens set",
    summary: "replace the whole lens set from JSON on stdin",
    args: [],
    details:
      "Reads `{ lenses: [...] }` (or a bare array) from stdin and replaces the workspace's\n" +
      "entire lens set in one write. This is the command an agent should use at handoff —\n" +
      "one write means no chance of two concurrent commands dropping each other's lenses.",
    flags: [],
    examples: [["livediff lens set < lenses.json", "replace the set from a file"]],
  },
  {
    id: "add",
    name: "add",
    usage: "livediff lens add <name> --path <glob> [--why <text>] [--highlight <path:start-end>]",
    summary: "add or replace one lens by hand",
    args: [{ name: "name", required: true }],
    details:
      "--path may be repeated; the lens matches the union of all of them. --highlight may also\n" +
      "be repeated, one per range. Adding a name that already exists replaces that lens in place,\n" +
      "keeping its position in the list.",
    flags: [
      ["--path <glob>", "a file glob the lens matches (repeatable, required)"],
      ["--why <text>", "a short note on what this lens is for"],
      ["--highlight <path:start-end>", "a new-side line range to mark (repeatable)"],
    ],
    examples: [
      ["livediff lens add tests --path 'test/**' --why coverage", "add a lens over the tests"],
      [
        "livediff lens add retry --path src/retry.ts --highlight src/retry.ts:88-104",
        "add a lens with one highlighted range",
      ],
    ],
  },
  {
    id: "list",
    name: "list",
    usage: "livediff lens list",
    summary: "show this workspace's lenses",
    args: [],
    details: "Each lens's file count is resolved against the current diff, so a zero is visible.",
    flags: [],
    examples: [["livediff lens list --json", "list lenses as JSON"]],
  },
  {
    id: "rm",
    name: "rm",
    usage: "livediff lens rm <name>",
    summary: "remove one lens",
    args: [{ name: "name", required: true, completion: "lens" }],
    details: "",
    flags: [],
    examples: [["livediff lens rm tests", "remove the tests lens"]],
  },
  {
    id: "clear",
    name: "clear",
    usage: "livediff lens clear",
    summary: "remove every lens",
    args: [],
    details: "",
    flags: [],
    examples: [["livediff lens clear", "empty this workspace's lens set"]],
  },
];

export const COMPLETION_COMMANDS: readonly CommandHelp[] = [
  {
    id: "bash",
    name: "bash",
    usage: "livediff completion bash",
    summary: "print bash completion",
    details: "",
    args: [],
    flags: [],
    examples: [],
  },
  {
    id: "zsh",
    name: "zsh",
    usage: "livediff completion zsh",
    summary: "print zsh completion",
    details: "",
    args: [],
    flags: [],
    examples: [],
  },
  {
    id: "fish",
    name: "fish",
    usage: "livediff completion fish",
    summary: "print fish completion",
    details: "",
    args: [],
    flags: [],
    examples: [],
  },
  {
    id: "install",
    name: "install",
    usage: "livediff completion install [bash|zsh|fish] [--activate]",
    summary: "write a generated completion script",
    details: "Uses the current shell when omitted. --activate adds a marked startup block.",
    args: [{ name: "shell", required: false, completion: "shell" }],
    flags: [["--activate", "source the installed completion from the shell startup file"]],
    examples: [],
  },
  {
    id: "path",
    name: "path",
    usage: "livediff completion path [bash|zsh|fish]",
    summary: "print the generated completion file path",
    details: "",
    args: [{ name: "shell", required: false, completion: "shell" }],
    flags: [],
    examples: [],
  },
  {
    id: "status",
    name: "status",
    usage: "livediff completion status [bash|zsh|fish]",
    summary: "show whether completion is installed and activated",
    details: "",
    args: [{ name: "shell", required: false, completion: "shell" }],
    flags: [],
    examples: [],
  },
  {
    id: "uninstall",
    name: "uninstall",
    usage: "livediff completion uninstall [bash|zsh|fish] [--deactivate]",
    summary: "remove an installed completion script",
    details: "--deactivate removes only LiveDiff's marked startup block.",
    args: [{ name: "shell", required: false, completion: "shell" }],
    flags: [["--deactivate", "also remove LiveDiff's startup block"]],
    examples: [],
  },
];

/** Flags that consume the next token as their value. The parser needs this to keep it out of args. */
export const VALUE_FLAGS = new Set([
  ...COMMANDS.flatMap(valueOptionNames),
  ...CONFIG_COMMANDS.flatMap(valueOptionNames),
  ...LENS_COMMANDS.flatMap(valueOptionNames),
]);

export function findConfigCommand(token: string): CommandHelp | null {
  return CONFIG_COMMANDS.find((command) => command.name === token) ?? null;
}

export function findLensCommand(token: string): CommandHelp | null {
  return LENS_COMMANDS.find((command) => command.name === token) ?? null;
}

export function findCompletionCommand(token: string): CommandHelp | null {
  return COMPLETION_COMMANDS.find((command) => command.name === token) ?? null;
}

export function renderConfigCommandHelp(command: CommandHelp): string {
  return renderCommandHelp({ ...command, name: `config ${command.name}` });
}

export function renderLensCommandHelp(command: CommandHelp): string {
  return renderCommandHelp({ ...command, name: `lens ${command.name}` });
}

/** Every name a user could type to reach a command. */
export function commandNames(): string[] {
  return COMMANDS.flatMap((c) =>
    c.name.startsWith("<") || c.name.startsWith("(") ? [] : [c.name, ...(c.aliases ?? [])],
  );
}

export function findCommand(token: string): CommandHelp | null {
  return COMMANDS.find((c) => c.name === token || (c.aliases ?? []).includes(token)) ?? null;
}

function pad(rows: readonly HelpRow[]): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${dim(right)}`).join("\n");
}

export function renderMainHelp(version: string): string {
  const commandRows: HelpRow[] = COMMANDS.filter((c) => c.id !== "help").map((c) => [
    c.name,
    c.summary,
  ]);
  return [
    `${bold("livediff")} ${dim(`v${version}`)} — live git worktree diff hub with agent-readable review comments`,
    "",
    bold("USAGE"),
    "  livediff [command] [options]",
    "",
    bold("COMMANDS"),
    pad(commandRows),
    "",
    bold("OPTIONS"),
    pad(GLOBAL_FLAGS),
    "",
    bold("EXAMPLES"),
    pad([
      ["livediff .", "register this worktree and open it"],
      ["livediff", "open the hub UI"],
      ["livediff comments", "read review comments left on this worktree"],
      ["livediff resolve <id> done", "reply and resolve a comment"],
    ]),
    "",
    bold("ENVIRONMENT"),
    pad([
      ["LIVEDIFF_PORT", "preferred hub port (default 4180)"],
      ["LIVEDIFF_POLL_MS", "live-update poll interval in ms (default 1000)"],
      ["LIVEDIFF_BROWSER", "command used to open URLs, args allowed (default: the OS opener)"],
      ["LIVEDIFF_EDITOR", "command used by `config edit`, args allowed"],
      ["NO_COLOR", "disable colored output"],
    ]),
    "",
    dim("Run `livediff help <command>` for details on a command."),
  ].join("\n");
}

export function renderCommandHelp(cmd: CommandHelp): string {
  const out = [
    `${bold(`livediff ${cmd.name === "(no arguments)" ? "" : cmd.name}`.trim())} — ${cmd.summary}`,
    "",
    bold("USAGE"),
    `  ${cmd.usage}`,
  ];
  if (cmd.details)
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
  return out.join("\n");
}

export function renderCompletionCommandHelp(command: CommandHelp): string {
  return renderCommandHelp({ ...command, name: "completion " + command.name });
}

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

/** Nearest command name within a small edit distance, or null when nothing is close enough. */
export function suggest(token: string): string | null {
  let best = null;
  let bestScore = Infinity;
  for (const name of commandNames()) {
    const score = distance(token.toLowerCase(), name.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore <= Math.max(2, Math.floor(token.length / 3)) ? best : null;
}

export const INTROSPECTION_SCHEMA_VERSION = 1;

export interface OptionDescriptor {
  flags: readonly string[];
  description: string;
  takesValue: boolean;
}

export interface CommandDescriptor {
  name: string;
  path: readonly string[];
  summary: string;
  usage: string;
  aliases: readonly string[];
  arguments: readonly ArgSpec[];
  options: readonly OptionDescriptor[];
  examples: readonly { command: string; description: string }[];
}

export interface CliDescriptor {
  schemaVersion: number;
  version: string;
  globalOptions: readonly OptionDescriptor[];
  commands: readonly CommandDescriptor[];
}

function describeOptions(options: readonly HelpRow[]): readonly OptionDescriptor[] {
  return options.map(([usage, description]) => ({
    flags: usage.match(flagNamePattern) ?? [],
    description,
    takesValue: /<[^>]+>/.test(usage),
  }));
}

export function describeCommand(command: CommandHelp, path: readonly string[]): CommandDescriptor {
  return {
    name: path.join(" "),
    path,
    summary: command.summary,
    usage: command.usage,
    aliases: command.aliases ?? [],
    arguments: command.args,
    options: describeOptions(command.flags),
    examples: command.examples.map(([cmd, description]) => ({ command: cmd, description })),
  };
}

export function describeCli(version: string): CliDescriptor {
  const globalOptions = describeOptions(GLOBAL_FLAGS);
  const commands = [
    ...COMMANDS.map((command) => describeCommand(command, [command.name])),
    ...CONFIG_COMMANDS.map((command) => describeCommand(command, ["config", command.name])),
    ...LENS_COMMANDS.map((command) => describeCommand(command, ["lens", command.name])),
    ...COMPLETION_COMMANDS.map((command) => describeCommand(command, ["completion", command.name])),
  ];
  return { schemaVersion: INTROSPECTION_SCHEMA_VERSION, version, globalOptions, commands };
}
