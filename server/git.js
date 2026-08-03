import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Keep livediff's own comment store out of the diff it renders.
const EXCLUDE = ["--", ".", ":(exclude).diff-review"];

const EXT_LANG = {
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", json: "json",
  css: "css", scss: "scss", less: "less",
  html: "xml", xml: "xml", vue: "vue", svg: "xml",
  md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", sql: "sql", graphql: "graphql",
  toml: "ini", ini: "ini", dockerfile: "dockerfile",
};

function langFor(path) {
  if (!path) return "plaintext";
  const base = path.split("/").pop().toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return EXT_LANG[ext] || "plaintext";
}

/** Run git and always resolve with stdout, even when it exits non-zero (diff uses exit 1 for "differences found"). */
async function git(cwd, args) {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    if (typeof err.stdout === "string") return err.stdout;
    throw err;
  }
}

export async function isGitRepo(cwd) {
  try {
    const out = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return out.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Absolute path of the worktree root containing `cwd`. Returns null when `cwd` is not inside a
 * work tree. Correct for linked worktrees, where it resolves to the worktree — not the main repo.
 */
export async function toplevel(cwd) {
  try {
    const out = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    return out.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function currentBranch(cwd) {
  const out = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return out === "HEAD" ? "(detached)" : out;
}

async function hasHead(cwd) {
  try {
    await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return true;
  } catch {
    return false;
  }
}

function parseNumstat(out) {
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split("\t");
    const path = rest.join("\t");
    map.set(path, {
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
      binary: add === "-",
    });
  }
  return map;
}

/**
 * Split one whole-tree `git diff` into per-file patches.
 *
 * One spawn instead of one per file: on 500 changed files the per-file loop measured 7.3s against
 * 75ms for a single spawn, because process startup dominates once the diff itself is trivial.
 *
 * Attribution is by matching the `diff --git … b/<path>` header against paths git already gave us
 * in --numstat, rather than by parsing the header, so quoting and spaces cannot mis-assign a
 * patch. Anything unmatched is simply absent from the map and the caller re-runs it alone.
 */
function splitPatches(all, knownPaths) {
  const patches = new Map();
  if (!all.trim()) return patches;

  const byLongest = [...knownPaths].sort((a, b) => b.length - a.length);
  for (const chunk of all.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const header = chunk.slice(0, chunk.indexOf("\n"));
    // Longest first: `src/a.ts` must not claim a header ending in `vendor/src/a.ts`.
    const path = byLongest.find((p) => header.endsWith(`b/${p}`) || header.endsWith(`b/"${p}"`));
    if (path && !patches.has(path)) patches.set(path, chunk);
  }
  return patches;
}

/**
 * Build the diff for the working tree.
 * @param {string} cwd repo path
 * @param {string|null} base optional ref to diff against (e.g. "main"); default is working tree vs HEAD + untracked
 */
export async function getDiff(cwd, base) {
  const branch = await currentBranch(cwd);
  const head = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() || null;

  if (base) {
    const numstat = parseNumstat(await git(cwd, ["diff", "--numstat", `${base}...HEAD`]));
    const files = [];
    for (const [path, stat] of numstat) {
      const patch = await git(cwd, ["diff", `${base}...HEAD`, "--", path]);
      files.push(buildFile(path, path, "modified", stat, patch));
    }
    return { repo: cwd, branch, head, base, files };
  }

  const files = [];
  const seen = new Set();
  const withHead = await hasHead(cwd);

  if (withHead) {
    const numstat = parseNumstat(await git(cwd, ["diff", "--numstat", "HEAD", ...EXCLUDE]));
    const nameStatus = await git(cwd, ["diff", "--name-status", "HEAD", ...EXCLUDE]);
    const statusByPath = new Map();
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0][0];
      const path = parts[parts.length - 1];
      statusByPath.set(path, code);
    }

    const patches = splitPatches(await git(cwd, ["diff", "HEAD", ...EXCLUDE]), [...numstat.keys()]);
    for (const [path, stat] of numstat) {
      const code = statusByPath.get(path) || "M";
      // A path the splitter could not attribute — an exotic quoted name, say — falls back to its
      // own spawn. Correctness never depends on the fast path being able to parse everything.
      const patch = patches.get(path) ?? (await git(cwd, ["diff", "HEAD", "--", path]));
      files.push(buildFile(path, path, statusName(code), stat, patch));
      seen.add(path);
    }
  }

  // Untracked files. An added file's patch is fully determined by its contents — every line is an
  // addition — so it is synthesized from a read instead of the two `--no-index` spawns per file
  // this used to cost. 500 untracked files went from ~1000 spawns to none.
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...EXCLUDE]))
    .split("\0")
    .filter(Boolean);
  const added = await Promise.all(
    untracked.filter((p) => !seen.has(p)).map((path) => readAddedFile(cwd, path))
  );
  files.push(...added.filter(Boolean));

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { repo: cwd, branch, head, base: null, files };
}

/**
 * Build the patch for an untracked file from its contents. Every line of a new file is an
 * addition, so there is nothing for git to compute and no reason to pay for a subprocess.
 * Returns null when the file cannot be read — it may have been deleted mid-scan.
 */
async function readAddedFile(cwd, path) {
  let buf;
  try {
    buf = await readFile(join(cwd, path));
  } catch {
    return null;
  }

  // git's own heuristic: a NUL byte in the first 8000 bytes means binary.
  const binary = buf.subarray(0, 8000).includes(0);
  if (binary) {
    const patch =
      `diff --git a/${path} b/${path}\nnew file mode 100644\n` +
      `Binary files /dev/null and b/${path} differ\n`;
    return buildFile(path, path, "added", { additions: 0, deletions: 0, binary: true }, patch);
  }

  const text = buf.toString("utf8");
  const noTrailingNewline = text.length > 0 && !text.endsWith("\n");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline produces a final empty entry

  const body = lines.map((l) => `+${l}`).join("\n");
  const patch =
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${body}\n` +
    (noTrailingNewline ? "\\ No newline at end of file\n" : "");

  return buildFile(path, path, "added", { additions: lines.length, deletions: 0, binary: false }, patch);
}

function statusName(code) {
  switch (code) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    default: return "modified";
  }
}

function buildFile(path, oldPath, status, stat, patch) {
  return {
    path,
    oldPath,
    status,
    additions: stat?.additions ?? 0,
    deletions: stat?.deletions ?? 0,
    binary: stat?.binary ?? /Binary files/.test(patch),
    lang: langFor(path),
    patch: patch || "",
  };
}

/**
 * A cheap signature of the working tree used to detect changes for live reload.
 * Combines porcelain status with each changed file's size+mtime.
 */
export async function worktreeSignature(cwd, base) {
  if (base) {
    return (await git(cwd, ["diff", "--stat", `${base}...HEAD`])).trim() +
      "|" + (await git(cwd, ["rev-parse", "HEAD"])).trim();
  }
  const status = await git(cwd, ["status", "--porcelain=v1", "-uall", "-z", ...EXCLUDE]);
  return status;
}

/**
 * Paths that differ from HEAD, plus untracked files. Shared by the rail's summary and by the
 * lifecycle sweep, so a poll never runs the same git twice for the same information.
 */
export async function changedPaths(cwd) {
  const paths = [];
  if (await hasHead(cwd)) {
    const tracked = (await git(cwd, ["diff", "--name-only", "HEAD", ...EXCLUDE]))
      .split("\n")
      .filter(Boolean);
    paths.push(...tracked);
  }
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...EXCLUDE]))
    .split("\0")
    .filter(Boolean);
  paths.push(...untracked);
  return paths;
}

/** Cheap per-workspace summary for the rail: branch, head, changed-file count. */
export async function summary(cwd) {
  if (!(await isGitRepo(cwd))) {
    return { valid: false, branch: null, head: null, changedFiles: 0 };
  }
  const branch = await currentBranch(cwd);
  const head = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() || null;
  return { valid: true, branch, head, changedFiles: (await changedPaths(cwd)).length };
}
