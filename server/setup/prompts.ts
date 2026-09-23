import type { Progress, Prompter } from "./types.js";

/** Plain stderr progress; colorless when NO_COLOR is set or stderr is not a terminal. */
export function createProgress(stream: NodeJS.WriteStream = process.stderr): Progress {
  const color = stream.isTTY && !process.env["NO_COLOR"];
  const paint = (code: string, text: string): string =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = (mark: string, message: string): void => {
    stream.write(`${mark} ${message}\n`);
  };
  return {
    step: (message) => line(paint("36", "›"), message),
    ok: (message) => line(paint("32", "✓"), message),
    warn: (message) => line(paint("33", "!"), message),
    fail: (message) => line(paint("31", "✗"), message),
    info: (message) => line(" ", message),
  };
}

/** Task 5 replaces this with the pinned prompt library behind the same interface. */
export function createPrompter(): Prompter {
  const unavailable = (): never => {
    throw new Error("interactive prompts are not implemented yet");
  };
  return { multiselect: unavailable, select: unavailable, confirm: unavailable };
}

/** For non-interactive runs: reaching a prompt is a bug in option handling, never a hang. */
export function refusingPrompter(): Prompter {
  const refuse = (): never => {
    throw new Error("setup needed an answer but is running without prompts");
  };
  return { multiselect: refuse, select: refuse, confirm: refuse };
}
