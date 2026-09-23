import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptySetupState,
  loadSetupState,
  parseSetupState,
  saveSetupState,
  saveSetupStateSync,
  SETUP_STATE_VERSION,
  type SetupState,
} from "../server/setup/state.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "livediff-setup-state-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sampleState(): SetupState {
  return {
    version: SETUP_STATE_VERSION,
    cli: {
      packageName: "@scope/livediff",
      version: "1.2.3",
      bin: "/opt/node/bin/livediff",
      verifiedAt: "2026-09-23T00:00:00.000Z",
    },
    agents: {
      codex: {
        adapter: "native-plugin",
        source: "github:ssteuteville/livediff@stable",
        version: "1.2.3",
        paths: ["/home/u/.codex/plugins/livediff"],
        verifiedAt: "2026-09-23T00:00:00.000Z",
      },
      gemini: {
        adapter: "portable-skill",
        source: "github:ssteuteville/livediff@stable",
        version: null,
        paths: [],
        verifiedAt: "2026-09-23T00:00:00.000Z",
      },
    },
    sharedSkill: { path: "/home/u/.agents/skills/livediff", agents: ["gemini"] },
    ownedOpener: ["/opt/node/bin/node", "/opt/node/lib/node_modules/livediff/cmux-open.js"],
    lastRun: { at: "2026-09-23T00:00:00.000Z", outcome: "partial", retry: "livediff setup" },
  };
}

test("a saved record loads back identically", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.json");
    await saveSetupState(sampleState(), path);
    const loaded = await loadSetupState(path);
    assert.equal(loaded.kind, "loaded");
    assert.deepEqual(loaded.state, sampleState());

    saveSetupStateSync({ ...sampleState(), ownedOpener: null }, path);
    assert.equal((await loadSetupState(path)).state.ownedOpener, null);
  });
});

test("saving replaces the record atomically and leaves no temporary files", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "nested", "setup.json");
    await saveSetupState(emptySetupState(), path);
    await saveSetupState(sampleState(), path);
    saveSetupStateSync(sampleState(), path);
    assert.deepEqual(await readdir(join(dir, "nested")), ["setup.json"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), sampleState());
  });
});

test("a missing record is empty; an unreadable one degrades to live inspection and says why", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.json");
    const missing = await loadSetupState(path);
    assert.equal(missing.kind, "missing");
    assert.deepEqual(missing.state, emptySetupState());

    await writeFile(path, "{ not json");
    const garbled = await loadSetupState(path);
    assert.equal(garbled.kind, "unreadable");
    assert.deepEqual(garbled.state, emptySetupState());

    await writeFile(path, JSON.stringify({ version: 0, agents: {} }));
    const unknown = await loadSetupState(path);
    assert.equal(unknown.kind, "unreadable");
    if (unknown.kind === "unreadable") assert.match(unknown.reason, /unrecognized/);
  });
});

test("a record from a newer livediff is reported, not replaced with an empty one", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "setup.json");
    await writeFile(path, JSON.stringify({ version: SETUP_STATE_VERSION + 1, future: true }));
    const loaded = await loadSetupState(path);
    assert.equal(loaded.kind, "newer");
    if (loaded.kind === "newer") assert.equal(loaded.version, SETUP_STATE_VERSION + 1);
  });
});

test("parsing drops malformed entries instead of trusting them", () => {
  assert.equal(parseSetupState(null), null);
  assert.equal(parseSetupState([]), null);
  assert.equal(parseSetupState({ version: "1" }), null);

  const parsed = parseSetupState({
    version: SETUP_STATE_VERSION,
    cli: { packageName: "livediff", version: 3 },
    agents: {
      claude: { adapter: "native-plugin", source: "s", version: null, verifiedAt: "t" },
      codex: { adapter: "something-else", source: "s", version: null, verifiedAt: "t" },
      emacs: { adapter: "native-plugin", source: "s", version: null, verifiedAt: "t" },
      cursor: { adapter: "portable-skill", source: "s", version: 7, verifiedAt: "t" },
    },
    sharedSkill: { path: "/skills/livediff", agents: ["cursor", "vim"] },
    ownedOpener: ["node", 3],
    lastRun: { at: "t", outcome: "exploded", retry: null },
  });
  assert.ok(parsed);
  assert.equal(parsed.cli, null);
  assert.deepEqual(Object.keys(parsed.agents), ["claude"]);
  assert.deepEqual(parsed.agents.claude?.paths, []);
  assert.deepEqual(parsed.sharedSkill, { path: "/skills/livediff", agents: ["cursor"] });
  assert.equal(parsed.ownedOpener, null);
  assert.equal(parsed.lastRun, null);
});
