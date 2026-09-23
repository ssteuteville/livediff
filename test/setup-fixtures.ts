import type {
  ChoiceOption,
  IntegrationSource,
  Progress,
  Prompter,
  RunOptions,
  RunResult,
  Runner,
  SetupContext,
} from "../server/setup/types.js";

export interface RecordedCall {
  command: string;
  args: readonly string[];
  options: RunOptions | undefined;
}

export type FakeHandler = (
  command: string,
  args: readonly string[],
  options: RunOptions | undefined,
) => RunResult | undefined | Promise<RunResult | undefined>;

/** A Runner that answers from `handler` and records every call; unknown commands are "not found". */
export function fakeRunner(handler: FakeHandler): { run: Runner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: Runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return (
      (await handler(command, args, options)) ?? {
        code: -1,
        stdout: "",
        stderr: `spawn ${command} ENOENT`,
      }
    );
  };
  return { run, calls };
}

export function ok(stdout = ""): RunResult {
  return { code: 0, stdout, stderr: "" };
}

export function failed(stderr: string, code = 1): RunResult {
  return { code, stdout: "", stderr };
}

export interface RecordedProgress extends Progress {
  lines: string[];
}

export function recordingProgress(): RecordedProgress {
  const lines: string[] = [];
  const add =
    (kind: string) =>
    (message: string): void => {
      lines.push(`${kind} ${message}`);
    };
  return {
    lines,
    step: add("step"),
    ok: add("ok"),
    warn: add("warn"),
    fail: add("fail"),
    info: add("info"),
  };
}

export interface ScriptedAnswers {
  multiselect?: string[][];
  select?: string[];
  confirm?: boolean[];
}

/** Answers prompts from a script, recording each question; running out of answers is a test bug. */
export function scriptedPrompter(answers: ScriptedAnswers): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = <T>(queue: T[] | undefined, message: string): T => {
    asked.push(message);
    const answer = queue?.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${message}`);
    return answer;
  };
  return {
    asked,
    async multiselect<T extends string>(message: string, options: readonly ChoiceOption<T>[]) {
      const picked = next(answers.multiselect, message);
      return options.filter((o) => picked.includes(o.value)).map((o) => o.value);
    },
    async select<T extends string>(message: string, options: readonly ChoiceOption<T>[]) {
      const picked = next(answers.select, message);
      const option = options.find((o) => o.value === picked);
      if (option === undefined) throw new Error(`scripted answer ${picked} is not an option`);
      return option.value;
    },
    async confirm(message: string) {
      return next(answers.confirm, message);
    },
  };
}

const SOURCE: IntegrationSource = {
  id: "test",
  claudeMarketplace: "test",
  codexMarketplace: "test",
  codexRef: null,
  skills: "test",
};

export function fakeContext(
  overrides: Partial<SetupContext> & Pick<SetupContext, "run">,
): SetupContext {
  return {
    prompts: scriptedPrompter({}),
    progress: recordingProgress(),
    env: {},
    platform: "darwin",
    cliVersion: "0.0.0",
    source: SOURCE,
    persistent: null,
    ...overrides,
  };
}
