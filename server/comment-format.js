/** Filtering and rendering for review comments. Pure — no I/O, no hub, no process state. */

export const COMMENT_STATUSES = ["open", "resolved", "all"];

const MAX_ANCHOR = 120;

export function filterByStatus(comments, status) {
  return status === "all" ? comments : comments.filter((c) => c.status === status);
}

/**
 * The quoted source line an agent should anchor on. Line numbers drift as files are edited;
 * this text does not, so it is worth the extra line of output.
 */
function anchor(lineContent) {
  const text = String(lineContent ?? "").trim();
  if (!text) return null;
  return text.length > MAX_ANCHOR ? `${text.slice(0, MAX_ANCHOR - 1)}…` : text;
}

export function formatComments(comments) {
  return comments
    .flatMap((c) => {
      const lines = [`${c.id}  ${c.file}:${c.line}`];
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
export function emptyMessage(allComments, status) {
  if (!allComments.length) return "no comments";
  const other = status === "open" ? "resolved" : "open";
  const hidden = allComments.filter((c) => c.status === other).length;
  return `no ${status} comments (${hidden} ${other} — see --status all)`;
}
