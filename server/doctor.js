import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configDir, readRegistry, idFor } from "./registry.js";
import { listComments } from "./comments.js";
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

  const roots = await Promise.all(
    workspaces.map(async (w) => {
      try {
        await access(w.path);
      } catch {
        return undefined; // distinct from null: the path itself is gone
      }
      return toplevel(w.path);
    })
  );

  const problems = [];
  const seen = new Map();
  for (const [index, w] of workspaces.entries()) {
    const root = roots[index];
    if (root === undefined) {
      problems.push(`${w.id}  ${w.path} — path no longer exists`);
      continue;
    }
    if (root && root !== w.path) problems.push(`${w.id}  ${w.path} — not a worktree root (${root})`);
    const key = root ?? w.path;
    if (seen.has(key)) problems.push(`${w.id}  duplicates ${seen.get(key)} (same worktree)`);
    else seen.set(key, w.id);
    if (root && idFor(root) !== w.id) problems.push(`${w.id}  id does not match its path`);
  }

  if (!problems.length) {
    const noun = workspaces.length === 1 ? "workspace" : "workspaces";
    return ok("registry", `${workspaces.length} ${noun}, all normalized`);
  }
  return warn(
    "registry needs migration",
    problems.join("\n"),
    "Restart the hub (`livediff stop`, then any command) — it migrates on startup."
  );
}

async function checkLegacyDirs() {
  const workspaces = await readRegistry();
  const dirs = await Promise.all(
    workspaces.map(async (w) => {
      const dir = join(w.path, ".diff-review");
      try {
        await access(dir);
        return dir;
      } catch {
        return null;
      }
    })
  );
  const found = dirs.filter(Boolean);
  if (!found.length) return ok("legacy comment dirs", "none");
  return warn(
    "pre-0.3 .diff-review directories present",
    found.join("\n"),
    "Reading that workspace's comments migrates and removes it automatically."
  );
}

/** Numeric per-segment comparison: "0.10.0" is newer than "0.4.0", which string order gets wrong. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Highest livediff version present in the plugin cache, or null when it is not installed. */
async function installedPluginVersion() {
  const cache = join(homedir(), ".claude", "plugins", "cache");
  let marketplaces = [];
  try {
    marketplaces = await readdir(cache);
  } catch {
    return null;
  }
  const found = [];
  for (const marketplace of marketplaces) {
    const dir = join(cache, marketplace, "livediff");
    let versions = [];
    try {
      versions = await readdir(dir);
    } catch {
      continue;
    }
    for (const version of versions) {
      try {
        const raw = await readFile(join(dir, version, ".claude-plugin", "plugin.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.version) found.push(parsed.version);
      } catch {
        /* not a plugin directory */
      }
    }
  }
  return found.sort(compareVersions).pop() ?? null;
}

/**
 * Pre-0.5 installers copied the skill into ~/.claude/skills. The plugin now owns it, so that
 * copy is a second, stale answer to the same question — it never updates and its instructions
 * compete with the plugin's for the model's attention.
 */
async function checkPlugin(version) {
  const legacy = join(homedir(), ".claude", "skills", "open-worktree-diff");
  try {
    await access(legacy);
    return bad(
      "legacy skill directory left by a pre-0.5 install",
      `${legacy} is a stale copy of the skill; the plugin supplies it now.`,
      `rm -rf ${legacy}`
    );
  } catch {
    /* nothing to clean up */
  }

  const installed = await installedPluginVersion();
  if (!installed) return ok("claude plugin", "not installed (the CLI works without it)");
  if (installed !== version) {
    return warn(
      "plugin version differs from the CLI",
      `CLI ${version}, plugin ${installed}`,
      "Run `/plugin update livediff` in Claude Code."
    );
  }
  return ok("claude plugin", `v${installed}`);
}

const WARN_BYTES = 5 * 1024 * 1024;

/**
 * Archive growth is the one thing doctor would otherwise only describe. Every other finding
 * carries a fix, so this one does too.
 */
async function checkArchive() {
  const workspaces = await readRegistry();
  let bytes = 0;
  let archived = 0;
  let oldest = null;

  for (const w of workspaces) {
    try {
      bytes += (await stat(join(configDir(), "comments", `${w.id}.json`))).size;
    } catch {
      continue; // no store for this workspace yet
    }
    for (const c of await listComments(w.id, null, { branch: "all" })) {
      if (!c.archivedAt) continue;
      archived++;
      if (!oldest || c.archivedAt < oldest) oldest = c.archivedAt;
    }
  }

  const size = `${(bytes / 1024).toFixed(1)} KB`;
  if (!archived) return ok("comment archive", `${size}, nothing archived`);

  const days = Math.floor((Date.now() - Date.parse(oldest)) / 86_400_000);
  const noun = archived === 1 ? "archived comment" : "archived comments";
  const detail =
    `${workspaces.length} workspaces, ${archived} ${noun}, ${size}\n` +
    `oldest archived ${days} days ago`;
  const fix = "livediff prune --dry-run";
  return bytes > WARN_BYTES
    ? warn("comment archive is large", detail, fix)
    : { level: "ok", title: "comment archive", detail, fix };
}

/** Every check, in report order. Never throws — a failed check becomes a finding. */
export async function diagnose(version) {
  const checks = [
    checkPath(),
    checkHub(version),
    checkLock(),
    checkRegistry(),
    checkLegacyDirs(),
    checkArchive(),
    checkPlugin(version),
  ];
  const settled = await Promise.allSettled(checks);
  return settled.map((r) =>
    r.status === "fulfilled" ? r.value : bad("check failed", String(r.reason?.message || r.reason))
  );
}
