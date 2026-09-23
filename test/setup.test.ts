import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempXdg } from "./helpers.js";
import { fakeContext, fakeRunner, ok } from "./setup-fixtures.js";
import {
  SetupCancelled,
  type AdapterPlan,
  type AgentAdapter,
  type AgentAlias,
  type PersistentCli,
  type SetupRequest,
} from "../server/setup/types.js";
import type { PersistentCliResult } from "../server/setup/npm.js";

type Npm = typeof import("../server/setup/npm.js");
type Browser = typeof import("../server/setup/browser.js");

const mocks = vi.hoisted(() => ({
  ensurePersistentCli: vi.fn<Npm["ensurePersistentCli"]>(),
  handOffSetup: vi.fn<Npm["handOffSetup"]>(),
  adapterFor: vi.fn<(alias: AgentAlias) => AgentAdapter>(),
  configureBrowser: vi.fn<Browser["configureBrowser"]>(),
  repairOwnedOpener: vi.fn<Browser["repairOwnedOpener"]>(),
}));

vi.mock("../server/setup/npm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/setup/npm.js")>()),
  ensurePersistentCli: mocks.ensurePersistentCli,
  handOffSetup: mocks.handOffSetup,
}));
vi.mock("../server/setup/adapters/index.js", () => ({ adapterFor: mocks.adapterFor }));
vi.mock("../server/setup/browser.js", () => ({
  inspectSavedBrowser: async () => ({
    stored: null,
    kind: "none",
    stale: false,
    environmentOverride: null,
  }),
  configureBrowser: mocks.configureBrowser,
  repairOwnedOpener: mocks.repairOwnedOpener,
}));

const { runSetup, continuationArgs } = await import("../server/setup/index.js");
const { loadSetupState, saveSetupState, emptySetupState, SETUP_STATE_VERSION } =
  await import("../server/setup/state.js");

const PERSISTENT: PersistentCli = {
  packageName: "livediff",
  version: "2.0.0",
  bin: "/p/bin/livediff",
  packageRoot: "/p/lib/node_modules/livediff",
  node: "/p/bin/node",
};

function cliResult(overrides: Partial<PersistentCliResult> = {}): PersistentCliResult {
  return {
    outcome: {
      id: "cli",
      label: "LiveDiff CLI",
      status: "installed",
      version: "2.0.0",
      detail: PERSISTENT.bin,
    },
    persistent: PERSISTENT,
    handoff: false,
    changed: false,
    ...overrides,
  };
}

function req(overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    agents: [],
    cliOnly: false,
    browser: null,
    update: false,
    yes: true,
    json: false,
    interactive: false,
    ...overrides,
  };
}

function ctx() {
  const { run } = fakeRunner((command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "npm --version") return ok("11.0.0");
    if (key === "git --version") return ok("git version 2.50.0");
    if (command === "gh") return ok();
    return undefined;
  });
  return fakeContext({ run, env: { PATH: "/usr/bin" } });
}

function adapter(alias: AgentAlias, apply: AgentAdapter["apply"]): AgentAdapter {
  return {
    alias,
    label: alias,
    kind: "native-plugin",
    detect: async () => true,
    inspect: async () => ({ available: true, installed: null, conflict: null }),
    apply,
  };
}

const record = {
  adapter: "native-plugin" as const,
  source: "s",
  version: "1",
  paths: [],
  verifiedAt: "t",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repairOwnedOpener.mockResolvedValue(null);
  mocks.ensurePersistentCli.mockResolvedValue(cliResult());
});

test("an --update that installed a newer CLI hands the run over once and releases the lock after", async () => {
  await withTempXdg(async ({ config }) => {
    mocks.ensurePersistentCli.mockResolvedValue(cliResult({ handoff: true }));
    let lockDuringHandoff: string[] = [];
    mocks.handOffSetup.mockImplementation(async () => {
      lockDuringHandoff = await readdir(join(config, "livediff"));
      return 7;
    });
    mocks.adapterFor.mockImplementation((alias: AgentAlias) =>
      adapter(alias, async () => assert.fail("parent must not apply")),
    );

    const report = await runSetup(req({ update: true, agents: ["codex"] }), ctx());
    assert.equal(report.handedOff, true);
    assert.equal(report.exitCode, 7);
    assert.equal(mocks.handOffSetup.mock.calls.length, 1);
    const [, persistent, args, token] = mocks.handOffSetup.mock.calls[0] ?? [];
    assert.deepEqual(persistent, PERSISTENT);
    assert.deepEqual(args, ["--update", "--agent", "codex", "--yes"]);
    assert.equal(typeof token, "string");
    assert.ok(lockDuringHandoff.includes("setup.lock"));
    assert.ok(!(await readdir(join(config, "livediff"))).includes("setup.lock"));
    assert.equal(mocks.ensurePersistentCli.mock.calls[0]?.[1]?.continuation, false);
  });
});

test("continuation flags carry the choices made, and CLI-only when there are no agents", () => {
  assert.deepEqual(continuationArgs(req({ yes: false, json: true }), [], "cmux"), [
    "--update",
    "--cli-only",
    "--browser",
    "cmux",
    "--json",
  ]);
});

test("without a persistent CLI, agents and browser wait with a retry and nothing is applied", async () => {
  await withTempXdg(async () => {
    mocks.ensurePersistentCli.mockResolvedValue(
      cliResult({
        persistent: null,
        outcome: {
          id: "cli",
          label: "LiveDiff CLI",
          status: "failed",
          required: true,
          retry: "npx livediff@latest setup",
        },
      }),
    );
    mocks.adapterFor.mockImplementation((alias: AgentAlias) =>
      adapter(alias, async () => assert.fail("must not apply")),
    );
    const report = await runSetup(req({ agents: ["codex", "gemini"], browser: "system" }), ctx());
    assert.equal(report.exitCode, 1);
    assert.equal(report.firstUse, null);
    const waiting = report.outcomes.filter((o) => o.detail === "needs the persistent CLI");
    assert.deepEqual(
      waiting.map((o) => o.id),
      ["agent:codex", "agent:gemini", "browser"],
    );
    assert.ok(waiting.every((o) => o.status === "skipped" && o.retry !== undefined));
    assert.equal(mocks.configureBrowser.mock.calls.length, 0);
  });
});

test("each component is recorded on its own; failures keep prior records and exit 1", async () => {
  await withTempXdg(async () => {
    const prior = emptySetupState();
    prior.agents.gemini = { ...record, version: "0.9" };
    await saveSetupState(prior);
    mocks.adapterFor.mockImplementation((alias: AgentAlias) => {
      if (alias === "codex") {
        return adapter(alias, async () => ({
          outcome: { id: "agent:codex", label: "Codex", status: "installed", version: "1" },
          record,
        }));
      }
      if (alias === "gemini") {
        return adapter(alias, async () => ({
          outcome: {
            id: "agent:gemini",
            label: "Gemini",
            status: "failed",
            retry: "livediff setup --agent gemini",
          },
          record: null,
        }));
      }
      return adapter(alias, async () => {
        throw new Error("boom");
      });
    });
    const report = await runSetup(req({ agents: ["codex", "gemini", "cursor"] }), ctx());
    assert.equal(report.outcome, "partial");
    assert.equal(report.exitCode, 1);
    assert.equal(report.outcomes.find((o) => o.id === "agent:cursor")?.detail, "boom");
    const saved = (await loadSetupState()).state;
    assert.deepEqual(saved.agents.codex, record);
    assert.equal(saved.agents.gemini?.version, "0.9");
    assert.equal(saved.cli?.version, "2.0.0");
    assert.equal(saved.lastRun?.outcome, "partial");
    assert.match(saved.lastRun?.retry ?? "", /--agent gemini/);
  });
});

test("the plan is snapshotted before the agent loop, so one agent's shared-skill update does not leak into a sibling's plan in the same run", async () => {
  await withTempXdg(async () => {
    const plans: AdapterPlan[] = [];
    mocks.adapterFor.mockImplementation((alias: AgentAlias) =>
      adapter(alias, async (_ctx, _action, plan) => {
        plans.push(plan);
        if (alias === "cursor") {
          return {
            outcome: { id: "agent:cursor", label: "cursor", status: "installed", version: "1" },
            record,
            sharedSkill: { path: "/skills/livediff", agents: ["cursor", "opencode"] },
          };
        }
        return {
          outcome: { id: "agent:opencode", label: "opencode", status: "installed", version: "1" },
          record,
        };
      }),
    );

    const report = await runSetup(req({ agents: ["cursor", "opencode"] }), ctx());

    assert.equal(report.exitCode, 0);
    assert.equal(plans.length, 2);
    assert.equal(plans[0]?.sharedSkill, null);
    assert.equal(plans[1]?.sharedSkill, null);
  });
});

test("an explicitly requested agent that is unavailable fails the run", async () => {
  await withTempXdg(async () => {
    mocks.adapterFor.mockImplementation((alias: AgentAlias) =>
      adapter(alias, async () => ({
        outcome: {
          id: `agent:${alias}`,
          label: alias,
          status: "unavailable",
          detail: "not installed",
        },
        record: null,
      })),
    );
    const report = await runSetup(req({ agents: ["opencode"] }), ctx());
    assert.equal(report.exitCode, 1);
    assert.equal(report.outcomes.find((o) => o.id === "agent:opencode")?.status, "unavailable");
  });
});

test("the browser line is always reported, even when the preference is preserved", async () => {
  await withTempXdg(async () => {
    const report = await runSetup(req({ cliOnly: true }), ctx());
    assert.equal(report.exitCode, 0);
    assert.deepEqual(
      report.outcomes.find((o) => o.id === "browser"),
      {
        id: "browser",
        label: "Browser",
        status: "unchanged",
        detail: "system browser",
      },
    );
    assert.match(report.firstUse ?? "", /livediff/);
  });
});

test("cancelling a prompt keeps completed work and never reports success", async () => {
  await withTempXdg(async () => {
    mocks.adapterFor.mockImplementation((alias: AgentAlias) =>
      adapter(alias, async () => {
        throw new SetupCancelled();
      }),
    );
    const report = await runSetup(req({ agents: ["codex"] }), ctx());
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.exitCode, 1);
    const saved = (await loadSetupState()).state;
    assert.equal(saved.lastRun?.outcome, "cancelled");
    assert.equal(saved.cli?.version, "2.0.0");
  });
});

test("a setup record from a newer livediff stops the run before any change", async () => {
  await withTempXdg(async ({ config }) => {
    const path = join(config, "livediff", "setup.json");
    await mkdir(join(config, "livediff"), { recursive: true });
    const newer = JSON.stringify({ version: SETUP_STATE_VERSION + 1 });
    await writeFile(path, newer);
    const report = await runSetup(req({ cliOnly: true }), ctx());
    assert.equal(report.exitCode, 1);
    assert.equal(mocks.ensurePersistentCli.mock.calls.length, 0);
    assert.equal(await readFile(path, "utf8"), newer);
  });
});
