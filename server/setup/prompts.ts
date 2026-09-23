import { confirm, isCancel, multiselect, select } from "@clack/prompts";
import { SetupCancelled, type ChoiceOption, type Progress, type Prompter } from "./types.js";

/**
 * Progress lines on stderr, one per operation, so a long npm install still names what it is
 * doing. Colorless when NO_COLOR is set or stderr is not a terminal.
 */
export function createProgress(
  stream: NodeJS.WriteStream = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): Progress {
  const color = stream.isTTY && (env["NO_COLOR"] ?? "") === "";
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

/** The pinned prompt library behind the narrow `Prompter` boundary. Ctrl-C or Esc cancels setup. */
export function createPrompter(): Prompter {
  return {
    async multiselect<T extends string>(
      message: string,
      options: readonly ChoiceOption<T>[],
      initial: readonly T[],
    ): Promise<T[]> {
      const answer = await multiselect<string>({
        message,
        options: options.map(toClackOption),
        initialValues: [...initial],
        required: false,
      });
      if (isCancel(answer)) throw new SetupCancelled();
      return options.filter((option) => answer.includes(option.value)).map((o) => o.value);
    },
    async select<T extends string>(
      message: string,
      options: readonly ChoiceOption<T>[],
    ): Promise<T> {
      const answer = await select<string>({ message, options: options.map(toClackOption) });
      if (isCancel(answer)) throw new SetupCancelled();
      const chosen = options.find((option) => option.value === answer);
      if (chosen === undefined) throw new Error(`prompt returned an unknown choice: ${answer}`);
      return chosen.value;
    },
    async confirm(message: string, initial: boolean): Promise<boolean> {
      const answer = await confirm({ message, initialValue: initial });
      if (isCancel(answer)) throw new SetupCancelled();
      return answer;
    },
  };
}

/** Clack's option type is conditional on its value type, which a generic `T` cannot satisfy. */
function toClackOption(option: ChoiceOption<string>): {
  value: string;
  label: string;
  hint?: string;
} {
  return option.hint === undefined
    ? { value: option.value, label: option.label }
    : { value: option.value, label: option.label, hint: option.hint };
}

/** For non-interactive runs: reaching a prompt is a bug in option handling, never a hang. */
export function refusingPrompter(): Prompter {
  const refuse = (): never => {
    throw new Error("setup needed an answer but is running without prompts");
  };
  return { multiselect: refuse, select: refuse, confirm: refuse };
}
