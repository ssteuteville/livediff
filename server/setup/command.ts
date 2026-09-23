import { EXIT_ERROR, EXIT_USAGE } from "../constants.js";
import { runSetup, type SetupRunReport } from "./index.js";
import { parseSetupOptions } from "./options.js";
import { runProcess } from "./process.js";
import { createProgress, createPrompter, refusingPrompter } from "./prompts.js";
import { SetupLockedError } from "./lock.js";
import { integrationSource } from "./source.js";
import type { ComponentOutcome, SetupContext } from "./types.js";

/**
 * `livediff setup`, kept out of cli.ts: it needs no repository, no hub, and no browser, and
 * must never trigger any of them.
 */
export async function setupCommand(
  rawArgv: readonly string[],
  cliVersion: string,
): Promise<number> {
  const parsed = parseSetupOptions(rawArgv, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\nusage: livediff setup --help`);
    return EXIT_USAGE;
  }
  const request = parsed.request;
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
    report = await runSetup(request, ctx);
  } catch (error) {
    if (error instanceof SetupLockedError) {
      console.error(error.message);
      return EXIT_ERROR;
    }
    throw error;
  }
  if (request.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
  return report.exitCode;
}

const MARKS: Record<ComponentOutcome["status"], string> = {
  installed: "✓",
  unchanged: "✓",
  updated: "✓",
  skipped: "-",
  unavailable: "-",
  failed: "✗",
};

function printSummary(report: SetupRunReport): void {
  const lines = [""];
  for (const outcome of report.outcomes) {
    const version = outcome.version === undefined ? "" : ` ${outcome.version}`;
    const detail = outcome.detail === undefined ? "" : ` — ${outcome.detail}`;
    lines.push(`${MARKS[outcome.status]} ${outcome.label}${version}: ${outcome.status}${detail}`);
    if (outcome.status === "failed" && outcome.retry !== undefined) {
      lines.push(`    retry: ${outcome.retry}`);
    }
  }
  if (report.outcomes.some((o) => o.restartRequired === true)) {
    lines.push("", "Start a new agent session to pick up the new integration.");
  }
  if (report.outcome === "cancelled") lines.push("", "Setup cancelled; completed steps were kept.");
  if (report.firstUse !== null) lines.push("", report.firstUse);
  console.log(lines.join("\n"));
}
