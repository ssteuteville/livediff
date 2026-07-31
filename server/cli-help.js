/**
 * One table drives dispatch, help, and did-you-mean suggestions, so a command can never appear
 * in help without being runnable — or vice versa.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

export const GLOBAL_FLAGS = [
  ["--json", "machine-readable output"],
  ["-h, --help", "show help for a command"],
  ["-v, --version", "print the livediff version"],
];

export const COMMANDS = [
  {
    id: "open",
    name: "<path>",
    usage: "livediff <path> [--no-open] [--wait] [--timeout <sec>]",
    summary: "register a worktree and open its focused view",
    details:
      "Registers the git worktree containing <path> and opens it in the browser.\n" +
      "Any subdirectory resolves to its worktree root, so the same worktree never\n" +
      "registers twice. The hub is started automatically if it is not running.\n" +
      "\n" +
      "With --wait, the command blocks until you click \"Done reviewing\" in the\n" +
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
      ["livediff . --no-open --json", "register quietly and print JSON"],
      ["livediff . --wait", "open, then wait for the review to be marked done"],
    ],
  },
  {
    id: "hub",
    name: "(no arguments)",
    usage: "livediff",
    summary: "open the hub UI showing every registered workspace",
    details: "Starts the hub if needed, then opens the browser to the workspace rail.",
    flags: [],
    examples: [["livediff", "open the hub UI"]],
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
    usage: "livediff comments [path]",
    summary: "print review comments for a worktree",
    details: "Defaults to the worktree containing the current directory.",
    flags: [],
    examples: [["livediff comments --json", "read this worktree's comments as JSON"]],
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
export function commandNames() {
  return COMMANDS.flatMap((c) => (c.name.startsWith("<") || c.name.startsWith("(") ? [] : [c.name, ...(c.aliases ?? [])]));
}

export function findCommand(token) {
  return COMMANDS.find((c) => c.name === token || (c.aliases ?? []).includes(token)) ?? null;
}

function pad(rows) {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${dim(right)}`).join("\n");
}

export function renderMainHelp(version) {
  const commandRows = COMMANDS.filter((c) => c.id !== "help").map((c) => [c.name, c.summary]);
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
      ["NO_COLOR", "disable colored output"],
    ]),
    "",
    dim("Run `livediff help <command>` for details on a command."),
  ].join("\n");
}

export function renderCommandHelp(cmd) {
  const out = [
    `${bold(`livediff ${cmd.name === "(no arguments)" ? "" : cmd.name}`.trim())} — ${cmd.summary}`,
    "",
    bold("USAGE"),
    `  ${cmd.usage}`,
  ];
  if (cmd.details) out.push("", cmd.details.split("\n").map((l) => `  ${l}`).join("\n"));
  if (cmd.aliases?.length) out.push("", bold("ALIASES"), `  ${cmd.aliases.join(", ")}`);
  if (cmd.flags.length) out.push("", bold("OPTIONS"), pad([...cmd.flags, ...GLOBAL_FLAGS]));
  else out.push("", bold("OPTIONS"), pad(GLOBAL_FLAGS));
  if (cmd.examples.length) out.push("", bold("EXAMPLES"), pad(cmd.examples));
  return out.join("\n");
}

function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

/** Nearest command name within a small edit distance, or null when nothing is close enough. */
export function suggest(token) {
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
