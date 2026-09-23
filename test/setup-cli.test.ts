import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTempXdg } from "./helpers.js";

const CLI = fileURLToPath(new URL("../dist-server/server/cli.js", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function setup(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  return new Promise((resolveRun) => {
    const child = execFile(
      process.execPath,
      [CLI, "setup", ...args],
      { env },
      (error, stdout, stderr) =>
        resolveRun({ code: child.exitCode ?? (error ? 1 : 0), stdout, stderr }),
    );
    child.stdin?.end();
  });
}

async function listTree(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true })).map(String);
  } catch {
    return [];
  }
}

test("usage errors exit 2 before any lock, record, or check", async () => {
  await withTempXdg(async ({ config, state }) => {
    const unknown = await setup(["--agent", "nope"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown agent 'nope'/);

    const yes = await setup(["--yes"]);
    assert.equal(yes.code, 2);
    assert.match(yes.stderr, /--yes needs an explicit selection/);

    const piped = await setup([]);
    assert.equal(piped.code, 2);

    const json = await setup(["--json", "--browser", "firefox", "--cli-only"]);
    assert.equal(json.code, 2);
    const parsed: unknown = JSON.parse(json.stdout);
    assert.ok(typeof parsed === "object" && parsed !== null && "exitCode" in parsed);
    assert.equal(parsed.exitCode, 2);

    assert.deepEqual(await listTree(config), []);
    assert.deepEqual(await listTree(state), []);
  });
});

test("setup stops before mutations when Git is missing, and never starts a hub", async () => {
  await withTempXdg(async ({ config, state, root }) => {
    const emptyPath = join(root, "empty-bin");
    await mkdir(emptyPath);
    const result = await setup(["--cli-only", "--json"], { ...process.env, PATH: emptyPath });
    assert.equal(result.code, 1);
    const report: unknown = JSON.parse(result.stdout);
    assert.ok(
      typeof report === "object" &&
        report !== null &&
        "outcomes" in report &&
        Array.isArray(report.outcomes),
    );
    const ids = report.outcomes.map((o: unknown) =>
      typeof o === "object" && o !== null && "id" in o ? o.id : null,
    );
    assert.ok(ids.includes("prereq:git"));
    assert.ok(!ids.includes("cli"));
    assert.deepEqual(await listTree(join(config, "livediff")), ["setup.json"]);
    assert.deepEqual(await listTree(state), []);
  });
});
