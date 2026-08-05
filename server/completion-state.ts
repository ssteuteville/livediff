import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "./config.js";
import type { CompletionShell } from "./cli-completion.js";

const START_MARKER = "# >>> livediff completion >>>";
const END_MARKER = "# <<< livediff completion <<<";

export interface CompletionStatus {
  shell: CompletionShell;
  path: string;
  installed: boolean;
  activationPath: string;
  activated: boolean;
}

function isShell(value: string): value is CompletionShell {
  return value === "bash" || value === "zsh" || value === "fish";
}

export function detectCompletionShell(shell = process.env["SHELL"]): CompletionShell | null {
  if (shell === undefined) return null;
  const name = shell.split("/").at(-1) ?? "";
  return isShell(name) ? name : null;
}

export function resolveCompletionShell(requested?: string): CompletionShell {
  if (requested !== undefined) {
    if (isShell(requested)) return requested;
    throw new Error("unknown shell '" + requested + "'; choose bash, zsh, or fish");
  }
  const detected = detectCompletionShell();
  if (detected !== null) return detected;
  throw new Error("could not detect your shell; pass bash, zsh, or fish explicitly");
}

export function completionInstallPath(shell: CompletionShell): string {
  return join(dirname(configPath()), "completions", "livediff." + shell);
}

export function completionActivationPath(shell: CompletionShell): string {
  if (shell === "fish") return join(dirname(dirname(configPath())), "fish", "config.fish");
  return join(homedir(), shell === "zsh" ? ".zshrc" : ".bashrc");
}

function sourceLine(path: string): string {
  return "source '" + path.replaceAll("'", "'\\''") + "'";
}

function activationBlock(path: string): string {
  return START_MARKER + "\n" + sourceLine(path) + "\n" + END_MARKER + "\n";
}

function removeActivationBlock(text: string): string {
  const start = text.indexOf(START_MARKER);
  if (start === -1) return text;
  const end = text.indexOf(END_MARKER, start);
  if (end === -1) return text;
  const after = end + END_MARKER.length;
  const newline = text[after] === "\n" ? after + 1 : after;
  return text.slice(0, start) + text.slice(newline);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + ".tmp";
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

async function updateActivation(shell: CompletionShell, active: boolean): Promise<void> {
  const path = completionActivationPath(shell);
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const next = removeActivationBlock(text);
  const updated = active
    ? (next.endsWith("\n") || next === "" ? next : next + "\n") +
      activationBlock(completionInstallPath(shell))
    : next;
  if (updated === text) return;
  await writeAtomic(path, updated);
}

export async function installCompletion(
  shell: CompletionShell,
  script: string,
  activate: boolean,
): Promise<CompletionStatus> {
  await writeAtomic(completionInstallPath(shell), script);
  if (activate) await updateActivation(shell, true);
  return completionStatus(shell);
}

export async function uninstallCompletion(
  shell: CompletionShell,
  deactivate: boolean,
): Promise<CompletionStatus> {
  await rm(completionInstallPath(shell), { force: true });
  if (deactivate) await updateActivation(shell, false);
  return completionStatus(shell);
}

export async function completionStatus(shell: CompletionShell): Promise<CompletionStatus> {
  const path = completionInstallPath(shell);
  const activationPath = completionActivationPath(shell);
  let activation = "";
  try {
    activation = await readFile(activationPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return {
    shell,
    path,
    installed: await exists(path),
    activationPath,
    activated: activation.includes(START_MARKER) && activation.includes(sourceLine(path)),
  };
}
