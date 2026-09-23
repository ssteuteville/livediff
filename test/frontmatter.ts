import { parse } from "yaml";

/**
 * Frontmatter parsing for SKILL.md files, matching what vercel-labs/skills@1.7.0 actually
 * does: split on the leading `---` fences with the same regex the installer uses, then
 * parse the YAML block with the `yaml` package (pinned to the exact version, 2.9.0, that
 * skills@1.7.0 bundles — see ThirdPartyNoticeText.txt in its published tarball). A
 * hand-rolled parser here could accept YAML the installer rejects, which would make this
 * test pass on frontmatter the installer actually skips — using the same library at the
 * same version is what makes a parse failure here mean the installer would skip the skill.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseSkillFile(fileContents: string): ParsedSkill {
  const { frontmatter, body } = splitFrontmatter(fileContents);
  // `parse` throws YAMLParseError on invalid documents by default (no relaxed/recovery
  // mode requested), which is the same failure mode the installer hits.
  const parsed: unknown = parse(frontmatter) ?? {};
  if (!isRecord(parsed)) {
    throw new Error("frontmatter must parse to a YAML mapping");
  }
  return { data: parsed, body };
}
