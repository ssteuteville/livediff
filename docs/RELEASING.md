# Releasing livediff

This is the maintainer-facing release process for the `livediff` npm package. It is not the
consumer install doc — see `README.md` for that once distribution ships.

## How it works

One version lives in four places, kept in sync by `scripts/release-version.ts`:

- `package.json` `version`
- `plugins/livediff/.claude-plugin/plugin.json` `version`
- `plugins/livediff/.codex-plugin/plugin.json` `version`
- `release.json` — `{ "version": "x.y.z", "cliRange": ">=x.y.z" }`, the CLI range the plugin
  integrations declare they need

```
node dist-server/scripts/release-version.js <version>   # write
node dist-server/scripts/release-version.js --check     # verify agreement only
```

`pnpm package:check` (built as `scripts/check-package.ts`) calls `--check` as part of validating
a tarball, so a version drift fails packaging before it fails a publish.

`scripts/release.ts` (`pnpm release`) does everything else, in four independently gated phases.
Nothing is implied — each phase needs its own flag:

| Phase                                        | What it does                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (default) / `--dry-run`                      | Clean-tree + tag check, build, `npm pack` once into `release/`, run `package:check` and `package:smoke` against that tarball, print its path and sha512 integrity.            |
| `--publish <tarball> [--yes] [--otp <code>]` | Re-verifies the tarball's integrity against the sidecar `--dry-run` wrote, then `npm publish <tarball>` — never rebuilds or repacks. Interactive confirmation unless `--yes`. |
| `--verify-registry <version>`                | Compares `npm view livediff@<version> dist.integrity` to the local tarball's integrity.                                                                                       |
| `--promote <version> [--yes]`                | Validates both marketplace catalogs' plugin paths exist at tag `v<version>`, then (with `--yes`) fast-forward pushes `v<version>` to `refs/heads/stable`.                     |

`release/` is gitignored — the tarball's provenance is the git tag plus the npm registry, not a
copy checked into source control.

## Two-factor auth and OTP

The npm account that publishes (`steutedev`) has 2FA set to "auth and writes", so a local
`npm publish` prompts for a one-time password. `--publish` runs `npm publish` with inherited
stdio so that prompt works interactively, and accepts `--otp <code>` to pass one through
non-interactively. The OTP itself is never logged or captured.

GitHub Actions publishes via npm trusted publishing (OIDC) instead, which does not require an
OTP — `--publish` skips `--otp` handling entirely in that environment and adds `--provenance`
(only when `GITHUB_ACTIONS=true` and an OIDC token request URL is present; provenance requires
attestation to a public source, which this repository is).

## Node 22 floor

The packed CLI runs on plain `node`/`fs`/`fetch`/`AbortSignal.timeout` — nothing newer. The same
packed tarball was smoke-tested (`pnpm package:smoke`) on:

| Node    | Platform      | Result |
| ------- | ------------- | ------ |
| 22.0.0  | macOS (arm64) | pass   |
| 22.12.0 | macOS (arm64) | pass   |
| 22.17.0 | macOS (arm64) | pass   |
| 24.9.0  | macOS (arm64) | pass   |

`engines.node` is set to `>=22.12.0` — the first Node 22 LTS release ("Jod"), not the earliest
version that happened to pass — because that is the version most consumers on Node 22 will
actually be running, and it is what `install.sh`'s version check now requires. CI's
`package-smoke` job runs the packed artifact on `22.12.0` and `24` across `ubuntu-latest` and
`macos-latest` on every change (see `.github/workflows/ci.yml`); it has not run yet because
Actions minutes are exhausted this billing period.

`.node-version` stays `24` — that's the maintainer/build toolchain version (pnpm, Vite,
TypeScript, Lefthook), which is unrelated to what a consumer's `node` needs to be.

## First publication (manual, one time)

GitHub Actions minutes are exhausted and the repository access model wasn't finalized when this
was written, so the very first publish is done by hand, from a maintainer's machine:

```
pnpm release -- --dry-run
# inspect the printed tarball path/integrity, then:
pnpm release -- --publish release/livediff-<version>.tgz
# npm will prompt for an OTP if 2FA requires one
pnpm release -- --verify-registry <version>
pnpm release -- --promote <version> --yes
```

After that, configure npm trusted publishing so future releases run entirely from
`.github/workflows/release.yml` (`workflow_dispatch`, environment `npm-publish`):

1. On npmjs.com, under the `livediff` package's Settings → Publishing access, add a trusted
   publisher: repository `ssteuteville/livediff`, workflow `release.yml`, environment
   `npm-publish`.
2. In the GitHub repository settings, create environment `npm-publish` with a required reviewer
   (so a release needs a human approval click, not just a dispatch).
3. Allow GitHub Actions to push to the `stable` branch, or the `--promote` step's push will be
   rejected: Settings → Actions → General → Workflow permissions → "Read and write permissions",
   and if branch protection exists on `stable`, allow the Actions user/app as an exception for a
   fast-forward-only push (the promote step never force-pushes).

Once trusted publishing is configured, a release is:

```
gh workflow run release.yml -f version=<version>
```

## Recovery: npm published but promotion failed

`--promote` runs strictly after `--verify-registry` succeeds, and it never re-publishes. If the
npm publish succeeded but `--promote` fails (a catalog path is wrong, or the push is rejected as
non-fast-forward):

- **Do not** re-run `--publish` for the same version — npm rejects re-publishing an existing
  version, and even if it didn't, the published bytes are already correct and verified.
- Fix whatever `--promote` reported (a catalog's `source`/`path` field, a branch-protection
  exception, etc.) directly against the tag commit — do not create a new version to work around
  a promotion-only problem.
- Re-run `pnpm release -- --promote <version>` (add `--yes` once you're ready to push). It
  re-validates the catalogs and re-attempts the push; it is safe to run repeatedly.
- The package is fully installable via `npm install -g livediff@<version>` the moment
  `--publish` succeeds, independent of whether `stable` has been updated — `stable` only affects
  which ref the Claude/Codex plugin catalogs resolve to for agents tracking the release channel.

## Running a tarball ad hoc

`npx <path>` requires a `file:` prefix for a local tarball — a bare absolute path exits 126:

```
npx file:/absolute/path/to/livediff-0.11.2.tgz --version   # works
npx /absolute/path/to/livediff-0.11.2.tgz --version         # fails, exit 126
```
