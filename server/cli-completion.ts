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
  const cases = COMMANDS.filter((command) => command.name !== "(no arguments)")
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
    "_livediff() {",
    '  local current="${COMP_WORDS[COMP_CWORD]}" command="${COMP_WORDS[1]}" action="${COMP_WORDS[2]}"',
    '  local choices="' + words(commandCandidates()) + '"',
    '  if [[ "$command" == config && $COMP_CWORD -eq 2 ]]; then',
    '    choices="' + words(CONFIG_COMMANDS) + '"',
    '  elif [[ "$command" == completion && $COMP_CWORD -eq 2 ]]; then',
    '    choices="' + words(completionActions()) + '"',
    '  elif [[ "$command" == config && $COMP_CWORD -eq 3 && "$action" =~ ^(get|set|unset|explain)$ ]]; then',
    '    choices="' + words(configKeys()) + '"',
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
      "complete -c livediff -n '__fish_seen_subcommand_from config' -a " +
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
        "complete -c livediff -n '__fish_seen_subcommand_from get set unset explain' -a " +
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
  return [
    "# fish completion for livediff",
    "complete -c livediff -f",
    commandLines,
    configLines,
    completionLines,
    configKeyLines,
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
