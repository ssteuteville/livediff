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

Before changing a setting, state the exact key and value and ask for confirmation. Use structured
JSON for array values, for example:

```bash
livediff config set browser.opener '["cmux", "open-window"]'
```

After a change, run:

```bash
livediff config validate
```

Tell the user to restart the hub (`livediff stop`, then any LiveDiff command) after changing a
hub setting such as `hub.port` or `hub.pollIntervalMs`.
