import {
  COMMANDS,
  COMPLETION_COMMANDS,
  CONFIG_COMMANDS,
  GLOBAL_FLAGS,
  optionNamesForRows,
  type CommandHelp,
} from "./cli-help.js";
import { CONFIG_KEYS } from "./config.js";

export type CompletionShell = "bash" | "zsh" | "fish";

type Candidate = { name: string; summary: string };

/**
 * Commands whose first positional is a registered workspace path, or a comment id — completed
 * dynamically by shelling out to the hidden `__complete-*` commands, which query a running hub
 * and never start one. Named by registry id; aliases are expanded from COMMANDS so a spelling
 * like `remove` can never drift out of the completion guards.
 */
const withAliases = (ids: readonly string[]): readonly string[] =>
  ids.flatMap((id) => {
    const command = COMMANDS.find((candidate) => candidate.id === id);
    return command === undefined ? [id] : [command.name, ...(command.aliases ?? [])];
  });

const WORKSPACE_PATH_COMMANDS = withAliases([
  "open",
  "review",
  "link",
  "comments",
  "archive",
  "prune",
  "rm",
]);
const OPEN_COMMENT_ID_COMMANDS = withAliases(["resolve", "reply"]);
const ARCHIVED_COMMENT_ID_COMMANDS = withAliases(["restore"]);

const commandCandidates = (): readonly Candidate[] =>
  COMMANDS.filter((command) => command.name !== "(no arguments)").flatMap((command) =>
    [command.name, ...(command.aliases ?? [])].map((name) => ({ name, summary: command.summary })),
  );

const optionsFor = (command: CommandHelp): readonly Candidate[] =>
  command.flags.flatMap(([usage, summary]) =>
    optionNamesForRows([[usage, summary]]).map((name) => ({ name, summary })),
  );

const globalOptions = (): readonly Candidate[] =>
  GLOBAL_FLAGS.flatMap(([usage, summary]) =>
    optionNamesForRows([[usage, summary]]).map((name) => ({ name, summary })),
  );

const completionActions = (): readonly Candidate[] => COMPLETION_COMMANDS;
const configKeys = (): readonly Candidate[] =>
  CONFIG_KEYS.map((name) => ({ name, summary: "configuration setting" }));

const words = (candidates: readonly Candidate[]): string =>
  candidates.map(({ name }) => name).join(" ");
const quoteZsh = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const quoteFish = (value: string): string => "'" + value.replaceAll("'", "\\'") + "'";
const zshEntry = ({ name, summary }: Candidate): string => quoteZsh(name + ":" + summary);

function bashCompletion(): string {
  // config and completion get their own nested arms below; emitting them here too would shadow
  // those, leaving every per-action flag list unreachable.
  const cases = COMMANDS.filter(
    (command) =>
      command.name !== "(no arguments)" && command.id !== "config" && command.id !== "completion",
  )
    .map(
      (command) =>
        "      " +
        [command.name, ...(command.aliases ?? [])].join("|") +
        ') choices="' +
        words([...globalOptions(), ...optionsFor(command)]) +
        '" ;;',
    )
    .join("\n");
  const configCases = CONFIG_COMMANDS.map(
    (command) =>
      "        " +
      command.name +
      ') choices="' +
      words([...globalOptions(), ...optionsFor(command)]) +
      '" ;;',
  ).join("\n");
  const completionCases = COMPLETION_COMMANDS.map(
    (command) =>
      "        " +
      command.name +
      ') choices="' +
      words([...globalOptions(), ...optionsFor(command)]) +
      '" ;;',
  ).join("\n");
  return [
    "# bash completion for livediff",
    "# Candidates arrive as untrusted data — a workspace path may contain $(), backticks, or",
    "# spaces. Read them as literal lines; `compgen -W` would re-expand them as shell words.",
    "_livediff_dynamic() {",
    '  local current="$1" line',
    "  shift",
    "  COMPREPLY=()",
    "  while IFS= read -r line; do",
    '    [[ -n "$line" && "$line" == "$current"* ]] && COMPREPLY+=( "$line" )',
    '  done < <("$@" 2>/dev/null | cut -f1)',
    "}",
    "_livediff() {",
    '  local current="${COMP_WORDS[COMP_CWORD]}" command="${COMP_WORDS[1]}" action="${COMP_WORDS[2]}"',
    '  local choices="' + words(commandCandidates()) + '"',
    '  if [[ "$command" == config && $COMP_CWORD -eq 2 ]]; then',
    '    choices="' + words(CONFIG_COMMANDS) + '"',
    '  elif [[ "$command" == completion && $COMP_CWORD -eq 2 ]]; then',
    '    choices="' + words(completionActions()) + '"',
    '  elif [[ "$command" == config && $COMP_CWORD -eq 3 && "$action" =~ ^(get|set|unset|explain)$ ]]; then',
    '    choices="' + words(configKeys()) + '"',
    '  elif [[ $COMP_CWORD -eq 2 && "$current" != -* && "$command" =~ ^(' +
      WORKSPACE_PATH_COMMANDS.join("|") +
      ")$ ]]; then",
    '    _livediff_dynamic "$current" livediff __complete-workspaces',
    "    compopt -o filenames 2>/dev/null",
    "    [[ ${#COMPREPLY[@]} -gt 0 ]] || compopt -o default 2>/dev/null",
    "    return",
    '  elif [[ $COMP_CWORD -eq 2 && "$current" != -* && "$command" =~ ^(' +
      OPEN_COMMENT_ID_COMMANDS.join("|") +
      ")$ ]]; then",
    '    _livediff_dynamic "$current" livediff __complete-comments open',
    "    return",
    '  elif [[ $COMP_CWORD -eq 2 && "$current" != -* && "$command" =~ ^(' +
      ARCHIVED_COMMENT_ID_COMMANDS.join("|") +
      ")$ ]]; then",
    '    _livediff_dynamic "$current" livediff __complete-comments archived',
    "    return",
    '  elif [[ "$current" == -* ]]; then',
    '    case "$command" in',
    cases,
    "      config)",
    '        case "$action" in',
    configCases,
    "        esac ;;",
    "      completion)",
    '        case "$action" in',
    completionCases,
    "        esac ;;",
    "    esac",
    "  fi",
    '  COMPREPLY=( $(compgen -W "$choices" -- "$current") )',
    '  [[ ${#COMPREPLY[@]} -gt 0 || "$current" == -* ]] || compopt -o default 2>/dev/null',
    "}",
    "complete -F _livediff livediff",
    "",
  ].join("\n");
}

function zshCompletion(): string {
  const options = [
    ...globalOptions(),
    ...COMMANDS.flatMap(optionsFor),
    ...CONFIG_COMMANDS.flatMap(optionsFor),
    ...COMPLETION_COMMANDS.flatMap(optionsFor),
  ];
  return [
    "#compdef livediff",
    "if ! (( $+functions[compdef] )); then",
    "  autoload -Uz compinit",
    "  compinit",
    "fi",
    "_livediff() {",
    "  local -a commands config_commands completion_actions config_keys options",
    "  commands=(",
    "    " + commandCandidates().map(zshEntry).join("\n    "),
    "  )",
    "  config_commands=(",
    "    " + CONFIG_COMMANDS.map(zshEntry).join("\n    "),
    "  )",
    "  completion_actions=(",
    "    " + completionActions().map(zshEntry).join("\n    "),
    "  )",
    "  config_keys=(",
    "    " + configKeys().map(zshEntry).join("\n    "),
    "  )",
    "  options=(",
    "    " + options.map(zshEntry).join("\n    "),
    "  )",
    "  if (( CURRENT == 2 )); then",
    "    _describe -t commands 'livediff command' commands; return",
    "  fi",
    '  if [[ "${words[2]}" == config && CURRENT -eq 3 ]]; then',
    "    _describe -t commands 'configuration command' config_commands; return",
    "  fi",
    '  if [[ "${words[2]}" == config && CURRENT -eq 4 && "${words[3]}" =~ "^(get|set|unset|explain)$" ]]; then',
    "    _describe -t settings 'configuration setting' config_keys; return",
    "  fi",
    '  if [[ "${words[2]}" == completion && CURRENT -eq 3 ]]; then',
    "    _describe -t commands 'completion action' completion_actions; return",
    "  fi",
    '  if [[ "${words[2]}" == (' +
      WORKSPACE_PATH_COMMANDS.join("|") +
      ") && CURRENT -eq 3 ]]; then",
    "    local -a workspaces",
    '    workspaces=(${(f)"$(livediff __complete-workspaces 2>/dev/null)"})',
    "    workspaces=(${workspaces//:/\\\\:})",
    "    workspaces=(${workspaces//$'\\t'/:})",
    "    _describe -t workspaces 'livediff workspace' workspaces",
    "    _files -/",
    "    return",
    "  fi",
    '  if [[ "${words[2]}" == (' +
      OPEN_COMMENT_ID_COMMANDS.join("|") +
      ") && CURRENT -eq 3 ]]; then",
    "    local -a open_comments",
    '    open_comments=(${(f)"$(livediff __complete-comments open 2>/dev/null)"})',
    "    open_comments=(${open_comments//:/\\\\:})",
    "    open_comments=(${open_comments//$'\\t'/:})",
    "    _describe -t comments 'open comment' open_comments",
    "    return",
    "  fi",
    '  if [[ "${words[2]}" == (' +
      ARCHIVED_COMMENT_ID_COMMANDS.join("|") +
      ") && CURRENT -eq 3 ]]; then",
    "    local -a archived_comments",
    '    archived_comments=(${(f)"$(livediff __complete-comments archived 2>/dev/null)"})',
    "    archived_comments=(${archived_comments//:/\\\\:})",
    "    archived_comments=(${archived_comments//$'\\t'/:})",
    "    _describe -t comments 'archived comment' archived_comments",
    "    return",
    "  fi",
    "  [[ \"${words[CURRENT]}\" == -* ]] && _describe -t options 'livediff option' options",
    "}",
    "compdef _livediff livediff",
    "",
  ].join("\n");
}

function fishCompletion(): string {
  const commandLines = commandCandidates()
    .map(
      (candidate) =>
        "complete -c livediff -n '__fish_use_subcommand' -a " +
        quoteFish(candidate.name) +
        " -d " +
        quoteFish(candidate.summary),
    )
    .join("\n");
  const configLines = CONFIG_COMMANDS.map(
    (candidate) =>
      "complete -c livediff -n '__livediff_config_action' -a " +
      quoteFish(candidate.name) +
      " -d " +
      quoteFish(candidate.summary),
  ).join("\n");
  const completionLines = completionActions()
    .map(
      (candidate) =>
        "complete -c livediff -n '__fish_seen_subcommand_from completion' -a " +
        quoteFish(candidate.name) +
        " -d " +
        quoteFish(candidate.summary),
    )
    .join("\n");
  const configKeyLines = configKeys()
    .map(
      (candidate) =>
        "complete -c livediff -n '__livediff_config_key get set unset explain' -a " +
        quoteFish(candidate.name) +
        " -d " +
        quoteFish(candidate.summary),
    )
    .join("\n");
  const optionLines = [
    ...globalOptions(),
    ...COMMANDS.flatMap(optionsFor),
    ...CONFIG_COMMANDS.flatMap(optionsFor),
    ...COMPLETION_COMMANDS.flatMap(optionsFor),
  ]
    .filter((candidate) => candidate.name.startsWith("--"))
    .map(
      (candidate) =>
        "complete -c livediff -l " +
        candidate.name.slice(2) +
        " -d " +
        quoteFish(candidate.summary),
    )
    .join("\n");
  // `__fish_seen_subcommand_from` matches at every later token, so it would offer comment ids in
  // `reply <id> <text>` and workspace paths after `--status`. Guard on the first positional only.
  const firstArgHelper = [
    "function __livediff_first_arg",
    "    set -l tokens (commandline -poc)",
    "    test (count $tokens) -eq 2; or return 1",
    "    contains -- $tokens[2] $argv",
    "end",
  ].join("\n");
  // Config nests an action and (for get/set/unset/explain) a key underneath it, so
  // `__fish_seen_subcommand_from` — which matches at every later token — can't tell the action
  // position from the key position. Pin each guard to its exact token count instead.
  const configActionHelper = [
    "function __livediff_config_action",
    "    set -l tokens (commandline -poc)",
    "    test (count $tokens) -eq 2; or return 1",
    '    test "$tokens[2]" = config',
    "end",
  ].join("\n");
  const configKeyHelper = [
    "function __livediff_config_key",
    "    set -l tokens (commandline -poc)",
    "    test (count $tokens) -eq 3; or return 1",
    '    test "$tokens[2]" = config; or return 1',
    "    contains -- $tokens[3] $argv",
    "end",
  ].join("\n");
  const dynamic = (commands: readonly string[], producer: string, files: boolean): string =>
    "complete -c livediff -n '__livediff_first_arg " +
    commands.join(" ") +
    (files ? "' -F -a '(" : "' -f -a '(") +
    producer +
    " 2>/dev/null)'";
  return [
    "# fish completion for livediff",
    "complete -c livediff -f",
    firstArgHelper,
    configActionHelper,
    configKeyHelper,
    commandLines,
    configLines,
    completionLines,
    configKeyLines,
    dynamic(WORKSPACE_PATH_COMMANDS, "livediff __complete-workspaces", true),
    dynamic(OPEN_COMMENT_ID_COMMANDS, "livediff __complete-comments open", false),
    dynamic(ARCHIVED_COMMENT_ID_COMMANDS, "livediff __complete-comments archived", false),
    optionLines,
    "",
  ].join("\n");
}

export function renderCompletion(shell: string): string {
  switch (shell) {
    case "bash":
      return bashCompletion();
    case "zsh":
      return zshCompletion();
    case "fish":
      return fishCompletion();
    default:
      throw new Error("unknown shell '" + shell + "'; choose bash, zsh, or fish");
  }
}
