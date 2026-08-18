# LiveDiff CLI Reference

> Generated from the command registry by `scripts/generate-cli-docs.ts`. Do not edit by hand —
> run `pnpm docs:cli` to regenerate. `test/cli-docs.test.ts` fails if this file drifts from
> the registry.

## Global options

Available on every command.

| Flags             | Takes value | Description                |
| ----------------- | ----------- | -------------------------- |
| `--json`          | no          | machine-readable output    |
| `-h`, `--help`    | no          | show help for a command    |
| `-v`, `--version` | no          | print the livediff version |

## Commands

- [open](#open)
- [hub](#hub)
- [review](#review)
- [link](#link)
- [list](#list)
- [rm](#rm)
- [comments](#comments)
- [lens](#lens)
- [restore](#restore)
- [archive](#archive)
- [prune](#prune)
- [resolve](#resolve)
- [reply](#reply)
- [config](#config)
- [restart](#restart)
- [status](#status)
- [stop](#stop)
- [doctor](#doctor)
- [completion](#completion)
- [help](#help)
- [config edit](#config-edit)
- [config path](#config-path)
- [config init](#config-init)
- [config validate](#config-validate)
- [config list](#config-list)
- [config get](#config-get)
- [config set](#config-set)
- [config unset](#config-unset)
- [config explain](#config-explain)
- [config schema](#config-schema)
- [lens set](#lens-set)
- [lens add](#lens-add)
- [lens list](#lens-list)
- [lens rm](#lens-rm)
- [lens clear](#lens-clear)
- [completion bash](#completion-bash)
- [completion zsh](#completion-zsh)
- [completion fish](#completion-fish)
- [completion install](#completion-install)
- [completion path](#completion-path)
- [completion status](#completion-status)
- [completion uninstall](#completion-uninstall)

## `open`

register a worktree and open its focused view

**Usage:**

```
livediff open [path] [--base <ref>] [--no-open] [--wait] [--timeout <sec>] [--lens <name>]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `path` | no       | no       |

**Options:**

| Flags       | Takes value | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `--base`    | yes         | review against <ref> instead of the last commit, and remember it |
| `--no-open` | no          | register only; print the URL instead of launching a browser      |
| `--wait`    | no          | block until "Done reviewing" is clicked in the browser           |
| `--timeout` | yes         | give up waiting after <sec> seconds (default: never)             |
| `--lens`    | yes         | open with one lens already applied                               |

**Examples:**

- `livediff open` — register the current worktree and open it
- `livediff .` — the shorthand for opening the current worktree
- `livediff ~/work/feat-a` — register a worktree by path
- `livediff apps/expo` — open the worktree, scoped to one directory
- `livediff . --base main` — review everything this branch adds on top of main
- `livediff . --no-open --json` — register quietly and print JSON
- `livediff . --wait` — open, then wait for the review to be marked done

## `hub`

open the hub UI showing every registered workspace

**Usage:**

```
livediff hub [--no-open]
```

**Options:**

| Flags       | Takes value | Description                                                 |
| ----------- | ----------- | ----------------------------------------------------------- |
| `--no-open` | no          | start the hub and print its URL without launching a browser |

**Examples:**

- `livediff hub` — open the hub UI
- `livediff` — the shorthand for opening the hub UI
- `livediff --no-open` — start the hub and print its URL

## `review`

open a worktree and wait for the reviewer to finish

**Usage:**

```
livediff review [path] [--base <ref>] [--no-open] [--timeout <sec>] [--lens <name>]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `path` | no       | no       |

**Options:**

| Flags       | Takes value | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `--base`    | yes         | review against <ref> instead of the last commit, and remember it |
| `--no-open` | no          | register only; print the URL instead of launching a browser      |
| `--timeout` | yes         | give up waiting after <sec> seconds (default: never)             |
| `--lens`    | yes         | open with one lens already applied                               |

**Examples:**

- `livediff review` — review the current worktree and wait
- `livediff review --base main` — review the whole branch, not just uncommitted work
- `livediff review . --lens retry` — hand off with one lens applied on arrival

## `link`

print a focused worktree URL without opening a browser

**Usage:**

```
livediff link [path]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `path` | no       | no       |

**Examples:**

- `livediff link .` — print the current worktree's focused URL

## `list`

list registered workspaces

**Usage:**

```
livediff list
```

**Aliases:**

`ls`

**Examples:**

- `livediff list --json` — list workspaces as JSON

## `rm`

unregister a workspace

**Usage:**

```
livediff rm [path|id]
```

**Aliases:**

`remove`

**Arguments:**

| Name     | Required | Variadic |
| -------- | -------- | -------- |
| path\|id | no       | no       |

**Examples:**

- `livediff rm` — unregister the current worktree
- `livediff rm a1b2c3d4` — unregister by id

## `comments`

print review comments for a worktree

**Usage:**

```
livediff comments [path] [--status open|resolved|all] [--branch <name>] [--base <ref>] [--stale|--archived]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `path` | no       | no       |

**Options:**

| Flags        | Takes value | Description                                             |
| ------------ | ----------- | ------------------------------------------------------- |
| `--status`   | yes         | open (default), resolved, or all                        |
| `--branch`   | yes         | a branch name, or all (default: the current branch)     |
| `--base`     | yes         | judge staleness against <ref> for this command only     |
| `--stale`    | no          | only comments whose file has left the diff              |
| `--archived` | no          | only archived comments, with days until they are purged |

**Examples:**

- `livediff comments` — open comments on this worktree's current branch
- `livediff comments --base main` — judge staleness against main, just this once
- `livediff comments --stale` — comments whose file is no longer in the diff
- `livediff comments --archived` — what is archived and when it will be deleted

## `lens`

define the ways to read this change

**Usage:**

```
livediff lens <set|add|list|rm|clear> [...]
```

**Arguments:**

| Name         | Required | Variadic |
| ------------ | -------- | -------- |
| `subcommand` | no       | no       |

**Examples:**

- `livediff lens list` — show this workspace's lenses and what each one matches
- `livediff lens add tests --path 'test/**'` — add one lens by hand

## `restore`

return an archived comment to the live view

**Usage:**

```
livediff restore <id>
```

**Arguments:**

| Name | Required | Variadic |
| ---- | -------- | -------- |
| `id` | yes      | no       |

**Examples:**

- `livediff restore a1b2c3d4` — un-archive a comment

## `archive`

archive comments that are no longer live

**Usage:**

```
livediff archive [path] [--stale] [--resolved]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `path` | no       | no       |

**Options:**

| Flags        | Takes value | Description                                      |
| ------------ | ----------- | ------------------------------------------------ |
| `--stale`    | no          | archive every orphaned comment, whatever its age |
| `--resolved` | no          | archive every resolved comment, whatever its age |

**Examples:**

- `livediff archive` — archive what qualifies, everywhere
- `livediff archive . --stale` — archive this worktree's orphaned comments now

## `prune`

delete archived comments

**Usage:**

```
livediff prune [path] [--keep-days <n> | --all] [--dry-run] [--yes]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `path` | no       | no       |

**Options:**

| Flags         | Takes value | Description                                      |
| ------------- | ----------- | ------------------------------------------------ |
| `--keep-days` | yes         | delete archived comments older than n days       |
| `--all`       | no          | delete every archived comment                    |
| `--dry-run`   | no          | report what would be deleted without deleting it |
| `--yes`       | no          | skip the confirmation prompt                     |

**Examples:**

- `livediff prune --dry-run` — see what would be deleted
- `livediff prune --keep-days 30 --yes` — keep only the last 30 days of archive

## `resolve`

reply to a comment and mark it resolved

**Usage:**

```
livediff resolve <id> [text...]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `id`   | yes      | no       |
| `text` | no       | yes      |

**Examples:**

- `livediff resolve a1b2c3d4 fixed in the latest commit` — reply and resolve

## `reply`

reply to a comment without resolving it

**Usage:**

```
livediff reply <id> <text...>
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `id`   | yes      | no       |
| `text` | yes      | yes      |

**Examples:**

- `livediff reply a1b2c3d4 what did you mean here?` — reply only

## `config`

view and manage per-user LiveDiff settings

**Usage:**

```
livediff config [edit|path|init|validate|list|get|set|unset|explain|schema]
```

**Arguments:**

| Name     | Required | Variadic |
| -------- | -------- | -------- |
| `action` | no       | no       |
| `key`    | no       | no       |
| `value`  | no       | yes      |

**Examples:**

- `livediff config edit` — open a validated, schema-backed config draft in an editor
- `livediff config init` — create a commented config file without overwriting
- `livediff config set browser.opener cmux browser open` — use cmux to open URLs
- `livediff config set retention.archiveWarningBytes 10485760` — warn at 10 MiB
- `livediff config list` — show effective settings
- `livediff config schema --update` — refresh editor completion without changing settings

## `restart`

restart the hub to apply cached settings

**Usage:**

```
livediff restart
```

**Examples:**

- `livediff restart` — apply cached configuration changes

## `status`

show whether the hub is running and where settings live

**Usage:**

```
livediff status
```

**Examples:**

- `livediff status` — check LiveDiff without changing anything

## `stop`

shut the hub down

**Usage:**

```
livediff stop
```

**Examples:**

- `livediff stop` — shut the hub down

## `doctor`

diagnose install and state problems

**Usage:**

```
livediff doctor
```

**Examples:**

- `livediff doctor` — check the install
- `livediff doctor --json` — machine-readable findings

## `completion`

generate, install, or inspect shell completion

**Usage:**

```
livediff completion <bash|zsh|fish|install|path|status|uninstall> [shell]
```

**Arguments:**

| Name     | Required | Variadic |
| -------- | -------- | -------- |
| `action` | no       | no       |
| `shell`  | no       | no       |

**Examples:**

- `source <(livediff completion zsh)` — enable completions in the current zsh session
- `livediff completion fish > ~/.config/fish/completions/livediff.fish` — install fish completions

## `help`

show help for livediff or a specific command

**Usage:**

```
livediff help [command]
```

**Arguments:**

| Name         | Required | Variadic |
| ------------ | -------- | -------- |
| `command`    | no       | no       |
| `subcommand` | no       | no       |

**Examples:**

- `livediff help resolve` — show help for the resolve command

## `config edit`

edit configuration safely in your preferred editor

**Usage:**

```
livediff config edit [--editor <command>]
```

**Options:**

| Flags      | Takes value | Description                               |
| ---------- | ----------- | ----------------------------------------- |
| `--editor` | yes         | override the editor command for this edit |

**Examples:**

- `livediff config edit` — edit with the configured or detected editor
- `livediff config edit --editor 'code --wait'` — edit with a one-off editor command

## `config path`

print the config file path

**Usage:**

```
livediff config path
```

## `config init`

create a minimal config without overwriting

**Usage:**

```
livediff config init
```

## `config validate`

validate effective configuration

**Usage:**

```
livediff config validate
```

## `config list`

show effective configuration values

**Usage:**

```
livediff config list
```

## `config get`

print one effective setting

**Usage:**

```
livediff config get <key>
```

**Arguments:**

| Name  | Required | Variadic |
| ----- | -------- | -------- |
| `key` | yes      | no       |

## `config set`

set one user configuration override

**Usage:**

```
livediff config set <key> <value...>
```

**Arguments:**

| Name    | Required | Variadic |
| ------- | -------- | -------- |
| `key`   | yes      | no       |
| `value` | yes      | yes      |

## `config unset`

remove one user configuration override

**Usage:**

```
livediff config unset <key>
```

**Arguments:**

| Name  | Required | Variadic |
| ----- | -------- | -------- |
| `key` | yes      | no       |

## `config explain`

explain one setting's effective value and source

**Usage:**

```
livediff config explain <key>
```

**Arguments:**

| Name  | Required | Variadic |
| ----- | -------- | -------- |
| `key` | yes      | no       |

## `config schema`

print or refresh the editor schema

**Usage:**

```
livediff config schema [--update]
```

**Options:**

| Flags      | Takes value | Description                          |
| ---------- | ----------- | ------------------------------------ |
| `--update` | no          | replace only the bundled schema file |

## `lens set`

replace the whole lens set from JSON on stdin

**Usage:**

```
livediff lens set
```

**Examples:**

- `livediff lens set < lenses.json` — replace the set from a file

## `lens add`

add or replace one lens by hand

**Usage:**

```
livediff lens add <name> --path <glob> [--why <text>] [--highlight <path:start-end>]
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `name` | yes      | no       |

**Options:**

| Flags         | Takes value | Description                                         |
| ------------- | ----------- | --------------------------------------------------- |
| `--path`      | yes         | a file glob the lens matches (repeatable, required) |
| `--why`       | yes         | a short note on what this lens is for               |
| `--highlight` | yes         | a new-side line range to mark (repeatable)          |

**Examples:**

- `livediff lens add tests --path 'test/**' --why coverage` — add a lens over the tests
- `livediff lens add retry --path src/retry.ts --highlight src/retry.ts:88-104` — add a lens with one highlighted range

## `lens list`

show this workspace's lenses

**Usage:**

```
livediff lens list
```

**Examples:**

- `livediff lens list --json` — list lenses as JSON

## `lens rm`

remove one lens

**Usage:**

```
livediff lens rm <name>
```

**Arguments:**

| Name   | Required | Variadic |
| ------ | -------- | -------- |
| `name` | yes      | no       |

**Examples:**

- `livediff lens rm tests` — remove the tests lens

## `lens clear`

remove every lens

**Usage:**

```
livediff lens clear
```

**Examples:**

- `livediff lens clear` — empty this workspace's lens set

## `completion bash`

print bash completion

**Usage:**

```
livediff completion bash
```

## `completion zsh`

print zsh completion

**Usage:**

```
livediff completion zsh
```

## `completion fish`

print fish completion

**Usage:**

```
livediff completion fish
```

## `completion install`

write a generated completion script

**Usage:**

```
livediff completion install [bash|zsh|fish] [--activate]
```

**Arguments:**

| Name    | Required | Variadic |
| ------- | -------- | -------- |
| `shell` | no       | no       |

**Options:**

| Flags        | Takes value | Description                                                 |
| ------------ | ----------- | ----------------------------------------------------------- |
| `--activate` | no          | source the installed completion from the shell startup file |

## `completion path`

print the generated completion file path

**Usage:**

```
livediff completion path [bash|zsh|fish]
```

**Arguments:**

| Name    | Required | Variadic |
| ------- | -------- | -------- |
| `shell` | no       | no       |

## `completion status`

show whether completion is installed and activated

**Usage:**

```
livediff completion status [bash|zsh|fish]
```

**Arguments:**

| Name    | Required | Variadic |
| ------- | -------- | -------- |
| `shell` | no       | no       |

## `completion uninstall`

remove an installed completion script

**Usage:**

```
livediff completion uninstall [bash|zsh|fish] [--deactivate]
```

**Arguments:**

| Name    | Required | Variadic |
| ------- | -------- | -------- |
| `shell` | no       | no       |

**Options:**

| Flags          | Takes value | Description                          |
| -------------- | ----------- | ------------------------------------ |
| `--deactivate` | no          | also remove LiveDiff's startup block |
