import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

/**
 * Fixture repos live in os.tmpdir(), never inside this repo: the generators delete their target
 * before writing, and an artifact landing in the tree under test would change the diff mid-run.
 */
const SHAPES = {
  modfiles: "modified-not-added",
  minified: "minified-single-line",
  lockfile: "lockfile",
} as const;

export default async function globalSetup() {
  const root = await mkdtemp(join(tmpdir(), "livediff-e2e-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  // The hub must never read or write the developer's real livediff state. XDG_* is set on this
  // process too, because addWorkspace below resolves the registry path from it. HOME is *not*:
  // Playwright resolves its browser cache from HOME, and redirecting it here makes every worker
  // fail to find Chromium. Only the hub child gets the temp HOME.
  process.env["XDG_CONFIG_HOME"] = join(root, "config");
  process.env["XDG_STATE_HOME"] = join(root, "state");

  const fixtures: Record<string, string> = { tracked20k: join(root, "tracked") };
  execFileSync(process.execPath, ["bench/tracked.mjs", fixtures["tracked20k"]!, "20000"], {
    cwd: repo,
    stdio: "ignore",
  });
  for (const [name, shape] of Object.entries(SHAPES)) {
    fixtures[name] = join(root, name);
    execFileSync(process.execPath, ["bench/gen.mjs", fixtures[name]!, shape], {
      cwd: repo,
      stdio: "ignore",
    });
  }

  execFileSync("pnpm", ["run", "build"], { cwd: repo, stdio: "ignore" });

  const { addWorkspace } = await import(join(repo, "dist-server/server/registry.js"));
  const ids: Record<string, string> = {};
  for (const [name, path] of Object.entries(fixtures)) {
    ids[name] = (await addWorkspace(path, name)).id;
  }

  const child = spawn(process.execPath, [join(repo, "dist-server/server/index.js")], {
    env: { ...process.env, HOME: home, LIVEDIFF_PORT: "4183" },
    stdio: "ignore",
  });

  // Match on pid: an already-running hub's state file would otherwise satisfy this instantly and
  // leak the child we just spawned.
  const statePath = join(process.env["XDG_STATE_HOME"]!, "livediff", "hub.json");
  const deadline = Date.now() + 20_000;
  let port = 0;
  while (Date.now() < deadline && !port) {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (parsed.pid === child.pid && parsed.port) port = parsed.port;
    } catch {
      /* not written yet */
    }
    if (!port) await new Promise((r) => setTimeout(r, 50));
  }
  if (!port) {
    child.kill("SIGKILL");
    throw new Error("hub did not start within 20s");
  }

  process.env["LIVEDIFF_E2E_URL"] = `http://127.0.0.1:${port}`;
  process.env["LIVEDIFF_E2E_IDS"] = JSON.stringify(ids);
  process.env["LIVEDIFF_E2E_PATHS"] = JSON.stringify(fixtures);

  return async () => {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  };
}
