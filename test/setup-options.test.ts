import { test } from "vitest";
import assert from "node:assert/strict";
import { parseSetupOptions, type TerminalState } from "../server/setup/options.js";

const TTY: TerminalState = { stdinIsTTY: true, stdoutIsTTY: true };
const PIPE: TerminalState = { stdinIsTTY: false, stdoutIsTTY: false };

function request(argv: string[], terminal = TTY) {
  const parsed = parseSetupOptions(argv, terminal);
  if (!parsed.ok) throw new Error(`expected ${argv.join(" ")} to parse: ${parsed.error}`);
  return parsed.request;
}

function error(argv: string[], terminal = TTY): string {
  const parsed = parseSetupOptions(argv, terminal);
  if (parsed.ok) throw new Error(`expected ${argv.join(" ")} to be rejected`);
  return parsed.error;
}

test("--agent is repeatable, case-insensitive, and deduplicated in the order given", () => {
  const parsed = request(["--agent", "Codex", "--agent", "claude", "--agent", "codex"]);
  assert.deepEqual(parsed.agents, ["codex", "claude"]);
});

test("unknown agents and missing agent values are rejected with the valid aliases", () => {
  assert.match(error(["--agent", "nope"]), /unknown agent 'nope'.*claude, codex, cursor/);
  assert.match(error(["--agent"]), /--agent requires a value/);
});

test("--browser accepts cmux or system, once", () => {
  assert.equal(request(["--browser", "CMUX"]).browser, "cmux");
  assert.equal(request(["--browser", "system"]).browser, "system");
  assert.equal(request([]).browser, null);
  assert.match(error(["--browser", "firefox"]), /invalid --browser 'firefox'/);
  assert.match(error(["--browser", "cmux", "--browser", "system"]), /only be given once/);
});

test("--cli-only cannot be combined with --agent", () => {
  assert.match(error(["--cli-only", "--agent", "codex"]), /cannot be combined/);
  assert.equal(request(["--cli-only"]).cliOnly, true);
});

test("--yes needs --agent, --cli-only, or --update", () => {
  assert.match(error(["--yes"]), /--yes needs an explicit selection/);
  assert.deepEqual(request(["--yes", "--agent", "gemini"]).agents, ["gemini"]);
  assert.equal(request(["--yes", "--cli-only"]).cliOnly, true);
  const update = request(["--yes", "--update"]);
  assert.equal(update.update, true);
  assert.deepEqual(update.agents, []);
});

test("without a terminal or with --json, setup refuses to guess a selection", () => {
  assert.match(error([], PIPE), /without a terminal needs an explicit selection/);
  assert.match(error(["--json"]), /--json needs an explicit selection/);
  assert.match(error([], { stdinIsTTY: true, stdoutIsTTY: false }), /explicit selection/);
  assert.equal(request(["--update"], PIPE).update, true);
  assert.deepEqual(request(["--agent", "codex"], PIPE).agents, ["codex"]);
});

test("prompts are allowed only with a terminal on both ends and neither --json nor --yes", () => {
  assert.equal(request([]).interactive, true);
  assert.equal(
    request(["--agent", "codex"], { stdinIsTTY: false, stdoutIsTTY: true }).interactive,
    false,
  );
  assert.equal(
    request(["--agent", "codex"], { stdinIsTTY: true, stdoutIsTTY: false }).interactive,
    false,
  );
  assert.equal(request(["--agent", "codex", "--json"]).interactive, false);
  assert.equal(request(["--agent", "codex", "--yes"]).interactive, false);
  assert.equal(request(["--agent", "codex", "--json"]).json, true);
});
