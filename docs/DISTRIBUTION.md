# Distribution reference

What LiveDiff's installer and setup adapters can rely on, and what they cannot yet. Each fact
here was observed in an isolated profile unless it says otherwise. Update this file when a
host version changes or a gate is resolved.

Last verified: 2026-09-23, macOS (Darwin 25.6, arm64), Node 24.19.0, npm 11.17.0.

## Tested host versions

| Host         | Version            | Isolation used                                  |
| ------------ | ------------------ | ----------------------------------------------- |
| Claude Code  | 2.1.281            | `CLAUDE_CONFIG_DIR` and `HOME` set to temp dirs |
| Codex CLI    | 0.147.0            | `CODEX_HOME` set to a temp dir                  |
| skills (npm) | 1.7.0 (`latest`)   | `HOME` and XDG dirs set to temp dirs            |
| npm          | 11.17.0            | `npm_config_prefix` and `npm_config_cache` temp |
| cursor-agent | 2025.09.17-25b418f | Only read; not executed against a profile       |

Ref behaviour was proven against a temporary bare repo served over smart HTTP on
`127.0.0.1`, with a `stable` branch whose plugin version differed from `main`. GitHub
shorthand was proven against `ssteuteville/livediff` using the existing remote branch
`codex/npm-distribution-plan`.

## Installation channels

| Channel                        | Status                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------- |
| npm package `livediff`         | Name unclaimed: `npm view livediff` returns `E404`, exit 1.                   |
| GitHub `ssteuteville/livediff` | Public. Anonymous access verified for all three harness channels (see below). |

Anonymous check (2026-09-23), run with `env -i`, an empty `HOME`, `GIT_CONFIG_NOSYSTEM=1`, and
SSH disabled:

- `claude plugin marketplace add ssteuteville/livediff#main` worked, and so did `claude plugin install livediff@livediff`.
- `codex plugin marketplace add ssteuteville/livediff --ref main` worked, followed by `codex plugin add` (installed 0.11.2) and `codex plugin marketplace upgrade`.
- `npx skills@1.7.0 add ssteuteville/livediff#main --skill review -g -a cursor github-copilot gemini-cli opencode -y` worked, followed by `skills update review -g -y`.

## npm

| Purpose                  | Command                               | Observed                                                                                                                              |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Global prefix            | `npm prefix -g`                       | Honors `npm_config_prefix`.                                                                                                           |
| Global package root      | `npm root -g`                         | `<prefix>/lib/node_modules`.                                                                                                          |
| Global bin directory     | none                                  | `npm bin -g` no longer exists (exit 1). Use `<prefix>/bin` on POSIX.                                                                  |
| Installed global version | `npm ls -g --depth=0 --json livediff` | Present: `.dependencies.livediff.version`, exit 0. Absent: no `dependencies` key, exit 1. Missing `<prefix>/lib`: `ENOENT`, exit 254. |

### Detecting a temporary `npx` run

Both `npx <pkg>` and `npm exec --package=<pkg> -- <bin>` set:

- `npm_command=exec`
- `npm_lifecycle_event=npx`
- `npm_config_user_agent=npm/<ver> node/<ver> <os> <arch> workspaces/false`
- `npm_config_cache=<cache>`

`process.argv[1]` is `<cache>/_npx/<hash>/node_modules/.bin/<bin>`, and its realpath is
`<cache>/_npx/<hash>/node_modules/<pkg>/<bin file>`. A globally installed bin run directly
has none of these variables. Its realpath is under `npm root -g`.

The reliable test is the realpath of `argv[1]`. Treat the run as temporary when the realpath is
under `<npm_config_cache>/_npx/`, or more generally when it is not under `npm root -g`. The
environment variables only show that npm launched the process. A package script run through
npm sets them too.

`npx /abs/path/pkg.tgz` fails with `Permission denied` (exit 126) because npx tries to run the
path itself. Local tarball tests must use `npx file:/abs/path/pkg.tgz` or
`npm exec --package=/abs/path/pkg.tgz -- <bin>`.

## Claude Code (2.1.281)

### Source and ref syntax

| Form                                           | Result                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `owner/repo#<ref>`                             | Accepted. Recorded as `{"source":"github","repo":…,"ref":…}`.   |
| `owner/repo@<ref>`                             | Accepted. Recorded the same way as `#`.                         |
| `https://host/path.git#<ref>` (also `http://`) | Accepted. Recorded as `{"source":"git","url":…,"ref":…}`.       |
| `file://…`, `git://…`, `ssh://…`               | Rejected: `Invalid marketplace source format`, exit 1.          |
| `/abs/path#ref`                                | Rejected: `Path does not exist`. Local paths cannot take a ref. |

The checked-out commit matched the requested ref in every accepted case.

`owner/repo` clones `git@github.com:owner/repo.git` over SSH first and falls back to HTTPS.
Anonymous HTTPS works for the public repo. When the repo was still private, a user with neither
an SSH key nor HTTPS credentials got `fatal: unable to get password from user` (exit 1).

A successful `add` writes both `<CLAUDE_CONFIG_DIR>/plugins/known_marketplaces.json` and
`extraKnownMarketplaces.<name>` in `<CLAUDE_CONFIG_DIR>/settings.json`. The clone lives in
`<CLAUDE_CONFIG_DIR>/plugins/marketplaces/<name>`.

### Commands

```sh
claude plugin marketplace add ssteuteville/livediff#stable
claude plugin marketplace list --json
claude plugin install livediff@livediff --json
claude plugin list --json
claude plugin marketplace update livediff
claude plugin update livediff@livediff --json
```

- `marketplace list --json` returns an array of `{name, source, repo|url|path, ref?, installLocation}`.
- `install --json` prints one line with `outcome: "ok"`. Running it again is idempotent. The
  second run adds `installedVersion` and `availableVersion`.
- `plugin list --json` returns `[{id, version, scope, enabled, installPath, installedAt, lastUpdated}]`.
  Its `version` is the installed version. `list --json --available` wraps this as
  `{installed, available}`.
- The installed version is stored on disk in `<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`
  as `plugins["livediff@livediff"][].version`, together with `gitCommitSha`. The files are in
  `plugins/cache/<marketplace>/<plugin>/<version>/`.
- `plugin update` does not refresh the marketplace. It reported `up_to_date` against the
  stale clone after the ref had moved. It upgraded only after `marketplace update livediff`
  had run: `updateOutcome:"updated"`, `oldVersion`, `newVersion`, exit 0. Then
  `plugin list --json` showed the new version. The update applies after a restart.
- Failures exit 1 with `outcome:"failed"` and a `failureCode` (seen: `not_found`). An unknown
  marketplace in `marketplace update` exits 1 and lists the available names. A `marketplace update`
  that cannot reach the network exits 1 and leaves the installed version unchanged.
- `marketplace remove livediff` also removes installed plugins from that marketplace.
- Non-interactive: `-y` is needed only for marketplace-declared command sources, and LiveDiff
  has none.

### Conflict behaviour

`marketplace add` alone is not a safe conflict check. Read `marketplace list --json` first.

| Existing `livediff` registration | New `add`           | Result                                                                                    |
| -------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| git `…#stable`                   | same source and ref | `already on disk`, exit 0.                                                                |
| git `…#stable`                   | same URL, `#main`   | Refused: `its network source differs from the one declared for it in settings …`, exit 1. |
| directory                        | any network source  | Refused with the same message, exit 1.                                                    |
| git                              | a local directory   | **Silently repointed** to the directory, exit 0.                                          |

Shane's live profile already declares `livediff` as `directory: ~/shane-dev/livediff`, so
`add ssteuteville/livediff…` would be refused there. This was not run against the live
profile; it follows from the same-shape isolated test.

## Codex CLI (0.147.0)

### Source and ref syntax

`codex plugin marketplace add <source> [--ref <ref>] [--sparse <path>]…`. The help lists these
source forms: a local path, `owner/repo[@ref]`, an HTTPS Git URL, or an SSH Git URL.

| Form                               | Result                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `owner/repo --ref <ref>`           | Accepted. Cloned from `https://github.com/owner/repo.git`. Checked-out commit matched the ref. |
| `owner/repo@<ref>`                 | Accepted. Stored the same way.                                                                 |
| `http(s)://…/repo.git --ref <ref>` | Accepted.                                                                                      |
| `http(s)://…/repo.git#<ref>`       | The fragment is treated as the ref. Matched an existing `--ref stable` registration.           |

Codex clones over HTTPS only. Anonymous clones of the public repo work. A private repo without
credentials fails with `could not read Username for 'https://github.com'` (exit 1).

State lives in `<CODEX_HOME>`:

- `config.toml` has `[marketplaces.<name>]` with `source_type`, `source`, `ref`,
  `last_updated`, and `last_revision` once upgraded. It also has `[plugins."<plugin>@<mkt>"] enabled = true`.
- The marketplace snapshot is a full clone at `.tmp/marketplaces/<name>` unless `--sparse` is given.
- Installed plugin files are at `plugins/cache/<mkt>/<plugin>/<version>/`.

### Commands

```sh
codex plugin marketplace add ssteuteville/livediff --ref stable --json
codex plugin marketplace list --json
codex plugin add livediff@livediff --json
codex plugin list --json
codex plugin marketplace upgrade livediff --json
```

- `marketplace add --json` returns `{marketplaceName, installedRoot, alreadyAdded}`.
  Re-adding the identical source gives `alreadyAdded: true`, exit 0.
- `marketplace list --json` returns `{marketplaces:[{name, root, marketplaceSource:{sourceType, source}}]}`.
  It does not show the ref, so read `config.toml` for that.
- `plugin add --json` returns `{pluginId, version, installedPath, …}` and is idempotent.
- `plugin list --json` returns `{installed:[{pluginId, version, installed, enabled, source, marketplaceSource, …}], available:[]}`.
  Its `version` matched the directory name under `plugins/cache/…` in every test.

### Upgrade path: proven

1. Install at 0.12.1.
2. Move the ref to a commit with 0.12.2 and a new marker file.
3. Run `codex plugin marketplace upgrade livediff --json`. It returned `upgradedRoots` containing
   the marketplace. `plugins/cache/livediff/livediff/` then contained only `0.12.2`, with the new
   marker file in it. `plugin list --json` reported `0.12.2`, and `config.toml` recorded
   `last_revision` equal to the ref's commit.
4. The same happened at 0.12.3. When content changed but the version did not, `upgrade` still
   replaced the cached files.
5. Running `upgrade` with nothing new returns `upgradedRoots: []`, exit 0.
6. When the network is unreachable, `upgrade` exits 1 with
   `Failed to upgrade marketplace …` and a plain-text error, even with `--json`. The installed
   version is unchanged.

Verification sequence for the adapter: run `marketplace upgrade <name> --json`, then
`plugin list --json`, and compare the `version` for `livediff@livediff` against the expected
release version. No separate plugin-update subcommand exists or is needed.

### Conflict behaviour

Any `add` using the same name with a different source is refused:
`marketplace 'livediff' is already added from a different source; remove it before adding this source`
(exit 1). This covers a different ref, a different URL, or a local path. Codex never silently
repoints.

Shane's live profile has `[marketplaces.livediff] source_type = "local"`
(`~/shane-dev/livediff`), so setup would hit this refusal.

`marketplace remove <name>` deletes the snapshot, and `plugin list` then shows nothing. It leaves
the orphaned `[plugins."livediff@livediff"]` table in `config.toml` and the
`plugins/cache/livediff/…` directory in place. Removing an unknown name exits 1.

## Portable skill: `skills` installer (1.7.0)

Pin it as `npx -y skills@1.7.0 …`.

### Source and ref syntax

| Form                       | Meaning                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `owner/repo#<ref>`         | GitHub repo at a ref. Proven.                                                           |
| `owner/repo#<ref>@<skill>` | Ref plus a skill filter, according to the source code.                                  |
| `owner/repo@<skill>`       | **Skill filter, not a ref.** This differs from Claude and Codex, where `@` means a ref. |
| `https://…/repo.git#<ref>` | Git URL at a ref. Proven.                                                               |
| `/abs/local/path`          | Local directory. A ref is not possible.                                                 |

The installer clones with `git clone --depth 1 --branch <ref>`. If an HTTPS clone of a GitHub URL
fails for lack of auth, it retries with `gh repo clone` and then with SSH. With a bad ref, `add`
exits 1 and the `--json` entry has `status:"failed"` and `Remote branch <ref> not found`.

### Verified command

```sh
npx -y skills@1.7.0 add ssteuteville/livediff#stable --skill livediff --global \
  --agent cursor github-copilot gemini-cli opencode -y --json
```

- `--agent` takes several IDs separated by spaces. `copilot` is rejected (`Invalid agents`,
  exit 1), so the ID must be `github-copilot`. `cursor`, `github-copilot`, `gemini-cli`, and
  `opencode` are valid IDs.
- `--skill livediff` installed only that skill, even though the source also contained another
  skill. An unknown skill name exits 1.
- Always pass `-y`. Without a TTY and without `-y`, it prints `Proceed with installation?` and
  exits 0. When `AI_AGENT`, `CLAUDECODE`, or a similar variable is set, it detects an agent and
  runs non-interactively anyway.

### Where files land

All four targets are "universal" agents in skills 1.7.0, because their project `skillsDir` is
`.agents/skills`. A global install for any of them writes one real directory, not a symlink:

```text
~/.agents/skills/livediff/
```

Nothing is written to `~/.cursor/skills`, `~/.copilot/skills`, `~/.gemini/skills`, or
`~/.config/opencode/skills`. The `globalSkillsDir` values in the installer only apply to
non-universal agents. The `--json` output reports `mode:"copy"`.

This means:

- The four agents cannot hold separate versions. Installing, updating, or removing the skill for
  one of them affects all of them, and the installer does not tell them apart.
- **Codex also reads `~/.agents/skills` as user-scope skills.** A `skills/list` call through
  `codex app-server`, with isolated `HOME` and `CODEX_HOME`, returned
  `~/.agents/skills/livediff/SKILL.md` with `scope:"user"`. Installing the portable skill for any
  of the four agents therefore also gives Codex a loose `livediff` skill next to the native
  plugin. This contradicts the spec's rule of "no duplicate loose skill for native Claude/Codex".
- Claude Code reads `~/.claude/skills`, not `~/.agents/skills`. It was not checked for picking up
  this directory.

### Ownership record (lock file)

The global lock is at `$XDG_STATE_HOME/skills/.skill-lock.json` when that variable is set, and
otherwise at `~/.agents/.skill-lock.json`. It has version 3, keyed by skill name, with fields
`source`, `sourceType`, `sourceUrl`, `ref`, `skillPath`, `skillFolderHash`, `installedAt`, and
`updatedAt`.

The lock is written only for GitHub-shaped sources (`owner/repo`). A plain Git URL or a local path
installs the files but writes no lock entry. For those sources, `list` shows `source: null`, and
`update` reports `No installed skills found matching: livediff` while still exiting 0. The
release source must therefore be GitHub `owner/repo#<ref>` for updates to work.

### list / update / remove

| Command                                  | Scope and behaviour                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills list -g --json [-a <agent>]`     | `[{name, path, scope, agents, source, sourceUrl, sourceType}]`. `agents` lists the agents whose home directory exists, such as `~/.cursor`.              |
| `skills update livediff -g -y`           | Can be limited to one skill but not to one agent (there is no `-a`). It compares against the stored hash, reinstalls from the stored `ref`, and exits 0. |
| `skills remove livediff -g -y`           | Deletes `~/.agents/skills/livediff` and its lock entry, exit 0.                                                                                          |
| `skills remove livediff -g -a cursor -y` | Reports `Successfully removed`, exit 0, but for universal agents **nothing is removed**: the directory and the lock entry stay.                          |
| `skills remove <unknown> -g -y`          | `No skills found to remove.`, exit 0.                                                                                                                    |

Updating the GitHub-sourced lock entry was proven by marking the stored hash stale. Moving the
ref on GitHub was not tested, because nothing was pushed.

### Existing skill frontmatter

In the current `plugins/livediff/skills/*/SKILL.md`, skills 1.7.0 skips `open`, `comments`,
`lens`, and `pr`. Their unquoted `when_to_use` values are invalid YAML. It accepts `config`,
`link`, `prune`, and `review`. The new portable `livediff` skill needs frontmatter that parses as
strict YAML.

## cursor-agent (2025.09.17-25b418f)

The installed build contains no references to `SKILL.md`, `.cursor/skills`, or `.agents/skills`,
and has no skills command. This build does not discover skills, so Cursor skill discovery cannot
be checked with it.

## Deviations from the spec's assumed commands

- **Claude:** the spec writes `marketplace add ssteuteville/livediff`. The stable channel must add
  a ref, as `ssteuteville/livediff#<ref>`. `claude plugin update` alone does not pick up a new
  release: `claude plugin marketplace update livediff` must run first.
- **Codex:** the spec writes `marketplace add ssteuteville/livediff`. It needs `--ref <ref>` (or
  `@<ref>`). The upgrade that the spec left open works: `codex plugin marketplace upgrade livediff`
  also refreshes installed plugins, and `codex plugin list --json` confirms the result.
- **Skills installer:** the source must be `ssteuteville/livediff#<ref>`, not `@<ref>`. The four
  agents share one directory, so there is no per-agent install. A targeted update or remove for
  one agent is impossible, and `remove -a <agent>` is a silent no-op. The shared directory is also
  read by Codex.
- **npm:** `npm bin -g` no longer exists.

## Unresolved gates

1. ~~Public source access~~. Resolved on 2026-09-23: the repo is public, and anonymous access
   was verified for Claude, Codex, and skills against `main`.
2. **npm name.** `livediff` is unclaimed today. Ownership is not secured until the first publish.
3. **Stable ref.** No `stable` branch or tag exists on the remote yet. The syntax is proven only
   against a local bare repo and an existing remote branch.
4. **Codex loose-skill duplication.** Installing the portable skill for any of the four agents
   also exposes it to Codex, which may already have the native plugin. The design must accept
   this, or avoid `~/.agents/skills`, for example by using `--copy` into agent-specific
   directories. The installer does not do that for universal agents in 1.7.0.
5. **Per-agent scoping of the portable skill.** This is not possible with skills 1.7.0. The spec's
   acknowledgement flow for an "affected unselected harness" must treat all four agents and Codex
   as sharing one copy.
6. **Harness discovery of `~/.agents/skills`.** Verified for Codex only. Not verified for Cursor
   (the installed cursor-agent has no skill support), GitHub Copilot, Gemini CLI, or OpenCode.
7. **Claude third-party marketplace auto-update.** Not observed. Setup must not assume it is on.
8. **Sparse checkouts.** `--sparse` exists in both Claude and Codex but was not tested. Without it,
   Codex keeps a full clone of the repository.
9. **Linux.** Everything here was observed on macOS only.
