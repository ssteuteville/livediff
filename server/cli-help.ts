/**
 * One table drives dispatch, help, and did-you-mean suggestions, so a command can never appear
 * in help without being runnable — or vice versa.
 */

type HelpRow = readonly [string, string];

export interface CommandHelp {
  id: string;
  name: string;
  usage: string;
  summary: string;
  details: string;
  flags: readonly HelpRow[];
  examples: readonly HelpRow[];
  aliases?: readonly string[];
}

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

export const GLOBAL_FLAGS: readonly HelpRow[] = [
  ["--json", "machine-readable output"],
  ["-h, --help", "show help for a command"],
  ["-v, --version", "print the livediff version"],
];

/** Flags that consume the next token as their value. The parser needs this to keep it out of args. */
export const VALUE_FLAGS = new Set(["--timeout", "--status", "--branch", "--keep-days"]);

export const COMMANDS: readonly CommandHelp[] = [
  {
    id: "open",
    name: "<path>",
    usage: "livediff <path> [--no-open] [--wait] [--timeout <sec>]",
    summary: "register a worktree and open its focused view",
    details:
      "Registers the git worktree containing <path> and opens it in the browser.\n" +
      "Any subdirectory resolves to its worktree root, so the same worktree never\n" +
      "registers twice — the subdirectory becomes a view filter instead, showing\n" +
      "only files under it. The hub is started automatically if it is not running.\n" +
      "\n" +
      'With --wait, the command blocks until you click "Done reviewing" in the\n' +
      "browser, then prints a summary. Open comments are expected at that point —\n" +
      "they are the output of the review, not a failure.",
    flags: [
      ["--no-open", "register only; print the URL instead of launching a browser"],
      ["--wait", 'block until "Done reviewing" is clicked in the browser'],
      ["--timeout <sec>", "give up waiting after <sec> seconds (default: never)"],
    ],
    examples: [
      ["livediff .", "register the current worktree and open it"],
      ["livediff ~/work/feat-a", "register a worktree by path"],
      ["livediff apps/expo", "open the worktree, scoped to one directory"],
      ["livediff . --no-open --json", "register quietly and print JSON"],
      ["livediff . --wait", "open, then wait for the review to be marked done"],
    ],
  },
  {
    id: "hub",
    name: "(no arguments)",
    usage: "livediff [--no-open]",
    summary: "open the hub UI showing every registered workspace",
    details: "Starts the hub if needed, then opens the browser to the workspace rail.",
    flags: [["--no-open", "start the hub and print its URL without launching a browser"]],
    examples: [
      ["livediff", "open the hub UI"],
      ["livediff --no-open", "start the hub and print its URL"],
    ],
  },
  {
    id: "list",
    name: "list",
    aliases: ["ls"],
    usage: "livediff list",
    summary: "list registered workspaces",
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
      "livediff comments [path] [--status open|resolved|all] [--branch <name>] [--stale|--archived]",
    summary: "print review comments for a worktree",
    details:
      "Defaults to the worktree containing the current directory, to the branch that is\n" +
      "checked out, and to open comments only. Each comment prints the quoted source line\n" +
      "it was left on — trust that text over the line number, which drifts as you edit.\n" +
      "\n" +
      "Comments whose file has left the diff are hidden; --stale shows them.",
    flags: [
      ["--status <which>", "open (default), resolved, or all"],
      ["--branch <name>", "a branch name, or all (default: the current branch)"],
      ["--stale", "only comments whose file has left the diff"],
      ["--archived", "only archived comments, with days until they are purged"],
    ],
    examples: [
      ["livediff comments", "open comments on this worktree's current branch"],
      ["livediff comments --stale", "comments whose file is no longer in the diff"],
      ["livediff comments --archived", "what is archived and when it will be deleted"],
    ],
  },
  {
    id: "restore",
    name: "restore",
    usage: "livediff restore <id>",
    summary: "return an archived comment to the live view",
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
    details: "The reply text is optional; omitting it resolves the comment silently.",
    flags: [],
    examples: [["livediff resolve a1b2c3d4 fixed in the latest commit", "reply and resolve"]],
  },
  {
    id: "reply",
    name: "reply",
    usage: "livediff reply <id> <text...>",
    summary: "reply to a comment without resolving it",
    details: "",
    flags: [],
    examples: [["livediff reply a1b2c3d4 what did you mean here?", "reply only"]],
  },
  {
    id: "stop",
    name: "stop",
    usage: "livediff stop",
    summary: "shut the hub down",
    details:
      "The hub normally runs until you stop it or the machine reboots. Any command\n" +
      "will start it again.",
    flags: [],
    examples: [["livediff stop", "shut the hub down"]],
  },
  {
    id: "doctor",
    name: "doctor",
    usage: "livediff doctor",
    summary: "diagnose install and state problems",
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
    id: "help",
    name: "help",
    usage: "livediff help [command]",
    summary: "show help for livediff or a specific command",
    details: "",
    flags: [],
    examples: [["livediff help resolve", "show help for the resolve command"]],
  },
];

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
