import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import { adapterFor } from "../server/setup/adapters/index.js";
import { checkCompatibility } from "../server/setup/adapters/common.js";
import { SKILLS_INSTALLER, skillVersion } from "../server/setup/adapters/skills.js";
import { runProcess } from "../server/setup/process.js";
import { integrationSource } from "../server/setup/source.js";
import type {
  AdapterAction,
  AdapterPlan,
  AdapterResult,
  AgentAlias,
  AgentRecord,
  Prompter,
  RunOptions,
  RunResult,
  Runner,
  SetupContext,
} from "../server/setup/types.js";

const CLI_VERSION = "0.12.0";
const CLAUDE_SOURCE = "https://github.com/ssteuteville/livediff.git#stable";
const NPX = ["npx", "-y", SKILLS_INSTALLER];

type Response = Partial<RunResult> | (() => Promise<Partial<RunResult>> | Partial<RunResult>);

/** Scripted harness CLIs. An unscripted command fails the test instead of reaching a real tool. */
class FakeHarness {
  readonly calls: string[] = [];
  readonly envs: (NodeJS.ProcessEnv | undefined)[] = [];
  private readonly responses = new Map<string, Response[]>();

  on(command: string, ...responses: Response[]): this {
    this.responses.set(command, responses);
    return this;
  }

  run: Runner = async (command: string, args: readonly string[], options?: RunOptions) => {
    const key = [command, ...args].join(" ");
    this.calls.push(key);
    this.envs.push(options?.env);
    const queue = this.responses.get(key);
    if (queue === undefined || queue.length === 0) throw new Error(`unscripted command: ${key}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const partial = typeof next === "function" ? await next() : (next ?? {});
    return { code: 0, stdout: "", stderr: "", ...partial };
  };

  called(prefix: string): string[] {
    return this.calls.filter((call) => call.startsWith(prefix));
  }
}

const json = (value: unknown): Partial<RunResult> => ({ stdout: `${JSON.stringify(value)}\n` });

interface Fixture {
  root: string;
  harness: FakeHarness;
  ctx: SetupContext;
  asked: string[];
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    bins?: string[];
    dirs?: string[];
    answers?: boolean[];
    env?: Record<string, string>;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "livediff-adapters-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const name of options.bins ?? []) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 99\n");
    await chmod(join(bin, name), 0o755);
  }
  for (const dir of options.dirs ?? []) await mkdir(join(root, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    PATH: bin,
    CODEX_HOME: join(root, ".codex"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    ...options.env,
  };
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const refuse = (): never => {
    throw new Error("unexpected prompt");
  };
  const prompts: Prompter = {
    confirm: async (message) => {
      asked.push(message);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected confirm: ${message}`);
      return answer;
    },
    select: refuse,
    multiselect: refuse,
  };
  const noop = (): void => {};
  const harness = new FakeHarness();
  const ctx: SetupContext = {
    run: harness.run,
    prompts,
    progress: { step: noop, ok: noop, warn: noop, fail: noop, info: noop },
    env,
    platform: "darwin",
    cliVersion: CLI_VERSION,
    source: integrationSource(env),
    persistent: null,
  };
  return { root, harness, ctx, asked };
}

/** Mirrors the coordinator: inspect before any mutation, then apply with that inspection. */
async function inspectAndApply(
  alias: AgentAlias,
  f: Fixture,
  action: AdapterAction,
  plan: Partial<Omit<AdapterPlan, "inspection">> = {},
): Promise<AdapterResult> {
  const adapter = adapterFor(alias);
  const inspection = await adapter.inspect(f.ctx);
  return adapter.apply(f.ctx, action, {
    selected: [alias],
    recorded: {},
    sharedSkill: null,
    interactive: false,
    ...plan,
    inspection,
  });
}

function priorRecord(kind: AgentRecord["adapter"], version: string | null): AgentRecord {
  return {
    adapter: kind,
    source: "github:earlier",
    version,
    paths: [],
    verifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------- Claude Code

const claudeMarketplace = (entry: Record<string, unknown> | null): Partial<RunResult> =>
  json(entry === null ? [] : [{ name: "livediff", installLocation: "/x", ...entry }]);
const publishedClaude = {
  source: "git",
  url: "https://github.com/ssteuteville/livediff.git",
  ref: "stable",
};
const claudePlugin = (
  version: string | undefined,
  root: string,
  scope: string = "user",
): Partial<RunResult> =>
  json([
    { id: "other@else", version: "9.9.9", scope: "user", enabled: true, installPath: "/other" },
    {
      id: "livediff@livediff",
      ...(version === undefined ? {} : { version }),
      scope,
      enabled: true,
      installPath: join(root, ".claude/plugins/cache/livediff/livediff", version ?? "unknown"),
    },
  ]);

describe("Claude Code plugin", () => {
  test("fresh install registers the stable marketplace, installs, and verifies the version", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(null))
      .on("claude plugin list --json", json([]), json([]), claudePlugin("0.12.0", f.root))
      .on(`claude plugin marketplace add ${CLAUDE_SOURCE}`, {})
      .on("claude plugin install livediff@livediff --json", json({ outcome: "ok" }));

    const result = await inspectAndApply("claude", f, "install");

    assert.equal(result.outcome.id, "agent:claude");
    assert.equal(result.outcome.label, "Claude Code plugin");
    assert.equal(result.outcome.status, "installed");
    assert.equal(result.outcome.version, "0.12.0");
    assert.equal(result.outcome.restartRequired, true);
    assert.equal(result.record?.adapter, "native-plugin");
    assert.equal(result.record?.version, "0.12.0");
    assert.equal(result.record?.source, f.ctx.source.id);
    assert.deepEqual(result.record?.paths, [
      join(f.root, ".claude/plugins/cache/livediff/livediff/0.12.0"),
    ]);
    assert.equal(f.harness.called("claude plugin marketplace add").length, 1);
    assert.equal(f.harness.called("claude plugin install").length, 1);
    assert.ok(
      f.harness.envs.every((env) => env === f.ctx.env),
      "every call runs with the setup env",
    );
  });

  test("a healthy rerun changes nothing", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(publishedClaude))
      .on("claude plugin list --json", claudePlugin("0.12.0", f.root));

    const result = await inspectAndApply("claude", f, "install", {
      recorded: { claude: priorRecord("native-plugin", "0.12.0") },
    });

    assert.equal(result.outcome.status, "unchanged");
    assert.equal(result.record?.version, "0.12.0");
    assert.deepEqual(f.harness.called("claude plugin marketplace add"), []);
    assert.deepEqual(f.harness.called("claude plugin install"), []);
  });

  test("an equivalent GitHub shorthand registration is reused rather than re-added", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on(
        "claude plugin marketplace list --json",
        claudeMarketplace({ source: "github", repo: "ssteuteville/livediff", ref: "stable" }),
      )
      .on("claude plugin list --json", json([]), json([]), claudePlugin("0.12.0", f.root))
      .on("claude plugin install livediff@livediff --json", json({ outcome: "ok" }));

    const result = await inspectAndApply("claude", f, "install");

    assert.equal(result.outcome.status, "installed");
    assert.deepEqual(f.harness.called("claude plugin marketplace add"), []);
  });

  test.each([
    { name: "no prior record", prior: undefined },
    { name: "a prior record", prior: priorRecord("native-plugin", "0.11.2") },
  ])(
    "a local-directory registration is a conflict when non-interactive ($name)",
    async ({ prior }) => {
      const f = await fixture({ bins: ["claude"] });
      f.harness
        .on(
          "claude plugin marketplace list --json",
          claudeMarketplace({ source: "directory", path: "/Users/dev/livediff" }),
        )
        .on("claude plugin list --json", claudePlugin("0.11.2", f.root));

      const inspection = await adapterFor("claude").inspect(f.ctx);
      assert.match(inspection.conflict ?? "", /\/Users\/dev\/livediff/);

      const result = await inspectAndApply("claude", f, "install", { recorded: { claude: prior } });

      assert.equal(result.outcome.status, "failed");
      assert.match(result.outcome.detail ?? "", /\/Users\/dev\/livediff/);
      assert.equal(result.outcome.retry, "livediff setup --agent claude");
      assert.equal(result.record, prior ?? null);
      assert.deepEqual(f.harness.called("claude plugin marketplace remove"), []);
      assert.deepEqual(f.harness.called("claude plugin marketplace add"), []);
    },
  );

  test("an interactive migration removes the local registration, then adds and installs", async () => {
    const f = await fixture({ bins: ["claude"], answers: [true] });
    f.harness
      .on(
        "claude plugin marketplace list --json",
        claudeMarketplace({ source: "directory", path: "/Users/dev/livediff" }),
      )
      .on(
        "claude plugin list --json",
        claudePlugin("0.11.2", f.root),
        claudePlugin("0.11.2", f.root),
        claudePlugin("0.12.0", f.root),
      )
      .on("claude plugin marketplace remove livediff", {})
      .on(`claude plugin marketplace add ${CLAUDE_SOURCE}`, {})
      .on("claude plugin install livediff@livediff --json", json({ outcome: "ok" }));

    const result = await inspectAndApply("claude", f, "install", { interactive: true });

    assert.equal(f.asked.length, 1);
    assert.match(f.asked[0] ?? "", /registered from the local directory \/Users\/dev\/livediff/);
    assert.match(f.asked[0] ?? "", /reinstalls the plugin/);
    const mutations = f.harness.calls.filter((call) => /remove|add|install /.test(call));
    assert.deepEqual(mutations, [
      "claude plugin marketplace remove livediff",
      `claude plugin marketplace add ${CLAUDE_SOURCE}`,
      "claude plugin install livediff@livediff --json",
    ]);
    assert.equal(result.outcome.status, "installed");
    assert.equal(result.outcome.version, "0.12.0");
  });

  test("a declined migration fails and changes nothing", async () => {
    const f = await fixture({ bins: ["claude"], answers: [false] });
    f.harness
      .on(
        "claude plugin marketplace list --json",
        claudeMarketplace({ source: "directory", path: "/Users/dev/livediff" }),
      )
      .on("claude plugin list --json", claudePlugin("0.11.2", f.root));

    const result = await inspectAndApply("claude", f, "install", { interactive: true });

    assert.equal(result.outcome.status, "failed");
    assert.deepEqual(f.harness.called("claude plugin marketplace remove"), []);
  });

  test("update refreshes the marketplace first and reports the verified version change", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(publishedClaude))
      .on(
        "claude plugin list --json",
        claudePlugin("0.12.0", f.root),
        claudePlugin("0.12.0", f.root),
        claudePlugin("0.12.1", f.root),
      )
      .on("claude plugin marketplace update livediff", {})
      .on(
        "claude plugin update livediff@livediff --json",
        json({
          outcome: "ok",
          updateOutcome: "updated",
          oldVersion: "0.12.0",
          newVersion: "0.12.1",
        }),
      );

    const result = await inspectAndApply("claude", f, "update");

    const order = f.harness.calls.filter((call) => call.includes("update"));
    assert.deepEqual(order, [
      "claude plugin marketplace update livediff",
      "claude plugin update livediff@livediff --json",
    ]);
    assert.equal(result.outcome.status, "updated");
    assert.equal(result.outcome.version, "0.12.1");
    assert.match(result.outcome.detail ?? "", /0\.12\.0 → 0\.12\.1/);
    assert.equal(result.outcome.restartRequired, true);
    assert.equal(result.record?.version, "0.12.1");
  });

  test("update reports unchanged when the verified version did not move, whatever the harness claims", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(publishedClaude))
      .on("claude plugin list --json", claudePlugin("0.12.0", f.root))
      .on("claude plugin marketplace update livediff", {})
      .on(
        "claude plugin update livediff@livediff --json",
        json({ outcome: "ok", updateOutcome: "updated", newVersion: "0.12.1" }),
      );

    const result = await inspectAndApply("claude", f, "update");

    assert.equal(result.outcome.status, "unchanged");
    assert.equal(result.outcome.version, "0.12.0");
  });

  test("an offline update fails, keeps the prior record, and says what is still installed", async () => {
    const f = await fixture({ bins: ["claude"] });
    const prior = priorRecord("native-plugin", "0.12.0");
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(publishedClaude))
      .on("claude plugin list --json", claudePlugin("0.12.0", f.root))
      .on("claude plugin marketplace update livediff", {
        code: 1,
        stderr:
          "fatal: unable to access 'https://github.com/ssteuteville/livediff.git/': Could not resolve host\n",
      });

    const result = await inspectAndApply("claude", f, "update", { recorded: { claude: prior } });

    assert.equal(result.outcome.status, "failed");
    assert.equal(result.outcome.version, "0.12.0");
    assert.match(result.outcome.detail ?? "", /still installed/);
    assert.match(result.outcome.detail ?? "", /Could not resolve host/);
    assert.equal(result.outcome.retry, "livediff setup --update --agent claude");
    assert.equal(result.record, prior);
    assert.deepEqual(f.harness.called("claude plugin update"), []);
  });

  test("an unreadable installed version is recorded as null and reported honestly", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(null))
      .on("claude plugin list --json", json([]), json([]), claudePlugin(undefined, f.root))
      .on(`claude plugin marketplace add ${CLAUDE_SOURCE}`, {})
      .on("claude plugin install livediff@livediff --json", json({ outcome: "ok" }));

    const result = await inspectAndApply("claude", f, "install");

    assert.equal(result.outcome.status, "installed");
    assert.equal(result.outcome.version, undefined);
    assert.match(result.outcome.detail ?? "", /version could not be read/);
    assert.equal(result.record?.version, null);
  });

  test("a project-scoped plugin does not count as installed at user scope", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(publishedClaude))
      .on(
        "claude plugin list --json",
        claudePlugin("0.12.0", f.root, "project"),
        claudePlugin("0.12.0", f.root, "project"),
        claudePlugin("0.12.0", f.root, "user"),
      )
      .on("claude plugin install livediff@livediff --json", json({ outcome: "ok" }));

    const result = await inspectAndApply("claude", f, "install");

    assert.equal(result.outcome.status, "installed");
    assert.equal(f.harness.called("claude plugin install").length, 1);
  });

  test("a plugin incompatible with the running CLI is installed with a remediation warning", async () => {
    const f = await fixture({ bins: ["claude"] });
    f.harness
      .on("claude plugin marketplace list --json", claudeMarketplace(publishedClaude))
      .on("claude plugin list --json", claudePlugin("0.13.0", f.root));

    const result = await inspectAndApply("claude", f, "install");

    assert.equal(result.outcome.status, "unchanged");
    assert.match(result.outcome.detail ?? "", /npm install -g livediff@latest/);
  });
});

// ---------------------------------------------------------------- Codex

const codexMarketplaces = (
  entry: { sourceType: string; source: string } | null,
): Partial<RunResult> =>
  json({
    marketplaces:
      entry === null ? [] : [{ name: "livediff", root: "/x", marketplaceSource: entry }],
  });
const codexPlugins = (version: string | null): Partial<RunResult> =>
  json({
    installed:
      version === null
        ? []
        : [
            {
              pluginId: "livediff@livediff",
              version,
              installed: true,
              enabled: true,
              source: "x",
              marketplaceSource: "x",
            },
          ],
    available: [],
  });

async function writeCodexConfig(root: string, table: string): Promise<void> {
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(
    join(root, ".codex", "config.toml"),
    `model = "gpt-5"\n\n[marketplaces.other]\nsource = "elsewhere"\n\n${table}\n[plugins."livediff@livediff"]\nenabled = true\n`,
  );
}

const publishedCodexTable = `[marketplaces.livediff]
source_type = "git"
source = "https://github.com/ssteuteville/livediff.git"
ref = "stable" # promoted after npm publication
last_updated = "2026-09-23T00:00:00Z"
`;

describe("Codex plugin", () => {
  test("fresh install adds the marketplace at the stable ref, adds the plugin, and verifies", async () => {
    const f = await fixture({ bins: ["codex"] });
    f.harness
      .on("codex plugin marketplace list --json", codexMarketplaces(null))
      .on(
        "codex plugin list --json",
        codexPlugins(null),
        codexPlugins(null),
        codexPlugins("0.12.0"),
      )
      .on(
        "codex plugin marketplace add ssteuteville/livediff --ref stable --json",
        json({ marketplaceName: "livediff", installedRoot: "/x", alreadyAdded: false }),
      )
      .on(
        "codex plugin add livediff@livediff --json",
        json({ pluginId: "livediff@livediff", version: "0.12.0", installedPath: "/p" }),
      );

    const result = await inspectAndApply("codex", f, "install");

    assert.equal(result.outcome.id, "agent:codex");
    assert.equal(result.outcome.label, "Codex plugin");
    assert.equal(result.outcome.status, "installed");
    assert.equal(result.outcome.version, "0.12.0");
    assert.equal(result.outcome.restartRequired, true);
    assert.deepEqual(result.record?.paths, [
      join(f.root, ".codex/plugins/cache/livediff/livediff/0.12.0"),
    ]);
  });

  test("a healthy rerun reads the ref from config.toml and changes nothing", async () => {
    const f = await fixture({ bins: ["codex"] });
    await writeCodexConfig(f.root, publishedCodexTable);
    f.harness
      .on(
        "codex plugin marketplace list --json",
        codexMarketplaces({
          sourceType: "git",
          source: "https://github.com/ssteuteville/livediff.git",
        }),
      )
      .on("codex plugin list --json", codexPlugins("0.12.0"));

    const result = await inspectAndApply("codex", f, "install");

    assert.equal(result.outcome.status, "unchanged");
    assert.deepEqual(f.harness.called("codex plugin marketplace add"), []);
    assert.deepEqual(f.harness.called("codex plugin add"), []);
  });

  test.each([
    {
      name: "a local checkout",
      table: `[marketplaces.livediff]\nsource_type = "local"\nsource = "/Users/dev/livediff"\n`,
      expect: /\/Users\/dev\/livediff/,
    },
    {
      name: "another ref",
      table: `[marketplaces.livediff]\nsource_type = "git"\nsource = "https://github.com/ssteuteville/livediff.git"\nref = 'main'\n`,
      expect: /#main/,
    },
  ])("a registration from $name is a conflict when non-interactive", async ({ table, expect }) => {
    const f = await fixture({ bins: ["codex"] });
    await writeCodexConfig(f.root, table);
    const prior = priorRecord("native-plugin", "0.11.2");
    f.harness
      .on(
        "codex plugin marketplace list --json",
        codexMarketplaces({ sourceType: "local", source: "/Users/dev/livediff" }),
      )
      .on("codex plugin list --json", codexPlugins("0.11.2"));

    const result = await inspectAndApply("codex", f, "install", { recorded: { codex: prior } });

    assert.equal(result.outcome.status, "failed");
    assert.match(result.outcome.detail ?? "", expect);
    assert.equal(result.outcome.retry, "livediff setup --agent codex");
    assert.equal(result.record, prior);
    assert.deepEqual(f.harness.called("codex plugin marketplace remove"), []);
    assert.deepEqual(f.harness.called("codex plugin marketplace add"), []);
  });

  test("an interactive migration removes, re-adds, reinstalls, and verifies", async () => {
    const f = await fixture({ bins: ["codex"], answers: [true] });
    await writeCodexConfig(
      f.root,
      `[marketplaces.livediff]\nsource_type = "local"\nsource = "/Users/dev/livediff"\n`,
    );
    f.harness
      .on(
        "codex plugin marketplace list --json",
        codexMarketplaces({ sourceType: "local", source: "/Users/dev/livediff" }),
      )
      .on(
        "codex plugin list --json",
        codexPlugins("0.11.2"),
        codexPlugins("0.11.2"),
        codexPlugins("0.12.0"),
      )
      .on("codex plugin marketplace remove livediff", {})
      .on(
        "codex plugin marketplace add ssteuteville/livediff --ref stable --json",
        json({ alreadyAdded: false }),
      )
      .on(
        "codex plugin add livediff@livediff --json",
        json({ pluginId: "livediff@livediff", version: "0.12.0" }),
      );

    const result = await inspectAndApply("codex", f, "install", { interactive: true });

    assert.match(f.asked[0] ?? "", /\/Users\/dev\/livediff/);
    const mutations = f.harness.calls.filter((call) => /remove|add/.test(call));
    assert.deepEqual(mutations, [
      "codex plugin marketplace remove livediff",
      "codex plugin marketplace add ssteuteville/livediff --ref stable --json",
      "codex plugin add livediff@livediff --json",
    ]);
    assert.equal(result.outcome.status, "installed");
    assert.equal(result.outcome.version, "0.12.0");
  });

  test.each([
    { name: "a new version", upgraded: ["/x"], after: "0.12.1", status: "updated" },
    { name: "nothing new", upgraded: [], after: "0.12.0", status: "unchanged" },
    {
      name: "refreshed files at the same version",
      upgraded: ["/x"],
      after: "0.12.0",
      status: "unchanged",
    },
  ])(
    "upgrade with $name is verified against the installed version",
    async ({ upgraded, after, status }) => {
      const f = await fixture({ bins: ["codex"] });
      await writeCodexConfig(f.root, publishedCodexTable);
      f.harness
        .on(
          "codex plugin marketplace list --json",
          codexMarketplaces({
            sourceType: "git",
            source: "https://github.com/ssteuteville/livediff.git",
          }),
        )
        .on(
          "codex plugin list --json",
          codexPlugins("0.12.0"),
          codexPlugins("0.12.0"),
          codexPlugins(after),
        )
        .on("codex plugin marketplace upgrade livediff --json", json({ upgradedRoots: upgraded }));

      const result = await inspectAndApply("codex", f, "update");

      assert.equal(result.outcome.status, status);
      assert.equal(result.outcome.version, after);
      assert.equal(result.record?.version, after);
    },
  );

  test("an offline upgrade fails with plain-text output and keeps the installed version", async () => {
    const f = await fixture({ bins: ["codex"] });
    await writeCodexConfig(f.root, publishedCodexTable);
    const prior = priorRecord("native-plugin", "0.12.0");
    f.harness
      .on(
        "codex plugin marketplace list --json",
        codexMarketplaces({
          sourceType: "git",
          source: "https://github.com/ssteuteville/livediff.git",
        }),
      )
      .on("codex plugin list --json", codexPlugins("0.12.0"))
      .on("codex plugin marketplace upgrade livediff --json", {
        code: 1,
        stderr: "Failed to upgrade marketplace livediff: network unreachable\n",
      });

    const result = await inspectAndApply("codex", f, "update", { recorded: { codex: prior } });

    assert.equal(result.outcome.status, "failed");
    assert.equal(result.outcome.version, "0.12.0");
    assert.match(result.outcome.detail ?? "", /0\.12\.0 is still installed/);
    assert.equal(result.outcome.retry, "livediff setup --update --agent codex");
    assert.equal(result.record, prior);
  });
});

describe("missing harnesses", () => {
  test.each<[AgentAlias, RegExp]>([
    ["claude", /Claude Code/],
    ["codex", /Codex/],
    ["gemini", /Gemini CLI/],
  ])("%s is unavailable without running anything", async (alias, hint) => {
    const f = await fixture();
    const inspection = await adapterFor(alias).inspect(f.ctx);
    assert.equal(inspection.available, false);
    assert.equal(await adapterFor(alias).detect(f.ctx), false);

    const result = await inspectAndApply(alias, f, "install");

    assert.equal(result.outcome.status, "unavailable");
    assert.match(result.outcome.detail ?? "", hint);
    assert.equal(result.record, null);
    assert.deepEqual(f.harness.calls, []);
  });
});

// ---------------------------------------------------------------- Portable skill

const SKILLS_SOURCE = "ssteuteville/livediff#stable";

async function writeSkill(
  root: string,
  version: string | null,
  lock: { ref: string } | null,
  lockDir?: string,
): Promise<void> {
  const dir = join(root, ".agents/skills/livediff");
  await mkdir(dir, { recursive: true });
  const metadata = version === null ? "" : `metadata:\n  version: "${version}"\n`;
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: livediff\ndescription: Review with LiveDiff.\n${metadata}---\n\n# LiveDiff\n`,
  );
  if (lock === null) return;
  const lockPath =
    lockDir === undefined
      ? join(root, ".agents/.skill-lock.json")
      : join(lockDir, "skills/.skill-lock.json");
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 3,
      skills: {
        review: { source: "someone/else", sourceType: "github", ref: "main" },
        livediff: {
          source: "ssteuteville/livediff",
          sourceType: "github",
          sourceUrl: "https://github.com/ssteuteville/livediff.git",
          ref: lock.ref,
          skillPath: "skills/livediff/SKILL.md",
        },
      },
      dismissed: {},
    }),
  );
}

const installerAdd = (ids: string[], source = SKILLS_SOURCE): string =>
  [...NPX, "add", source, "--skill", "livediff", "-g", "-a", ...ids, "-y", "--json"].join(" ");
const installerUpdate = [...NPX, "update", "livediff", "-g", "-y"].join(" ");

async function applyInOrder(
  f: Fixture,
  action: AdapterAction,
  selected: AgentAlias[],
  plan: Partial<Omit<AdapterPlan, "inspection" | "selected">> = {},
): Promise<Map<AgentAlias, AdapterResult>> {
  const inspections = new Map<
    AgentAlias,
    Awaited<ReturnType<ReturnType<typeof adapterFor>["inspect"]>>
  >();
  for (const alias of selected) inspections.set(alias, await adapterFor(alias).inspect(f.ctx));
  const recorded: Record<string, AgentRecord | undefined> = { ...plan.recorded };
  let sharedSkill = plan.sharedSkill ?? null;
  const results = new Map<AgentAlias, AdapterResult>();
  for (const alias of selected) {
    const inspection = inspections.get(alias);
    assert.ok(inspection);
    const result = await adapterFor(alias).apply(f.ctx, action, {
      selected,
      recorded: { ...recorded },
      sharedSkill,
      interactive: plan.interactive ?? false,
      inspection,
    });
    results.set(alias, result);
    recorded[alias] = result.record ?? undefined;
    if (result.sharedSkill !== undefined) sharedSkill = result.sharedSkill;
  }
  return results;
}

describe("portable skill", () => {
  test("one installer run serves every selected portable agent", async () => {
    const f = await fixture({ dirs: [".cursor", ".gemini"] });
    f.harness.on(installerAdd(["cursor", "gemini-cli"]), async () => {
      await writeSkill(f.root, "0.12.0", { ref: "stable" });
      return { stdout: 'progress…\n[\n  {"name": "livediff", "status": "installed"}\n]\n' };
    });

    const results = await applyInOrder(f, "install", ["cursor", "gemini"]);

    assert.equal(f.harness.calls.length, 1);
    const cursor = results.get("cursor");
    const gemini = results.get("gemini");
    assert.equal(cursor?.outcome.label, "Cursor skill");
    assert.equal(cursor?.outcome.status, "installed");
    assert.equal(cursor?.outcome.version, "0.12.0");
    assert.equal(cursor?.outcome.restartRequired, true);
    assert.equal(gemini?.outcome.label, "Gemini CLI skill");
    assert.equal(gemini?.outcome.status, "installed");
    const skillDir = join(f.root, ".agents/skills/livediff");
    assert.deepEqual(cursor?.sharedSkill, { path: skillDir, agents: ["cursor", "gemini"] });
    assert.equal(cursor?.record?.adapter, "portable-skill");
    assert.deepEqual(cursor?.record?.paths, [skillDir]);
    assert.equal(gemini?.record?.version, "0.12.0");
  });

  test("copilot uses the installer's github-copilot id", async () => {
    const f = await fixture({ bins: ["copilot"] });
    f.harness.on(installerAdd(["github-copilot"]), async () => {
      await writeSkill(f.root, "0.12.0", { ref: "stable" });
      return {};
    });

    const result = await inspectAndApply("copilot", f, "install");

    assert.equal(result.outcome.label, "GitHub Copilot skill");
    assert.equal(result.outcome.status, "installed");
  });

  test("a healthy rerun changes nothing", async () => {
    const f = await fixture({ dirs: [".cursor"] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });
    const skillDir = join(f.root, ".agents/skills/livediff");

    const result = await inspectAndApply("cursor", f, "install", {
      recorded: { cursor: priorRecord("portable-skill", "0.12.0") },
      sharedSkill: { path: skillDir, agents: ["cursor"] },
    });

    assert.equal(result.outcome.status, "unchanged");
    assert.deepEqual(f.harness.calls, []);
  });

  test("adding an agent to an existing shared skill records it without reinstalling", async () => {
    const f = await fixture({ dirs: [".cursor", ".config/opencode"] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });
    const skillDir = join(f.root, ".agents/skills/livediff");

    const result = await inspectAndApply("opencode", f, "install", {
      recorded: { cursor: priorRecord("portable-skill", "0.12.0") },
      sharedSkill: { path: skillDir, agents: ["cursor"] },
    });

    assert.equal(result.outcome.status, "installed");
    assert.deepEqual(result.sharedSkill, { path: skillDir, agents: ["cursor", "opencode"] });
    assert.deepEqual(f.harness.calls, []);
  });

  test("an update that would change unselected agents fails non-interactively and names them all", async () => {
    const f = await fixture({ dirs: [".cursor", ".gemini", ".config/opencode"] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });
    const prior = priorRecord("portable-skill", "0.12.0");

    const result = await inspectAndApply("cursor", f, "update", {
      recorded: { cursor: prior },
      sharedSkill: {
        path: join(f.root, ".agents/skills/livediff"),
        agents: ["cursor", "gemini", "opencode"],
      },
    });

    assert.equal(result.outcome.status, "failed");
    assert.match(result.outcome.detail ?? "", /Gemini CLI, OpenCode/);
    assert.equal(
      result.outcome.retry,
      "livediff setup --update --agent cursor --agent gemini --agent opencode",
    );
    assert.equal(result.record, prior);
    assert.deepEqual(f.harness.calls, []);
  });

  test("an agent that is no longer detected does not block an unattended shared update", async () => {
    const f = await fixture({ dirs: [".cursor"] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });
    f.harness.on(installerUpdate, async () => {
      await writeSkill(f.root, "0.12.1", { ref: "stable" });
      return {};
    });
    const skillDir = join(f.root, ".agents/skills/livediff");

    const result = await inspectAndApply("cursor", f, "update", {
      recorded: {
        cursor: priorRecord("portable-skill", "0.12.0"),
        gemini: priorRecord("portable-skill", "0.12.0"),
      },
      sharedSkill: { path: skillDir, agents: ["cursor", "gemini"] },
      interactive: false,
    });

    assert.equal(result.outcome.status, "updated");
    assert.deepEqual(f.asked, []);
    assert.deepEqual(f.harness.calls, [installerUpdate]);
  });

  test("an acknowledged shared update runs once and reports every agent's verified change", async () => {
    const f = await fixture({ dirs: [".cursor", ".gemini"], answers: [true] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });
    f.harness.on(installerUpdate, async () => {
      await writeSkill(f.root, "0.12.1", { ref: "stable" });
      return {};
    });
    const skillDir = join(f.root, ".agents/skills/livediff");

    const results = await applyInOrder(f, "update", ["cursor"], {
      interactive: true,
      recorded: {
        cursor: priorRecord("portable-skill", "0.12.0"),
        gemini: priorRecord("portable-skill", "0.12.0"),
      },
      sharedSkill: { path: skillDir, agents: ["cursor", "gemini"] },
    });

    assert.deepEqual(f.asked, [
      "Updating the LiveDiff skill also updates it for: Gemini CLI. Continue?",
    ]);
    assert.deepEqual(f.harness.calls, [installerUpdate]);
    const cursor = results.get("cursor");
    assert.equal(cursor?.outcome.status, "updated");
    assert.equal(cursor?.outcome.version, "0.12.1");
    assert.match(cursor?.outcome.detail ?? "", /0\.12\.0 → 0\.12\.1/);
    assert.deepEqual(cursor?.sharedSkill, { path: skillDir, agents: ["cursor", "gemini"] });
  });

  test("a declined shared update is skipped, not run", async () => {
    const f = await fixture({ dirs: [".cursor", ".gemini"], answers: [false] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });

    const result = await inspectAndApply("cursor", f, "update", {
      interactive: true,
      recorded: { cursor: priorRecord("portable-skill", "0.12.0") },
      sharedSkill: { path: join(f.root, ".agents/skills/livediff"), agents: ["cursor", "gemini"] },
    });

    assert.equal(result.outcome.status, "skipped");
    assert.deepEqual(f.harness.calls, []);
  });

  test("an update with nothing new is unchanged", async () => {
    const f = await fixture({ dirs: [".cursor"] });
    await writeSkill(f.root, "0.12.0", { ref: "stable" });
    f.harness.on(installerUpdate, {});

    const result = await inspectAndApply("cursor", f, "update", {
      recorded: { cursor: priorRecord("portable-skill", "0.12.0") },
      sharedSkill: { path: join(f.root, ".agents/skills/livediff"), agents: ["cursor"] },
    });

    assert.equal(result.outcome.status, "unchanged");
    assert.equal(result.outcome.version, "0.12.0");
  });

  test("disclosure: Codex also lists the shared skill next to its native plugin", async () => {
    const f = await fixture({ dirs: [".cursor"] });
    f.harness.on(installerAdd(["cursor"]), async () => {
      await writeSkill(f.root, "0.12.0", { ref: "stable" });
      return {};
    });

    const results = await applyInOrder(f, "install", ["cursor"], {
      recorded: { codex: priorRecord("native-plugin", "0.12.0") },
    });

    assert.match(results.get("cursor")?.outcome.detail ?? "", /Codex also lists/);
  });

  test("an unreadable skill version is recorded as null", async () => {
    const f = await fixture({ dirs: [".gemini"] });
    f.harness.on(installerAdd(["gemini-cli"]), async () => {
      await writeSkill(f.root, null, { ref: "stable" });
      return {};
    });

    const result = await inspectAndApply("gemini", f, "install");

    assert.equal(result.outcome.status, "installed");
    assert.equal(result.record?.version, null);
    assert.match(result.outcome.detail ?? "", /version could not be read/);
  });

  test("a failed shared install fails every portable agent without rerunning the installer", async () => {
    const f = await fixture({ dirs: [".cursor", ".gemini"] });
    f.harness.on(installerAdd(["cursor", "gemini-cli"]), {
      code: 1,
      stderr: "Remote branch stable not found\n",
    });

    const results = await applyInOrder(f, "install", ["cursor", "gemini"]);

    assert.equal(f.harness.calls.length, 1);
    assert.equal(results.get("cursor")?.outcome.status, "failed");
    assert.match(results.get("cursor")?.outcome.detail ?? "", /Remote branch stable not found/);
    assert.equal(
      results.get("cursor")?.outcome.retry,
      "livediff setup --agent cursor --agent gemini",
    );
    assert.equal(results.get("gemini")?.outcome.status, "failed");
    assert.equal(results.get("cursor")?.record, null);
  });

  test("a skill from another ref is a conflict; the lock honours XDG_STATE_HOME", async () => {
    const f = await fixture({ dirs: [".cursor", "state"], env: {} });
    f.ctx.env["XDG_STATE_HOME"] = join(f.root, "state");
    await writeSkill(f.root, "0.11.0", { ref: "main" }, join(f.root, "state"));

    const inspection = await adapterFor("cursor").inspect(f.ctx);
    assert.match(inspection.conflict ?? "", /ssteuteville\/livediff#main/);
    assert.equal(inspection.installed?.version, "0.11.0");

    const result = await inspectAndApply("cursor", f, "install");
    assert.equal(result.outcome.status, "failed");
    assert.deepEqual(f.harness.calls, []);
  });

  test("a local source installs by path and updates by re-adding", async () => {
    const local = resolve("/tmp/livediff-checkout");
    const f = await fixture({ dirs: [".cursor"], env: { LIVEDIFF_SETUP_SOURCE: local } });
    await writeSkill(f.root, "0.12.0", null);
    f.harness.on(installerAdd(["cursor"], local), async () => {
      await writeSkill(f.root, "0.12.1", null);
      return {};
    });

    const result = await inspectAndApply("cursor", f, "update", {
      recorded: { cursor: priorRecord("portable-skill", "0.12.0") },
      sharedSkill: { path: join(f.root, ".agents/skills/livediff"), agents: ["cursor"] },
    });

    assert.deepEqual(f.harness.calls, [installerAdd(["cursor"], local)]);
    assert.equal(result.outcome.status, "updated");
    assert.equal(result.record?.source, `local:${local}`);
  });
});

describe("skill metadata", () => {
  test("reads metadata.version from the shipped portable skill", async () => {
    const manifest = await readFile(join(repoRoot, "skills/livediff/SKILL.md"), "utf8");
    const pkg: unknown = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    assert.ok(typeof pkg === "object" && pkg !== null && "version" in pkg);
    assert.equal(skillVersion(manifest), pkg.version);
  });

  test.each([
    ["inline map", "---\nname: x\nmetadata: { version: 1.2.3, other: y }\n---\n", "1.2.3"],
    ["quoted block", "---\nmetadata:\n  author: me\n  version: '1.2.3' # pinned\n---\n", "1.2.3"],
    ["absent", "---\nname: x\n---\n", null],
    ["no frontmatter", "# LiveDiff\n", null],
  ])("%s", (_name, text, expected) => {
    assert.equal(skillVersion(text), expected);
  });
});

describe("sources and compatibility", () => {
  test("the published source uses each harness's verified ref syntax", () => {
    const source = integrationSource({});
    assert.equal(source.claudeMarketplace, CLAUDE_SOURCE);
    assert.equal(source.codexMarketplace, "ssteuteville/livediff");
    assert.equal(source.codexRef, "stable");
    assert.equal(source.skills, SKILLS_SOURCE);
  });

  test("a local override resolves to an absolute path without a ref", () => {
    const source = integrationSource({ LIVEDIFF_SETUP_SOURCE: "relative/checkout" });
    const absolute = resolve("relative/checkout");
    assert.deepEqual(source, {
      id: `local:${absolute}`,
      claudeMarketplace: absolute,
      codexMarketplace: absolute,
      codexRef: null,
      skills: absolute,
    });
  });

  test.each([
    { integration: "0.12.3", cli: "0.12.0", expect: null },
    { integration: "0.13.0", cli: "0.12.4", expect: /npm install -g livediff@latest/ },
    { integration: "0.11.2", cli: "0.12.0", expect: /livediff setup --update --agent claude/ },
    { integration: null, cli: "0.12.0", expect: null },
  ])("integration $integration with CLI $cli", ({ integration, cli, expect }) => {
    const warning = checkCompatibility(integration, cli, "claude");
    if (expect === null) assert.equal(warning, null);
    else assert.match(warning ?? "", expect);
  });
});

// ---------------------------------------------------------------- Real harnesses (opt-in)

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(process.env["LIVEDIFF_REAL_HARNESS_TESTS"] !== "1")(
  "real harnesses (isolated profiles)",
  () => {
    test.each<AgentAlias>(["claude", "codex"])(
      "%s installs from a local checkout, then a rerun is unchanged",
      async (alias) => {
        // Codex refuses to load its config when CODEX_HOME names a directory that does not exist.
        const f = await fixture({ dirs: [".codex"], env: { LIVEDIFF_SETUP_SOURCE: repoRoot } });
        f.ctx.env["PATH"] = process.env["PATH"];
        f.ctx.run = runProcess;
        const first = await inspectAndApply(alias, f, "install");
        assert.equal(first.outcome.status, "installed", first.outcome.detail ?? "");
        assert.ok(first.record?.version, "the installed version was read back from the harness");
        const second = await inspectAndApply(alias, f, "install", {
          recorded: { [alias]: first.record ?? undefined },
        });
        assert.equal(second.outcome.status, "unchanged", second.outcome.detail ?? "");
      },
      300_000,
    );

    test("the portable skill installs from a local checkout, then a rerun is unchanged", async () => {
      const f = await fixture({ dirs: [".cursor"], env: { LIVEDIFF_SETUP_SOURCE: repoRoot } });
      f.ctx.env["PATH"] = process.env["PATH"];
      f.ctx.env["npm_config_cache"] = join(f.root, ".npm");
      f.ctx.run = runProcess;
      const first = await inspectAndApply("cursor", f, "install");
      assert.equal(first.outcome.status, "installed", first.outcome.detail ?? "");
      assert.ok(first.record?.version, "the installed version was read from SKILL.md");
      const second = await inspectAndApply("cursor", f, "install", {
        recorded: { cursor: first.record ?? undefined },
        sharedSkill: first.sharedSkill ?? null,
      });
      assert.equal(second.outcome.status, "unchanged", second.outcome.detail ?? "");
    }, 300_000);
  },
);
