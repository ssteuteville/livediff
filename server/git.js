import { execFile } from "node:child_process";
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

async function currentBranch(cwd) {
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
    for (const [path, stat] of numstat) {
      const code = statusByPath.get(path) || "M";
      const patch = await git(cwd, ["diff", "HEAD", "--", path]);
      files.push(buildFile(path, path, statusName(code), stat, patch));
      seen.add(path);
    }
  }

  // Untracked files: synthesize an "added" diff via --no-index against /dev/null.
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...EXCLUDE]))
    .split("\0")
    .filter(Boolean);
  for (const path of untracked) {
    if (seen.has(path)) continue;
    const patch = await git(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
    const stat = parseNumstat(
      await git(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", path])
    ).get(`/dev/null => ${path}`) || guessAddStat(patch);
    files.push(buildFile(path, path, "added", stat, patch));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { repo: cwd, branch, head, base: null, files };
}

function guessAddStat(patch) {
  let additions = 0;
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) additions++;
  return { additions, deletions: 0, binary: /Binary files/.test(patch) };
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

/** Cheap per-workspace summary for the rail: branch, head, changed-file count. */
export async function summary(cwd) {
  if (!(await isGitRepo(cwd))) {
    return { valid: false, branch: null, head: null, changedFiles: 0 };
  }
  const branch = await currentBranch(cwd);
  const head = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() || null;
  let changedFiles = 0;
  if (await hasHead(cwd)) {
    const tracked = (await git(cwd, ["diff", "--name-only", "HEAD", ...EXCLUDE]))
      .split("\n")
      .filter(Boolean);
    changedFiles += tracked.length;
  }
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...EXCLUDE]))
    .split("\0")
    .filter(Boolean);
  changedFiles += untracked.length;
  return { valid: true, branch, head, changedFiles };
}
