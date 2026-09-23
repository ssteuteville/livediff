/**
 * Minimal, strict-enough YAML frontmatter parser for SKILL.md files.
 *
 * No YAML dependency is in the tree, and none is added here — this parses only the subset
 * SKILL.md frontmatter actually uses (flat/nested mappings, plain and quoted scalars, flow
 * sequences, and `>`/`|` block scalars), but it is strict about the parts that broke before:
 * a plain scalar built from several quoted fragments concatenated on one line is invalid
 * YAML (content trailing a closed quoted scalar is a syntax error), and this parser throws
 * on it instead of silently returning the first quoted fragment.
 */

export interface ParsedSkill {
  data: Record<string, unknown>;
  body: string;
}

export function splitFrontmatter(fileContents: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(fileContents);
  if (!match) {
    throw new Error("SKILL.md must start with a YAML frontmatter block delimited by ---");
  }
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

export function parseSkillFile(fileContents: string): ParsedSkill {
  const { frontmatter, body } = splitFrontmatter(fileContents);
  return { data: parseFrontmatter(frontmatter), body };
}

interface RawLine {
  indent: number;
  text: string;
}

function toRawLines(yamlText: string): RawLine[] {
  return yamlText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
}

export function parseFrontmatter(yamlText: string): Record<string, unknown> {
  const lines = toRawLines(yamlText);
  if (lines.length === 0) return {};
  const baseIndent = lines[0]?.indent ?? 0;
  return parseMapping(lines, 0, baseIndent).value;
}

function parseMapping(
  lines: readonly RawLine[],
  start: number,
  indent: number,
): { value: Record<string, unknown>; next: number } {
  const result: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent) break;
    const colon = findTopLevelColon(line.text);
    if (colon === -1) {
      throw new Error(`expected "key: value" at: ${line.text}`);
    }
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    const next = lines[i + 1];

    if (rest === "") {
      if (next !== undefined && next.indent > indent) {
        const nested = parseMapping(lines, i + 1, next.indent);
        result[key] = nested.value;
        i = nested.next;
        continue;
      }
      result[key] = "";
      i += 1;
      continue;
    }

    if (rest === ">-" || rest === ">" || rest === "|-" || rest === "|") {
      const folded = rest.startsWith(">");
      const contentLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const contentLine = lines[j];
        if (contentLine === undefined || contentLine.indent <= indent) break;
        contentLines.push(contentLine.text);
        j += 1;
      }
      result[key] = contentLines.join(folded ? " " : "\n");
      i = j;
      continue;
    }

    result[key] = parseScalarOrFlow(rest);
    i += 1;
  }
  return { value: result, next: i };
}

function findTopLevelColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ":" && !inSingle && !inDouble) {
      const after = text[idx + 1];
      if (after === undefined || after === " ") return idx;
    }
  }
  return -1;
}

function parseScalarOrFlow(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new Error(`unterminated flow sequence: ${raw}`);
    }
    return splitFlowItems(value.slice(1, -1)).map((item) => parseScalar(item));
  }
  return parseScalar(value);
}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth += 1;
      if (ch === "]" || ch === "}") depth -= 1;
      if (ch === "," && depth === 0) {
        items.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim().length > 0) items.push(current);
  return items;
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) return parseDoubleQuoted(value);
  if (value.startsWith("'")) return parseSingleQuoted(value);
  // A plain scalar may contain quote characters anywhere except at the start — YAML only
  // treats a leading quote as the start of a quoted scalar. The bug this parser exists to
  // catch (several quoted fragments concatenated, e.g. `"a", "b", or c`) always starts with
  // a quote, so it is already caught by the branches above.
  return value;
}

function parseDoubleQuoted(value: string): string {
  let i = 1;
  let out = "";
  while (i < value.length) {
    const ch = value[i];
    if (ch === "\\") {
      out += value[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === '"') {
      const rest = value.slice(i + 1).trim();
      if (rest.length > 0 && !rest.startsWith("#")) {
        throw new Error(`trailing content after closed double-quoted scalar: ${value}`);
      }
      return out;
    }
    out += ch;
    i += 1;
  }
  throw new Error(`unterminated double-quoted scalar: ${value}`);
}

function parseSingleQuoted(value: string): string {
  let i = 1;
  let out = "";
  while (i < value.length) {
    if (value[i] === "'" && value[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (value[i] === "'") {
      const rest = value.slice(i + 1).trim();
      if (rest.length > 0 && !rest.startsWith("#")) {
        throw new Error(`trailing content after closed single-quoted scalar: ${value}`);
      }
      return out;
    }
    out += value[i];
    i += 1;
  }
  throw new Error(`unterminated single-quoted scalar: ${value}`);
}
