# LiveDiff workplace security review

Reviewed 2026-09-23, fetched origin/main `d0ec5fc`, version 0.12.0-rc.2. Worktree detached at that commit; no source changes. This is a bounded review, not a security certification.

## Recommendation

Fix the Git argument handling, local HTTP trust boundary, and untracked symlink handling before recommending use with sensitive workplace repositories. The production dependency audit is clean, but it does not establish application safety.

## Findings

1. **High: an API comparison ref can become a Git option.** `server/index.ts:306-310` accepts the diff base without ref validation. `server/git.ts:201-204` falls back to the original input when merge-base fails, and lines 243-256 pass that value to git diff. An option that redirects output can overwrite a file writable by the process. A delegated review reproduced an overwrite using only a disposable fixture and the packaged git module. This requires reaching the local API and selecting a registered workspace; it is not shell injection. Resolve validated refs to commit IDs, fail closed on invalid refs, and defend the Git argument boundary at the shared helper.

2. **Medium: localhost API has no Host/Origin or session authorization checks.** `server/index.ts:213` dispatches directly, including shutdown at line 233 and purge/sweep at lines 358-396. Binding to 127.0.0.1 (`server/constants.ts:41`, `server/index.ts:559`) prevents direct LAN access but does not authenticate local callers or defend against browser-origin attacks. JSON parsing does not enforce a JSON Content-Type. Cross-origin writes and DNS rebinding are threat paths; a complete browser exploit was not demonstrated, and browser local-network protections affect reachability. Add strict Host and Origin checks plus an appropriate capability/token design for CLI and UI operations.

3. **Medium: untracked symlinks expose files outside the repository in diffs.** `server/git.ts:295` follows symlinks with readFile when synthesizing untracked additions. A delegated fixture reproduced an outside-file marker appearing in the diff. The prerequisite is an untracked, nonignored symlink; this is not a claim that every cloned tracked symlink triggers it. Use lstat/readlink and represent link targets the way Git does rather than reading their contents.

4. **Low: static path containment uses a string prefix.** `server/index.ts:192-199` decodes the URL and checks startsWith(DIST), allowing similarly named siblings such as dist-server. The path calculation was reproduced; no unrestricted filesystem-read claim is made. Use separator-aware containment and consider realpath/symlink boundaries.

5. **Conditional privacy hardening: stored review data inherits filesystem defaults.** `server/atomic.ts:16-19` creates directories/files without private modes. Under umask 022 these are normally 0755/0644; another local user can read them if parent directories are traversable. Store review data with owner-only permissions, including migration of existing files where appropriate.

6. **Medium privacy issue: portable setup does not disable third-party installer telemetry.** `server/setup/adapters/skills.ts:311-313` invokes pinned skills@1.7.0 with the inherited environment. That installer's default telemetry reports source, skill and selected-agent metadata unless DISABLE_TELEMETRY or DO_NOT_TRACK is set. This conflicts with the README's no-telemetry statement. No evidence of repository contents or secrets being sent was found. Explicitly disable telemetry for child installation/update processes. [Pinned upstream implementation](https://raw.githubusercontent.com/vercel-labs/skills/v1.7.0/src/telemetry.ts), [installation callsite](https://raw.githubusercontent.com/vercel-labs/skills/v1.7.0/src/add.ts).

7. **Medium agent trust-boundary issue: incoming PR instructions are treated as authoritative.** `skills/livediff/references/pr-review.md:49-50` and `plugins/livediff/skills/pr/SKILL.md:38` tell the agent to follow .livediff from the incoming PR worktree before review. `skills/livediff/SKILL.md:28-30` allows project instructions to override defaults. An untrusted PR author therefore controls text explicitly presented as instructions. This is not demonstrated deterministic code execution; harness permissions still apply. Use trusted base-branch configuration, and treat new or changed PR instructions as data requiring approval.

8. **Medium: automatic legacy migration imports PR-controlled comments and deletes the source file.** Independently identified by Claude and verified against `server/comments.ts:160-181`: when no central store exists, reading comments imports `<worktree>/.diff-review/comments.json` and removes it without checking whether it is tracked or trusted. A new PR worktree can supply valid comment records that are subsequently presented as review comments, including to an agent. `server/git.ts:34` also excludes the legacy directory from diffs. This is a confirmed data/provenance boundary issue, not proof an agent will execute malicious instructions. Make migration explicit or establish trusted provenance, never automatically delete tracked files, and expose otherwise-hidden changes during review.

## Independent Claude review and reconciliation

Claude CLI completed successfully with the reported model `claude-opus-5-5`, using only Read/Glob/Grep and no permission denials. The user explicitly approved sending the repository source to Anthropic. Its full unedited output is saved alongside this report as [2026-09-23-claude-security-review.md](2026-09-23-claude-security-review.md).

Claude independently identified the Git option injection, absent HTTP authentication/Host/Origin checks, symlink reads, static-prefix containment issue, local permissions, and untrusted PR instructions. Its legacy migration finding was checked directly against source and added above. Its report also notes that the purge API accepts negative retention days; direct source inspection confirms only finiteness is checked at `server/index.ts:385-390`.

Two qualifications matter: Claude's opening claim that any web page can exploit the hub is broader than the evidence, because browser local-network protections and request context affect reachability and no end-to-end browser exploit was run. Its statement that no telemetry was found covers its inspection of LiveDiff's own network calls; it does not negate the separately verified third-party skills installer telemetry. Dependency advisories were checked by this review, not by Claude. Supply-chain pinning, request size limits and security headers remain hardening suggestions rather than evidence of a compromised release.

## Dependencies

- `pnpm audit --prod --json`: zero known advisories across eight reported production dependencies.
- `pnpm audit --json`: three alerts, representing two distinct advisories in development dependencies.
- Nano ID 3.3.16: zero-size custom-generator denial of service, fixed in 3.3.18 or later. Installed PostCSS uses nanoid/non-secure with a fixed size of six; no matching vulnerable application path established. [Advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8).
- Vitest / @vitest/mocker 4.1.10: redirect-mock arbitrary file read, fixed in 4.1.11. The repository uses Vitest browser mode, which the upstream advisory distinguishes from unauthenticated standalone mocker usage. No standalone mocker plugin is configured. Upgrade the coordinated Vitest dependencies; this is not a vulnerability in the installed production CLI server. [Maintainer advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
- Browser libraries are classified as devDependencies but bundled into the shipped UI, so the production-only audit is not the complete shipped-code audit. The full audit covered those lockfile entries too.

## Secrets and limits

Gitleaks scanned all local refs and reflogs: 156 commits, approximately 2.54 MB, no detected secrets. This cannot prove absence of every sensitive value or inspect unavailable/deleted remote objects.

Independent Claude review is complete. It was static-only and did not run exploit tests or dependency advisory lookups.

Not verified: complete browser exploitation, every transitive dependency's source, package provenance/reproducibility, organization-specific software and AI data policies. Agent integrations continue to inherit the chosen harness's model/data handling policy. Review findings are private local artifacts; none were posted publicly.
