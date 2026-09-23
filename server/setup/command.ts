import { EXIT_ERROR, EXIT_USAGE } from "../constants.js";
import { runSetup, type SetupRunReport } from "./index.js";
import { SETUP_CONTINUATION_ENV, SetupLockedError } from "./lock.js";
import { SETUP_CLI_CHANGED_ENV } from "./npm.js";
import { parseSetupOptions } from "./options.js";
import { runProcess } from "./process.js";
import { createProgress, createPrompter, refusingPrompter } from "./prompts.js";
import { integrationSource } from "./source.js";
import type { ComponentOutcome, SetupContext } from "./types.js";

/**
 * `livediff setup`, kept out of cli.ts: it needs no repository, no hub, and no browser, and
 * must never trigger any of them. Progress goes to stderr; the summary (or, with `--json`, one
 * JSON document) to stdout.
 */
export async function setupCommand(
  rawArgv: readonly string[],
  cliVersion: string,
): Promise<number> {
  const json = rawArgv.includes("--json");
  const parsed = parseSetupOptions(rawArgv, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  if (!parsed.ok)
    return reportError(`${parsed.error}\n\nusage: livediff setup --help`, EXIT_USAGE, json);
  const request = parsed.request;

  // Only the handoff spawn may pass the continuation on; no other child may inherit it.
  const continuationToken = process.env[SETUP_CONTINUATION_ENV] ?? null;
  delete process.env[SETUP_CONTINUATION_ENV];
  const cliChanged = process.env[SETUP_CLI_CHANGED_ENV] === "1";
  delete process.env[SETUP_CLI_CHANGED_ENV];

  const ctx: SetupContext = {
    run: runProcess,
    prompts: request.interactive ? createPrompter() : refusingPrompter(),
    progress: createProgress(),
    env: process.env,
    platform: process.platform,
    cliVersion,
    source: integrationSource(process.env),
    persistent: null,
  };

  let report: SetupRunReport;
  try {
    report = await runSetup(request, ctx, { continuationToken, cliChanged });
  } catch (error) {
    if (error instanceof SetupLockedError) return reportError(error.message, EXIT_ERROR, json);
    throw error;
  }
  if (report.handedOff) return report.exitCode;
  if (request.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderSummary(report));
  return report.exitCode;
}

function reportError(message: string, exitCode: number, json: boolean): number {
  console.error(message);
  if (json) console.log(JSON.stringify({ error: message, exitCode }, null, 2));
  return exitCode;
}

const MARKS: Record<ComponentOutcome["status"], string> = {
  installed: "✓",
  unchanged: "✓",
  updated: "✓",
  skipped: "-",
  unavailable: "-",
  failed: "✗",
};

const STATUS_WORDS: Record<ComponentOutcome["status"], string> = {
  installed: "installed",
  unchanged: "ready",
  updated: "updated",
  skipped: "skipped",
  unavailable: "unavailable",
  failed: "failed",
};

/** The final summary: verified results, what was skipped and why, and the one next step. */
export function renderSummary(report: SetupRunReport): string {
  const lines = [""];
  for (const outcome of report.outcomes) {
    if (outcome.id.startsWith("prereq:") && outcome.status !== "failed") continue;
    lines.push(summaryLine(outcome));
    if (outcome.retry !== undefined && outcome.status !== "installed") {
      lines.push(`    retry: ${outcome.retry}`);
    }
  }
  if (report.outcomes.some((o) => o.restartRequired === true)) {
    lines.push("", "Start a new agent session so it loads LiveDiff.");
  }
  if (report.outcome === "cancelled") lines.push("", "Setup cancelled; completed steps were kept.");
  if (report.firstUse !== null) lines.push("", report.firstUse);
  return lines.join("\n");
}

function summaryLine(outcome: ComponentOutcome): string {
  const mark = MARKS[outcome.status];
  const settled = outcome.status !== "failed" && outcome.status !== "skipped";
  if (outcome.id === "browser" && settled && outcome.detail !== undefined) {
    return `${mark} Browser: ${outcome.detail}`;
  }
  const version = outcome.version === undefined ? "" : ` ${outcome.version}`;
  const source = outcome.source === undefined ? "" : ` (${outcome.source})`;
  const detail = outcome.detail === undefined ? "" : ` — ${outcome.detail}`;
  return `${mark} ${outcome.label}${version}${source} ${STATUS_WORDS[outcome.status]}${detail}`;
}
