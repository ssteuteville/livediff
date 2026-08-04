/** Filtering and rendering for review comments. Pure — no I/O, no hub, no process state. */

import { daysUntilPurge, type CommentStatus, type LifecycleComment } from "./comment-lifecycle.js";
import { MAX_ANCHOR_LENGTH } from "./constants.js";

export const COMMENT_STATUSES = ["open", "resolved", "all"] as const;

export type CommentFilterStatus = (typeof COMMENT_STATUSES)[number];

interface FormattedComment extends LifecycleComment {
  body: string;
  id: string;
  line: number;
  lineContent?: string | null;
  replies?: readonly unknown[];
}

export function filterByStatus<T extends { status: CommentStatus }>(
  comments: readonly T[],
  status: CommentFilterStatus,
): T[] {
  return status === "all" ? [...comments] : comments.filter((c) => c.status === status);
}

/**
 * The quoted source line an agent should anchor on. Line numbers drift as files are edited;
 * this text does not, so it is worth the extra line of output.
 */
function anchor(lineContent: unknown): string | null {
  const text = String(lineContent ?? "").trim();
  if (!text) return null;
  return text.length > MAX_ANCHOR_LENGTH ? `${text.slice(0, MAX_ANCHOR_LENGTH - 1)}…` : text;
}

export function formatComments(
  comments: readonly FormattedComment[],
  { now = Date.now() }: { now?: number } = {},
): string {
  return comments
    .flatMap((c) => {
      const left = daysUntilPurge(c, now);
      const tag = left === null ? "" : `  (archived — purges in ${left} days)`;
      const lines = [`${c.id}  ${c.file}:${c.line}${tag}`];
      const quoted = anchor(c.lineContent);
      if (quoted) lines.push(`    | ${quoted}`);
      lines.push(`    ${c.body}`);
      const n = c.replies?.length ?? 0;
      if (n) lines.push(`    (${n} ${n === 1 ? "reply" : "replies"})`);
      return lines;
    })
    .join("\n");
}

/**
 * Shown when the filter matched nothing, so a filtered-empty result never reads as breakage.
 * A non-empty list that filters to nothing always leaves the other status populated, since
 * `open` and `resolved` are the only two — hence no "no comments at all" case below.
 */
export function emptyMessage(
  allComments: readonly Pick<FormattedComment, "status">[],
  status: CommentFilterStatus,
): string {
  if (!allComments.length) return "no comments";
  const other = status === "open" ? "resolved" : "open";
  const hidden = allComments.filter((c) => c.status === other).length;
  return `no ${status} comments (${hidden} ${other} — see --status all)`;
}
