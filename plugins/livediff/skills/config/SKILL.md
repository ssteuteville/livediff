---
name: config
description: Inspect, validate, or intentionally change LiveDiff's per-user settings.
disable-model-invocation: true
allowed-tools: Bash(livediff config *)
---

Start by showing the effective settings:

```bash
livediff config list
```

Explain that values come from defaults, then `config.jsonc`, then `LIVEDIFF_*` environment
variables, and finally explicit CLI flags. For a missing file, offer `livediff config init`.

For an interactive change, prefer opening the complete configuration in the user's editor:

```bash
livediff config edit
```

It writes through a temporary sibling file, validates the completed edit, and only then replaces
the active config. The editor is chosen by `--editor`, `LIVEDIFF_EDITOR`, `tools.editor`,
`VISUAL`, `EDITOR`, then `vim`.

Before a targeted change, state the exact key and value and ask for confirmation. Use structured
JSON for array values, for example:

```bash
livediff config set browser.opener '["cmux", "open-window"]'
```

For a simple command, space-separated arguments are also accepted:

```bash
livediff config set browser.opener cmux open-window
```

Use `livediff config unset <key>` to restore a default. Use
`livediff config explain <key>` when a setting seems ineffective: it reports the effective value
and whether it comes from a default, config file, environment variable, or CLI flag.

After a change, run:

```bash
livediff config validate
```

Tell the user to run `livediff restart` after changing a hub setting such as `hub.port` or
`hub.pollIntervalMs`.
