# Independent Claude review

Completed using Claude CLI, reported model claude-opus-5-5, source commit d0ec5fc. Read-only static review with Read/Glob/Grep, no permission denials. The text below is Claude's unedited assessment, not a set of independently verified exploit results. See the consolidated review for corrections and qualifications, especially browser reachability and installer telemetry.

# LiveDiff security review: `main` at `d0ec5fc` (0.12.0-rc.2)

**Bottom line: I don't recommend using this on private source repositories until findings 1–3 are fixed.** The hub is an HTTP API with no authentication on `127.0.0.1:4180` (or the next free port). It keeps running once started and never checks the `Host`, `Origin` or `Content-Type` headers. So any web page open in the user's browser can:

- write files on disk (finding 1);
- read the full source of the repositories, using DNS rebinding (finding 2);
- plant review comments that the user's coding agent will read and act on (finding 3).

This was a read-only review. I didn't run anything, and I didn't read `.env` or any secret files.

---

## Findings

### 1. High (Critical when combined with 2 or 3): the `base` parameter is passed to git as a command-line option, which lets any web page write files

- **Where:** `server/index.ts:309-310` (`/api/diff`) and `server/index.ts:339-341` (`/api/stale`) pass `?base=` to git unchecked. It flows through `server/git.ts:198-202` (`mergeBase`), then `git.ts:245, 246, 257, 264` (`git diff … <against> -- …`) and `git.ts:416-417` (`changedPaths`).
- **How it works:**
  - With `base=--output=/some/file`, `git merge-base --output=… HEAD` fails with an empty stdout.
  - `git()` (`git.ts:97-109`) swallows the error and returns `""`, so `mergeBase` falls back to the raw string (`git.ts:201`).
  - git then runs `git diff --output=/some/file -- . :(exclude).diff-review`. `--output=<file>` is a documented `git diff` option that writes the diff to that file.
  - The result: any file the user can write gets created or overwritten with the workspace diff.
  - Only the registration path (`index.ts:261`, `289`) checks the ref with `isValidRef`; these query-string paths don't.
- **Who can trigger it:** any web page, using a plain cross-site GET such as `<img src="http://127.0.0.1:4180/api/diff?path=.&base=--output=…">`. Reading the response isn't needed.
  - The attacker needs a registered workspace. `?path=.` resolves against the hub's working directory (`registry.ts:98-105`, `193-201`). The hub is spawned with no `cwd` (`ensure-hub.ts:72-75`), so that's wherever the user first ran `livediff .`, which is normally a registered repo.
  - Otherwise, a guessed absolute path, or its ID (`sha1(path)[:8]`), works.
- **Impact:** overwriting or truncating dotfiles, source files or config.
  - Code execution is conceivable if the diff contains attacker-influenced lines (for example a PR under review) and lands in a file that gets executed. I didn't verify that.
  - I also didn't run git to confirm this chain; it's based on reading the code and git's documented options.
- **Fix:**
  - Reject any ref starting with `-`.
  - Resolve every base with `git rev-parse --verify --end-of-options <ref>^{commit}` and pass only the resulting SHA to later commands.
  - Put `--end-of-options` (git ≥ 2.24) before revisions in `merge-base` and `diff`.
  - Treat a failed `merge-base` as an error, not a fallback to the raw string.

### 2. High: DNS rebinding lets a web page read all source code, because the `Host` header is never checked

- **Where:** `server/index.ts:213-214` uses `req.headers.host` only to build a URL. No route checks `Host` or `Origin`, and there's no token anywhere in `index.ts:213-542`.
- **Who can exploit it:** a malicious site the user visits, whose domain is re-pointed at 127.0.0.1. The page then becomes "same-origin" with the hub and can read every response. Browser local-network-access protections may block or prompt for this; that varies by browser and I didn't verify it.
- **Impact:**
  - `/api/workspaces` gives every registered path, branch and comment count.
  - `/api/diff` gives diffs plus the full contents of untracked, non-ignored files.
  - `/api/diff?base=<empty-tree SHA or root commit>` produces a diff of the **entire tracked repository**. The value is unvalidated (finding 1), and `mergeBase` falls back to the raw ref.
  - `POST /api/workspaces {"path": …}` can register any git repo whose path the attacker can guess. If the home directory is a dotfiles git repo, untracked files such as keys become readable unless gitignored.
  - `/api/comments` and `/api/events` are readable too.
- **Fix:**
  - Accept only `Host` values of `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`.
  - Add a per-hub random secret: store it in the state file with mode 0600, have the CLI send it as a header, and hand it to the browser through a one-time URL token exchanged for a `SameSite=Strict` HttpOnly cookie.

### 3. Medium–High: any web page can make state-changing requests (CSRF), including planting prompts for coding agents

- **Where:** `readBody` (`index.ts:135-144`) parses JSON whatever the `Content-Type`. That means `text/plain` POSTs, which browsers send cross-site without a preflight check, are accepted. Affected endpoints:
  - `/api/shutdown` (`233-241`): stops the hub.
  - `POST /api/workspaces` (`253-272`): registers an arbitrary repo.
  - `POST /api/comments?path=.` (`403-409`): creates comments, and the caller can set `author` (`comments.ts:267`).
  - `/api/sweep` with `force` (`358-379`), then `/api/purge` (`381-401`). `keepDays` may be negative, because the server doesn't enforce the CLI's `>= 0` check, so this chain can archive and then permanently delete comments.
  - `POST /api/lenses` and `POST /api/reviews`.
  - PATCH, PUT and DELETE are protected by the browser's preflight check only because the hub sends no CORS headers.
- **Impact:** the planted comments are exactly what `livediff comments --json` hands to the agent. The skill tells the agent to act on them (`skills/livediff/references/comments.md`), so this is a direct way to inject instructions into Claude or Codex. It also enables denial of service and deletion of review data.
- **Fix:**
  - Require `Content-Type: application/json` plus the secret from finding 2.
  - Reject requests with `Sec-Fetch-Site: cross-site`, or with an `Origin` other than the hub's own.
  - Validate `keepDays >= 0` on the server.

### 4. Medium (multi-user hosts) / Low (single-user laptops): other local users and processes can use the API

- **Where:** the whole API has no authentication.
- **Impact:** on a shared machine, any other local account can read the diffs of private repos and use findings 1 and 3.
- **Also:** data files are written with default permissions (`atomic.ts:19`, `comments.ts:178`), usually 0644. That makes the comment store (which contains source excerpts in `lineContent`), the registry and `hub.log` readable by other users.
- **Fix:** the secret from finding 2; create the config and state directories as 0700 and files as 0600.

### 5. Medium (when reviewing untrusted branches or PRs): a branch under review can control what the reviewer and agent see

- **Hidden files:** `.diff-review` is excluded from every diff (`git.ts:34`). A PR can add or change files under `.diff-review/` and they never appear in LiveDiff.
- **Imported comments:** `migrateLegacy` (`comments.ts:160-181`) imports `<worktree>/.diff-review/comments.json` as review comments the first time a workspace is used (always true for a new PR worktree). It then **deletes that file from the worktree**. So a PR can plant "reviewer" comments that reach the agent.
- **Instructions file:** `SKILL.md:28-30` and `references/pr-review.md:49` tell the agent to "read `.livediff` and follow it before doing anything else", including in worktrees created from fork PRs. That file is instructions controlled by the repository author.
- **Fix:**
  - Limit the legacy migration to an explicit command, and never delete tracked files.
  - Show excluded paths instead of hiding them.
  - Change the skill to treat `.livediff` and comment text as untrusted data. At minimum, ignore `.livediff` in PR or branch review worktrees.

### 6. Low–Medium: untracked-file reading follows symlinks and special files

- **Where:** `readAddedFile` (`git.ts:292-298`) calls `readFile(join(cwd, path))` on each untracked path.
- **Impact:**
  - An untracked symlink (for example one created by a tool or an agent) pointing at `~/.ssh/id_rsa` puts that file's contents in the diff shown in the UI, which the finding 2 attacker can read. git itself would show only the link target.
  - A FIFO hangs the request.
  - There's no size cap.
- **Fix:** `lstat` first; show symlinks as their target path the way git does; skip anything that isn't a regular file; cap the size.

### 7. Low: the static file path check has no trailing separator

- **Where:** `index.ts:194-195` checks `filePath.startsWith(DIST)` with no trailing separator. A request like `/..%2Fdist-server%2F…` (decoded at `192`) reaches `<pkg>/dist-server/…`.
- **Impact:** only files inside the published package are exposed, and those are public. Informational today.
- **Fix:** use `startsWith(DIST + sep)` or a `path.relative` check.

### 8. Low / optional hardening

- **Request size:** `readBody` has no size limit (`index.ts:135-144`), so memory can be exhausted.
- **Missing headers:** no CSP, `frame-ancestors` or `X-Content-Type-Options` on any response, so the UI can be framed (for example, tricking a click on "Done reviewing").
- **`innerHTML` in the fast renderer:** `src/syntax.ts:113-116` assigns highlight.js output to `innerHTML` on a div from the live document. It's safe only because highlight.js escapes its input; parsing in an inert `<template>` or with `DOMParser` would be more robust.
  - The classic renderer, `@git-diff-view/react`, injects HTML (`dist/esm/index.mjs:320-358`). Its core escapes content by default (`core/dist/esm/index.mjs:533`, `escapeHtml`). I found no XSS in LiveDiff's own React code.
- **Terminal escape sequences:** comment bodies, file names and anchors are printed to the terminal raw (`server/comment-format.ts:43-46`), so ANSI or OSC sequences from planted comments (finding 3 or 5) reach the terminal. Strip control characters.

### 9. Supply chain (Medium as a policy matter; hardening)

- **Plugins track a moving branch:** agent plugins and skills are installed from the `stable` branch on GitHub (`server/setup/source.ts:30-35`, `install.sh:120-132`). They aren't pinned to a commit or release. If the maintainer account or the `stable` branch is compromised, new agent instructions get pushed onto users. Pin to a release tag or commit SHA.
- **`@latest` installs:**
  - `setup --update` installs `livediff@latest` and hands the rest of setup to the new binary (`server/setup/npm.ts:177-190`, `255-278`).
  - The docs tell users to run `npx livediff@latest setup` (`SKILL.md:12, 32`).
  - `npx -y skills@1.7.0` (`adapters/skills.ts:33, 311`) pins that package exactly, but its dependencies float.
  - `LIVEDIFF_SETUP_PACKAGE` lets an environment variable choose any npm spec to install (`npm.ts:173-186`); only local actors can set it.
- **`install.sh`:**
  - Runs `$PM install` without `--frozen-lockfile` (`install.sh:68`).
  - Its npm fallback ignores `pnpm-lock.yaml`, so `^` ranges resolve fresh and every install script runs. Under pnpm, only esbuild and lefthook may run build scripts (`package.json:102-106`).
  - Use `pnpm install --frozen-lockfile`, or refuse to fall back to npm.
- **Release workflow (`.github/workflows/release.yml`):**
  - Actions are pinned by tag, not SHA (`20, 25, 26`).
  - `npm install -g npm@latest` (`34`) runs in a job holding `id-token: write` and `contents: write` (`11-13`). Pin both.
- **Published package:** the runtime dependencies are small (`@clack/prompts` 1.8.1 exact, `jsonc-parser` ^3.3.1). The tarball ships no lockfile, so the dependencies below those resolve when the user installs. I found no git or tarball dependency URLs in `pnpm-lock.yaml`.
- **Known vulnerability advisories: not checked.** I couldn't run `npm audit` or look up OSV. Vite 6.4.3 (dev only), highlight.js 11.11.1 (bundled into the UI) and @git-diff-view 0.1.7 need a separate advisory check.

### 10. Privacy (informational)

- **No outbound network calls found:** every `fetch` in `server/` goes to loopback, and `src/` only calls relative `/api/*`. I found no telemetry.
- **Data kept on disk:** comments (with quoted source lines) are kept in plain text under `~/.config/livediff/comments/` for up to 200 days after being archived (`constants.ts:28`).
- **Data sent to agents:** by design, comment and diff contents go to whatever AI agent runs the CLI.

---

## Interim mitigations if it's used before fixes land

These reduce the risk but don't remove it.

- Run `livediff stop` whenever you're not actively reviewing, since the hub never exits on its own.
- Avoid browsing untrusted sites while it's running.
- Don't use the PR-review workflow on external or fork branches.

## Scope and limitations

- **Method:** static reading only. Nothing was executed, and the git `--output` chain and browser behavior are inferred, not tested. Finding nothing in an area doesn't mean it's safe.
- **Read in full:**
  - `package.json`
  - `server/`: `index.ts`, `git.ts`, `registry.ts`, `comments.ts`, `hub-state.ts`, `ensure-hub.ts`, `open-browser.ts`, `cmux-open.ts`, `reviews.ts`, `cli.ts`, `config.ts`, `atomic.ts`, `comment-format.ts`, `constants.ts`
  - `server/setup/`: `npm.ts`, `source.ts`, `process.ts`
  - `src/`: `api.ts`, `syntax.ts`, `components/FileDiff.tsx`
  - `index.html`, `vite.config.js`, `install.sh`, both workflows, `SKILL.md` and its `comments.md` and `pr-review.md` references
- **Read in part or by search:**
  - `server/setup/adapters/skills.ts`, `server/setup/prerequisites.ts`, `server/lenses.ts`
  - `src/App.tsx`, `src/components/*`
  - `pnpm-lock.yaml`, and the `@git-diff-view` dist files
- **Not reviewed:**
  - `server/`: `doctor.ts`, `sse.ts`, `glob.ts`, `locks.ts`, `migrations.ts`, `executable-path.ts`, and `completion-state.ts` / `cli-completion.ts` (these write shell rc files)
  - the rest of `server/setup/` (`index.ts`, `lock.ts`, `state.ts`, the claude, codex and native adapters)
  - `FastDiff.tsx`, `CommentThread.tsx` and the other components beyond the search
  - `scripts/*` (release tooling), tests, benches, docs, and most of `node_modules`
- **No dependency advisory database was consulted.** Line numbers refer to commit `d0ec5fc`.
