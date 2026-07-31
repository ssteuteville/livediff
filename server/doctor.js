import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configDir, readRegistry, idFor } from "./registry.js";
import { toplevel } from "./git.js";
import { readState, statePath, lockPath, pidAlive, probeMeta } from "./hub-state.js";

const exec = promisify(execFile);

const ok = (title, detail) => ({ level: "ok", title, detail });
const warn = (title, detail, fix) => ({ level: "warn", title, detail, fix });
const bad = (title, detail, fix) => ({ level: "error", title, detail, fix });

/**
 * A stale `pnpm link --global` symlink and an installed package can both be on PATH, and which
 * one runs depends on directory order — an "upgrade" that silently keeps running old code.
 */
async function checkPath() {
  let paths = [];
  try {
    const { stdout } = await exec("sh", ["-c", "command -v livediff; type -a livediff 2>/dev/null | sed -n 's/.* is //p'"]);
    paths = [...new Set(stdout.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    /* not on PATH */
  }
  if (!paths.length) {
    return warn(
      "livediff is not on PATH",
      "You are running it by file path.",
      "Run ./install.sh to install it globally."
    );
  }
  if (paths.length > 1) {
    return bad(
      "livediff resolves to more than one binary",
      paths.join("\n"),
      "Remove the stale one — usually `pnpm uninstall --global livediff`."
    );
  }
  return ok("livediff on PATH", paths[0]);
}

async function checkHub(version) {
  const state = await readState();
  if (!state) return ok("hub", "not running (any command will start it)");

  const meta = await probeMeta(state.port, 1500);
  if (!meta) {
    const detail = pidAlive(state.pid)
      ? `hub.json points at port ${state.port}, but nothing answers there (pid ${state.pid} is alive)`
      : `hub.json points at a dead pid (${state.pid})`;
    return warn("stale hub state", detail, `Remove ${statePath()} — or run \`livediff stop\`.`);
  }
  if (meta.version !== version) {
    return warn(
      "hub is running a different version",
      `CLI ${version}, hub ${meta.version}`,
      "Any command replaces it automatically; `livediff stop` forces it now."
    );
  }
  const mode = meta.polling ? "polling" : "dormant";
  return ok("hub", `running on port ${state.port} (v${meta.version}, ${meta.clients} clients, ${mode})`);
}

async function checkLock() {
  try {
    const info = await stat(lockPath());
    const age = Math.round((Date.now() - info.mtimeMs) / 1000);
    if (age > 30) {
      return warn(
        "stale spawn lock",
        `${lockPath()} is ${age}s old`,
        "Harmless — it is broken automatically after 30s. Delete it to silence this."
      );
    }
    return ok("spawn lock", "held by a starting hub");
  } catch {
    return ok("spawn lock", "clear");
  }
}

async function checkRegistry() {
  const workspaces = await readRegistry();
  if (!workspaces.length) return ok("registry", "no workspaces registered");

  const problems = [];
  const seen = new Map();
  for (const w of workspaces) {
    try {
      await access(w.path);
    } catch {
      problems.push(`${w.id}  ${w.path} — path no longer exists`);
      continue;
    }
    const root = await toplevel(w.path);
    if (root && root !== w.path) problems.push(`${w.id}  ${w.path} — not a worktree root (${root})`);
    const key = root ?? w.path;
    if (seen.has(key)) problems.push(`${w.id}  duplicates ${seen.get(key)} (same worktree)`);
    else seen.set(key, w.id);
    if (root && idFor(root) !== w.id) problems.push(`${w.id}  id does not match its path`);
  }

  if (!problems.length) return ok("registry", `${workspaces.length} workspace(s), all normalized`);
  return warn(
    "registry needs migration",
    problems.join("\n"),
    "Restart the hub (`livediff stop`, then any command) — it migrates on startup."
  );
}

async function checkLegacyDirs() {
  const found = [];
  for (const w of await readRegistry()) {
    try {
      await access(join(w.path, ".diff-review"));
      found.push(join(w.path, ".diff-review"));
    } catch {
      /* clean */
    }
  }
  if (!found.length) return ok("legacy comment dirs", "none");
  return warn(
    "pre-0.3 .diff-review directories present",
    found.join("\n"),
    "Reading that workspace's comments migrates and removes it automatically."
  );
}

const REMOVED_COMMANDS = /\blivediff\s+(add|open)\b/g;

async function checkSkill() {
  const dir = join(homedir(), ".claude", "skills", "open-worktree-diff");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return ok("claude skill", "not installed to ~/.claude/skills");
  }
  const stale = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(join(dir, file), "utf8");
    const hits = [...text.matchAll(REMOVED_COMMANDS)].map((m) => m[0]);
    if (hits.length) stale.push(`${join(dir, file)} — references ${[...new Set(hits)].join(", ")}`);
  }
  if (!stale.length) return ok("claude skill", `installed at ${dir}`);
  return bad(
    "installed Claude skill uses removed commands",
    stale.join("\n"),
    "Re-run ./install.sh to refresh it. If it came from the plugin system, run `/plugin update livediff`."
  );
}

/** Every check, in report order. Never throws — a failed check becomes a finding. */
export async function diagnose(version) {
  const checks = [
    checkPath(),
    checkHub(version),
    checkLock(),
    checkRegistry(),
    checkLegacyDirs(),
    checkSkill(),
  ];
  const settled = await Promise.allSettled(checks);
  return settled.map((r) =>
    r.status === "fulfilled" ? r.value : bad("check failed", String(r.reason?.message || r.reason))
  );
}
