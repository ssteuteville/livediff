/**
 * Renders docs/CLI.md from the command registry in server/cli-help.ts. Run `pnpm docs:cli` to
 * regenerate after changing a command; `test/cli-docs.test.ts` fails the build if it drifts.
 *
 * The `:cli` suffix is load-bearing. This script used to be named `docs`, which collides with
 * pnpm's built-in `docs` command — `pnpm docs` opened the package's page on npm and regenerated
 * nothing, silently, so the drift test kept failing with no clue why. pnpm has no built-in
 * containing a colon, so the suffix makes the collision impossible rather than documented.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeCli, type CliDescriptor, type CommandDescriptor } from "../server/cli-help.js";

const GENERATED_HEADER = [
  "# LiveDiff CLI Reference",
  "",
  "> Generated from the command registry by `scripts/generate-cli-docs.ts`. Do not edit by hand —",
  "> run `pnpm docs:cli` to regenerate. `test/cli-docs.test.ts` fails if this file drifts from",
  "> the registry.",
].join("\n");

function slugify(headingText: string): string {
  return headingText
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s+/g, "-");
}

function renderTableOfContents(commands: readonly CommandDescriptor[]): string {
  const lines = commands.map((command) => `- [${command.name}](#${slugify(command.name)})`);
  return ["## Commands", "", ...lines].join("\n");
}

/** Pads columns to their widest cell so the output matches oxfmt's table formatting exactly. */
function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]!.length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

/**
 * A literal `|` inside a code span (e.g. the `path|id` argument name) confuses markdown table
 * parsers that split cells before resolving code spans. Escape it as `\|` and drop the code
 * formatting for that one case rather than risk a table-splitting bug in some renderer.
 */
function tableCellName(name: string): string {
  return name.includes("|") ? name.replace(/\|/g, "\\|") : `\`${name}\``;
}

function renderArgumentsTable(command: CommandDescriptor): string {
  if (command.arguments.length === 0) return "";
  const rows = command.arguments.map((arg) => [
    tableCellName(arg.name),
    arg.required ? "yes" : "no",
    arg.variadic ? "yes" : "no",
  ]);
  return ["**Arguments:**", "", renderTable(["Name", "Required", "Variadic"], rows)].join("\n");
}

function renderOptionsTable(command: CommandDescriptor): string {
  if (command.options.length === 0) return "";
  const rows = command.options.map((option) => [
    option.flags.map((flag) => `\`${flag}\``).join(", "),
    option.takesValue ? "yes" : "no",
    option.description,
  ]);
  return ["**Options:**", "", renderTable(["Flags", "Takes value", "Description"], rows)].join(
    "\n",
  );
}

function renderExamplesList(command: CommandDescriptor): string {
  if (command.examples.length === 0) return "";
  const items = command.examples.map(
    (example) => `- \`${example.command}\` — ${example.description}`,
  );
  return ["**Examples:**", "", ...items].join("\n");
}

function renderCommandSection(command: CommandDescriptor): string {
  const parts = [
    `## \`${command.name}\``,
    "",
    command.summary,
    "",
    "**Usage:**",
    "",
    `\`\`\`\n${command.usage}\n\`\`\``,
  ];
  if (command.aliases.length > 0) {
    parts.push("", "**Aliases:**", "", command.aliases.map((alias) => `\`${alias}\``).join(", "));
  }
  const argsTable = renderArgumentsTable(command);
  if (argsTable) parts.push("", argsTable);
  const optionsTable = renderOptionsTable(command);
  if (optionsTable) parts.push("", optionsTable);
  const examplesList = renderExamplesList(command);
  if (examplesList) parts.push("", examplesList);
  return parts.join("\n");
}

function renderGlobalOptions(descriptor: CliDescriptor): string {
  const rows = descriptor.globalOptions.map((option) => [
    option.flags.map((flag) => `\`${flag}\``).join(", "),
    option.takesValue ? "yes" : "no",
    option.description,
  ]);
  return [
    "## Global options",
    "",
    "Available on every command.",
    "",
    renderTable(["Flags", "Takes value", "Description"], rows),
  ].join("\n");
}

export function renderCliReference(descriptor: CliDescriptor): string {
  const sections = [
    GENERATED_HEADER,
    "",
    renderGlobalOptions(descriptor),
    "",
    renderTableOfContents(descriptor.commands),
    "",
    ...descriptor.commands.flatMap((command) => [renderCommandSection(command), ""]),
  ];
  return (
    sections
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isSourceModule = import.meta.url.endsWith(".ts");
const projectRoot = isSourceModule ? join(__dirname, "..") : join(__dirname, "..", "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageVersion(): Promise<string> {
  const packageData: unknown = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const version = isRecord(packageData) ? packageData["version"] : undefined;
  return typeof version === "string" ? version : "0.0.0";
}

async function main(): Promise<void> {
  const version = await readPackageVersion();
  const reference = renderCliReference(describeCli(version));
  await writeFile(join(projectRoot, "docs", "CLI.md"), reference, "utf8");
  console.log("wrote docs/CLI.md");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
