# Configuration

LiveDiff works without configuration. Use `livediff config init` only when you want to override a default.

The per-user configuration file is `$XDG_CONFIG_HOME/livediff/config.jsonc`, or
`~/.config/livediff/config.jsonc` when `XDG_CONFIG_HOME` is unset. It is intentionally global:
one local hub serves several worktrees, so project-local retention and hub settings would be ambiguous.

## Precedence

For each setting, the most specific source wins:

1. Built-in default
2. `config.jsonc`
3. `LIVEDIFF_*` environment variable
4. Explicit CLI flag, where a command provides one

`livediff config list` shows the effective values. Hub settings are read when the hub starts;
restart it with `livediff stop` and run any LiveDiff command to apply a changed port or poll interval.

## Example

```jsonc
{
  "$schema": "./config.schema.json",
  "browser": {
    "opener": ["cmux", "open-window"],
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

## Commands

```text
livediff config path
livediff config init
livediff config validate
livediff config list
livediff config get <key>
livediff config set <key> <value>
livediff config schema
livediff config schema --update
```

`init` never overwrites an existing file. `set` validates the updated JSONC and writes atomically.
`browser.opener` accepts a command followed by ordinary arguments:

```text
livediff config set browser.opener cmux browser open
```

It is stored as structured argv. For an argument that itself needs whitespace or other exact
preservation, pass the JSON array form instead.

`livediff config init` installs `config.schema.json` beside the config. Its relative `$schema`
reference provides completion, validation, descriptions, and defaults in editors that support JSON
Schema. `livediff config schema --update` replaces only that schema file with the version bundled
with the current LiveDiff CLI; it never changes `config.jsonc` or its values.

## Supported settings

| Setting                              |   Default | Meaning                                               |
| ------------------------------------ | --------: | ----------------------------------------------------- |
| `browser.opener`                     | OS opener | argv used to open a LiveDiff URL                      |
| `hub.port`                           |    `4180` | preferred loopback port                               |
| `hub.pollIntervalMs`                 |    `1000` | worktree polling interval while a browser is attached |
| `retention.orphanArchiveAfterDays`   |       `5` | archive age for comments whose file left the diff     |
| `retention.resolvedArchiveAfterDays` |      `30` | archive age for resolved comments                     |
| `retention.purgeAfterDays`           |     `200` | deletion age for archived comments                    |
| `retention.archiveWarningBytes`      | `5242880` | archive-size threshold for `livediff doctor`          |
| `ui.defaultRenderer`                 |    `fast` | default renderer (`fast` or `classic`)                |

LiveDiff supports JSONC only. YAML/TOML and auto-discovered project dotfiles are deliberately not
supported in v1 so there is one unambiguous, schema-validatable source of per-user settings.
