import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findCmux, planCmuxOpen, runCmuxOpen } from "../server/cmux-open.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "..", "dist-server", "server", "cmux-open.js");

describe("planCmuxOpen", () => {
  it("prefers the selected workspace over a stale CMUX_WORKSPACE_ID", () => {
    const listing = JSON.stringify({
      workspaces: [
        { ref: "stale", selected: false },
        { ref: "fresh", selected: true },
      ],
    });
    const args = planCmuxOpen(listing, { CMUX_WORKSPACE_ID: "stale" }, "http://x/");
    expect(args).toEqual([
      "browser",
      "open",
      "--workspace",
      "fresh",
      "--focus",
      "true",
      "http://x/",
    ]);
  });

  it("falls back to the inherited CMUX_WORKSPACE_ID when nothing is selected", () => {
    const listing = JSON.stringify({ workspaces: [{ ref: "a", selected: false }] });
    const args = planCmuxOpen(listing, { CMUX_WORKSPACE_ID: "inherited" }, "http://x/");
    expect(args).toEqual([
      "browser",
      "open",
      "--workspace",
      "inherited",
      "--focus",
      "true",
      "http://x/",
    ]);
  });

  it("passes no --workspace flag when neither is available", () => {
    const args = planCmuxOpen(null, {}, "http://x/");
    expect(args).toEqual(["browser", "open", "--focus", "true", "http://x/"]);
  });

  it("ignores a malformed listing and falls back to the environment", () => {
    const args = planCmuxOpen("not json", { CMUX_WORKSPACE_ID: "env-id" }, "http://x/");
    expect(args).toEqual([
      "browser",
      "open",
      "--workspace",
      "env-id",
      "--focus",
      "true",
      "http://x/",
    ]);
  });

  it("ignores an empty/shape-mismatched listing", () => {
    expect(planCmuxOpen(JSON.stringify({}), {}, "http://x/")).toEqual([
      "browser",
      "open",
      "--focus",
      "true",
      "http://x/",
    ]);
    expect(planCmuxOpen(JSON.stringify({ workspaces: [] }), {}, "http://x/")).toEqual([
      "browser",
      "open",
      "--focus",
      "true",
      "http://x/",
    ]);
  });

  it("ignores a selected entry whose ref is not a string", () => {
    const listing = JSON.stringify({ workspaces: [{ ref: 42, selected: true }] });
    expect(planCmuxOpen(listing, {}, "http://x/")).toEqual([
      "browser",
      "open",
      "--focus",
      "true",
      "http://x/",
    ]);
  });

  it("always passes --focus true", () => {
    const args = planCmuxOpen(null, {}, "http://x/");
    expect(args).toContain("--focus");
    expect(args[args.indexOf("--focus") + 1]).toBe("true");
  });

  it("keeps a URL with spaces and special characters as one argv element", () => {
    const url = "http://localhost:4180/?q=a b&x=<y>";
    const args = planCmuxOpen(null, {}, url);
    expect(args.at(-1)).toBe(url);
    expect(args).toHaveLength(5);
  });
});

describe("findCmux", () => {
  it("finds cmux on PATH before checking app bundles", async () => {
    const exists = async (path: string) => path === "/usr/local/bin/cmux";
    const found = await findCmux({ PATH: "/usr/local/bin:/usr/bin" }, "darwin", exists);
    expect(found).toBe("/usr/local/bin/cmux");
  });

  it("falls back to the macOS app bundle when PATH has nothing", async () => {
    const exists = async (path: string) =>
      path === "/Applications/cmux.app/Contents/Resources/bin/cmux";
    const found = await findCmux({ PATH: "/usr/bin" }, "darwin", exists);
    expect(found).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");
  });

  it("checks the user's ~/Applications bundle too", async () => {
    const exists = async (path: string) =>
      path === "/home/x/Applications/cmux.app/Contents/Resources/bin/cmux";
    const found = await findCmux({ PATH: "", HOME: "/home/x" }, "darwin", exists);
    expect(found).toBe("/home/x/Applications/cmux.app/Contents/Resources/bin/cmux");
  });

  it("never checks app bundles on non-macOS platforms", async () => {
    const exists = async () => true;
    const found = await findCmux({ PATH: "" }, "linux", exists);
    expect(found).toBeNull();
  });

  it("returns null when nothing is found", async () => {
    const exists = async () => false;
    const found = await findCmux({ PATH: "/usr/bin" }, "darwin", exists);
    expect(found).toBeNull();
  });
});

describe("compiled cmux-open.js (real subprocess)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function withFakeCmux(
    script: string,
  ): Promise<{ bin: string; argvFile: string; dir: string }> {
    dir = await mkdtemp(join(tmpdir(), "livediff-cmux-open-test-"));
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const argvFile = join(dir, "argv.json");
    const cmuxPath = join(bin, "cmux");
    await writeFile(cmuxPath, script.replace("__ARGV_FILE__", argvFile));
    await chmod(cmuxPath, 0o755);
    return { bin, argvFile, dir };
  }

  it("records the resolved argv and focus flag when cmux succeeds", async () => {
    const { bin, argvFile } = await withFakeCmux(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "workspace") {
  process.stdout.write(JSON.stringify({ workspaces: [{ ref: "ws-1", selected: true }] }));
  process.exit(0);
}
fs.writeFileSync("__ARGV_FILE__", JSON.stringify(args));
process.exit(0);
`);
    const result = await execFileAsync("node", [HELPER, "http://example.test/diff"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        CMUX_WORKSPACE_ID: "stale-id",
      },
    });
    expect(result.stdout).toBe("");
    const recorded: string[] = JSON.parse(await readFile(argvFile, "utf8"));
    expect(recorded).toEqual([
      "browser",
      "open",
      "--workspace",
      "ws-1",
      "--focus",
      "true",
      "http://example.test/diff",
    ]);
  });

  it("exits 64 with a usage message when no URL is given", async () => {
    await expect(execFileAsync("node", [HELPER])).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("usage"),
    });
  });

  it("propagates cmux's own failure exit code", async () => {
    const { bin } = await withFakeCmux(`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "workspace") {
  process.stdout.write(JSON.stringify({ workspaces: [] }));
  process.exit(0);
}
process.stderr.write("cmux blew up\\n");
process.exit(3);
`);
    await expect(
      execFileAsync("node", [HELPER, "http://x/"], {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      }),
    ).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining("cmux blew up") });
  });
});

describe("runCmuxOpen (injected, no subprocess or real cmux needed)", () => {
  it("exits 64 with a usage message when no URL is given", async () => {
    const stderr: string[] = [];
    const code = await runCmuxOpen({
      argv: [],
      env: {},
      platform: "darwin",
      stderr: (message) => stderr.push(message),
    });
    expect(code).toBe(64);
    expect(stderr.join("")).toContain("usage");
  });

  it("exits 127 with a remediation message when cmux cannot be found", async () => {
    // Uses an injected `find` rather than the real filesystem/PATH: this must stay deterministic
    // regardless of whether the machine running the tests actually has cmux installed.
    const stderr: string[] = [];
    const code = await runCmuxOpen({
      argv: ["http://x/"],
      env: {},
      platform: "darwin",
      stderr: (message) => stderr.push(message),
      find: async () => null,
    });
    expect(code).toBe(127);
    expect(stderr.join("")).toContain("livediff setup --browser system");
  });

  it("finds cmux, lists workspaces, and runs with the planned argv", async () => {
    const recorded: { cmux: string; args: readonly string[] }[] = [];
    const code = await runCmuxOpen({
      argv: ["http://x/"],
      env: { CMUX_WORKSPACE_ID: "stale" },
      platform: "darwin",
      stderr: () => undefined,
      find: async () => "/fake/cmux",
      list: async () => JSON.stringify({ workspaces: [{ ref: "selected-ws", selected: true }] }),
      run: async (cmux, args) => {
        recorded.push({ cmux, args });
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(recorded).toEqual([
      {
        cmux: "/fake/cmux",
        args: ["browser", "open", "--workspace", "selected-ws", "--focus", "true", "http://x/"],
      },
    ]);
  });
});
