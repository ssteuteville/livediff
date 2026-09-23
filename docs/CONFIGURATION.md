# Configuration

LiveDiff works without configuration. Use `livediff config edit` when you want to explore or override a default.

The per-user configuration file is `$XDG_CONFIG_HOME/livediff/config.jsonc`, or
`~/.config/livediff/config.jsonc` when `XDG_CONFIG_HOME` is unset. It is intentionally global:
one local hub serves several worktrees, so project-local retention and hub settings would be ambiguous.

## Precedence

For each setting, the most specific source wins:

1. Built-in default
2. `config.jsonc`
3. `LIVEDIFF_*` environment variable
4. Explicit CLI flag, where a command provides one

`livediff config list` shows the effective values. `livediff config explain <key>` also shows which
layer won. Hub settings are read when the hub starts; run `livediff restart` after changing a cached
setting.

## Example

```jsonc
{
  "$schema": "./config.schema.json",
  "browser": {
    "opener": ["cmux", "open-window"],
  },
  "tools": {
    "editor": ["vim"],
  },
  "hub": {
    "port": 4180,
    "pollIntervalMs": 1000,
  },
  "retention": {
    "orphanArchiveAfterDays": 5,
    "resolvedArchiveAfterDays": 30,
    "purgeAfterDays": 200,
    "archiveWarningBytes": 5242880,
  },
  "ui": {
    "defaultRenderer": "fast",
  },
}
```

`browser.opener` is an executable followed by literal arguments, not a shell command. LiveDiff
never runs it through a shell. The existing `LIVEDIFF_BROWSER="cmux open-window"` environment
variable remains available for scripts and takes precedence.

`tools.editor` is also argv, used by `livediff config edit`. Its resolution order is
`--editor`, `LIVEDIFF_EDITOR`, `tools.editor`, `VISUAL`, `EDITOR`, then `vim`.

## Commands

```text
livediff config edit [--editor <command>]
livediff config path
livediff config init
livediff config validate
livediff config list
livediff config get <key>
livediff config set <key> <value>
livediff config unset <key>
livediff config explain <key>
livediff config schema
livediff config schema --update
```

`edit` creates a schema-linked draft beside the config, opens it in your editor, validates it when
the editor exits, and only then atomically replaces the live file. Invalid drafts are preserved and
never break a working configuration. `init` never overwrites an existing file. `set` validates the
updated JSONC and writes atomically. `unset` removes an explicit override so the next lower-precedence
source becomes effective.
`browser.opener` accepts a command followed by ordinary arguments:

```text
livediff config set browser.opener cmux browser open
```

It is stored as structured argv. Normal shell tokens are preserved; a single quoted command string
is split for convenience. For an argument that itself needs whitespace or other exact preservation,
pass the JSON array form instead.

Sizes and durations are accepted where they make sense, so `10MiB` may be used for
`retention.archiveWarningBytes`, `1s` for `hub.pollIntervalMs`, and `30d` for retention ages.

`livediff config init` installs `config.schema.json` beside the config. Its relative `$schema`
reference provides completion, validation, descriptions, and defaults in editors that support JSON
Schema. `livediff config schema --update` replaces only that schema file with the version bundled
with the current LiveDiff CLI; it never changes `config.jsonc` or its values.

## Supported settings

| Setting                              |   Default | Meaning                                               |
| ------------------------------------ | --------: | ----------------------------------------------------- |
| `browser.opener`                     | OS opener | argv used to open a LiveDiff URL                      |
| `tools.editor`                       |     `vim` | argv used to edit a configuration draft               |
| `hub.port`                           |    `4180` | preferred loopback port                               |
| `hub.pollIntervalMs`                 |    `1000` | worktree polling interval while a browser is attached |
| `retention.orphanArchiveAfterDays`   |       `5` | archive age for comments whose file left the diff     |
| `retention.resolvedArchiveAfterDays` |      `30` | archive age for resolved comments                     |
| `retention.purgeAfterDays`           |     `200` | deletion age for archived comments                    |
| `retention.archiveWarningBytes`      | `5242880` | archive-size threshold for `livediff doctor`          |
| `ui.defaultRenderer`                 |    `fast` | default renderer (`fast` or `classic`)                |

LiveDiff supports JSONC only. YAML/TOML and auto-discovered project dotfiles are deliberately not
supported in v1 so there is one unambiguous, schema-validatable source of per-user settings.

## Environment variables

| Env                 | Default          | Meaning                                                          |
| ------------------- | ---------------- | ---------------------------------------------------------------- |
| `LIVEDIFF_PORT`     | `4180`           | preferred hub port; the hub takes the next free one if it's busy |
| `LIVEDIFF_POLL_MS`  | `1000`           | live-update poll interval                                        |
| `LIVEDIFF_BROWSER`  | OS opener        | executable and arguments used to open LiveDiff URLs              |
| `LIVEDIFF_RENDERER` | `fast`           | default diff renderer (`fast` or `classic`)                      |
| `LIVEDIFF_OPEN`     | –                | `1` opens the browser when the hub starts                        |
| `NO_COLOR`          | –                | disable colored CLI output                                       |
| `XDG_CONFIG_HOME`   | `~/.config`      | where the registry and comments live                             |
| `XDG_STATE_HOME`    | `~/.local/state` | where hub runtime state lives                                    |
