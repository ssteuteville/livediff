/**
 * Pure argv-value parsers.
 *
 * These live outside `cli.ts` because that module is the executable entry point: importing it
 * runs the CLI. A test that wants to check how one flag parses must be able to do so without
 * spawning a hub, and guarding the entry point instead would break every symlinked install,
 * since Node resolves `import.meta.url` through symlinks but leaves `process.argv[1]` alone.
 */

/** Every value passed to a repeatable flag, in the order given. A flags map only keeps the last. */
export function flagValues(tokens: readonly string[], name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === name) found.push(tokens[i + 1] ?? "");
  }
  return found;
}

/** `path:start-end`, where the path may itself contain colons on Windows-style inputs. */
export function parseHighlightArg(value: string): { path: string; start: number; end: number } {
  const at = value.lastIndexOf(":");
  const range = at === -1 ? "" : value.slice(at + 1);
  const match = /^(\d+)-(\d+)$/.exec(range);
  const path = at === -1 ? "" : value.slice(0, at);
  if (!match || path.length === 0) {
    throw new Error(`--highlight must look like path:start-end, for example src/retry.ts:88-104`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1) throw new Error("--highlight start must be 1 or more");
  if (end < start) throw new Error("--highlight end must not be before start");
  return { path, start, end };
}
