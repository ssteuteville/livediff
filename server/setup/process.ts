import { spawn } from "node:child_process";
import type { RunOptions, RunResult, Runner } from "./types.js";

/** The real subprocess runner. Argv only — nothing here is ever interpreted by a shell. */
export const runProcess: Runner = (command, args, options: RunOptions = {}) =>
  new Promise<RunResult>((resolveRun) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) =>
      resolveRun({ code: -1, stdout, stderr: stderr + error.message }),
    );
    child.once("close", (code, signal) =>
      resolveRun({ code: code ?? (signal === null ? -1 : 128), stdout, stderr }),
    );
  });
