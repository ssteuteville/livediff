import { COMMANDS, CONFIG_COMMANDS } from "./cli-help.js";

export type CompletionShell = "bash" | "zsh" | "fish";

type CompletionCommand = {
  name: string;
  summary: string;
};

const commands = (): readonly CompletionCommand[] =>
  COMMANDS.filter((command) => command.name !== "(no arguments)").flatMap(
    ({ name, summary, aliases = [] }) =>
      [name, ...aliases].map((commandName) => ({ name: commandName, summary })),
  );

const quoteZsh = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const quoteFish = (value: string): string => `'${value.replaceAll("'", "\\'")}'`;

function bashCompletion(): string {
  const commandNames = commands()
    .map((command) => command.name)
    .join(" ");
  const configNames = CONFIG_COMMANDS.map((command) => command.name).join(" ");
  return `# bash completion for livediff
_livediff() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local command="\${COMP_WORDS[1]}"
  local choices="${commandNames}"

  if [[ "$command" == "config" && $COMP_CWORD -eq 2 ]]; then
    choices="${configNames}"
  fi

  COMPREPLY=( $(compgen -W "$choices" -- "$current") )
}
complete -F _livediff livediff
`;
}

function zshCompletion(): string {
  const commandEntries = commands()
    .map((command) => `  ${quoteZsh(`${command.name}:${command.summary}`)}`)
    .join("\n");
  const configEntries = CONFIG_COMMANDS.map(
    (command) => `  ${quoteZsh(`${command.name}:${command.summary}`)}`,
  ).join("\n");
  return `#compdef livediff

_livediff() {
  local -a commands config_commands
  commands=(
${commandEntries}
  )
  config_commands=(
${configEntries}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'livediff command' commands
    return
  fi

  if [[ "\${words[2]}" == "config" && CURRENT -eq 3 ]]; then
    _describe -t commands 'configuration command' config_commands
  fi
}

compdef _livediff livediff
`;
}

function fishCompletion(): string {
  const commandLines = commands()
    .map(
      (command) =>
        `complete -c livediff -n '__fish_use_subcommand' -a ${quoteFish(command.name)} -d ${quoteFish(command.summary)}`,
    )
    .join("\n");
  const configLines = CONFIG_COMMANDS.map(
    (command) =>
      `complete -c livediff -n '__fish_seen_subcommand_from config' -a ${quoteFish(command.name)} -d ${quoteFish(command.summary)}`,
  ).join("\n");
  return `# fish completion for livediff
complete -c livediff -f
${commandLines}
${configLines}
`;
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
      throw new Error(`unknown shell '${shell}'; choose bash, zsh, or fish`);
  }
}
