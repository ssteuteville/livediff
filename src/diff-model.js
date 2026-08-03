/**
 * Turn a diff payload into one flat list of rows.
 *
 * A diff is naturally a list of lists — files containing hunks containing lines — but rendering
 * it that way makes virtualization hard: nested scroll math, per-file measurement, and sticky
 * headers all become special cases. Flattened, a 500-file diff and a single 20,000-line file are
 * the same problem: an indexed array where row N has a known height.
 *
 * Pure: no DOM, no React, no measurement. Heights are computed analytically from a monospace
 * character width, so total document height is exact on the first frame and the scrollbar never
 * lies. That is the whole reason this can virtualize without feeling like it virtualizes.
 */

export const ROW = {
  FILE: "file",
  HUNK: "hunk",
  LINE: "line",
  SPACER: "spacer",
};

const LINE_TYPE = { "+": "add", "-": "del", " ": "ctx" };

/**
 * Parse a unified diff patch into hunks of typed lines.
 *
 * Only the body matters — git already decided what changed, so this is transcription, not diffing.
 * Lines before the first `@@` are the file header, which the caller already has structured data for.
 */
export function parsePatch(patch) {
  const hunks = [];
  if (!patch) return hunks;

  let current = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = m ? Number(m[1]) : 1;
      newNo = m ? Number(m[2]) : 1;
      current = { header: raw, context: m ? m[3].trim() : "", lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // still in the file header
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const type = LINE_TYPE[raw[0]];
    if (!type) continue; // trailing blank from the split, or an unexpected marker

    const text = raw.slice(1);
    if (type === "add") {
      current.lines.push({ type, oldNo: null, newNo: newNo++, text });
    } else if (type === "del") {
      current.lines.push({ type, oldNo: oldNo++, newNo: null, text });
    } else {
      current.lines.push({ type, oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return hunks;
}

/**
 * Pair deletions with additions so a modified line occupies one row instead of two.
 *
 * Split mode produces fewer rows than unified for exactly this reason — a measured 20,000 against
 * 30,000 on the same diff — which is worth knowing because the intuition runs the other way.
 */
function pairLines(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type !== "del") {
      rows.push({ left: line.type === "add" ? null : line, right: line.type === "del" ? null : line });
      i++;
      continue;
    }
    // Collect the run of deletions, then the run of additions that follows, and zip them.
    const dels = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    const adds = [];
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/**
 * Flatten a diff into rows. `mode` is "unified" or "split".
 *
 * Every row carries the file it belongs to so search results, comment anchoring, and sticky
 * headers can all be answered from a row alone, without walking back up a tree.
 */
export function buildRows(files, mode = "split") {
  const rows = [];

  for (const file of files) {
    rows.push({ kind: ROW.FILE, file, key: `f:${file.path}` });

    if (file.binary) {
      rows.push({ kind: ROW.SPACER, file, text: "Binary file not shown", key: `b:${file.path}` });
      continue;
    }

    for (const [h, hunk] of parsePatch(file.patch).entries()) {
      rows.push({ kind: ROW.HUNK, file, text: hunk.header, context: hunk.context, key: `h:${file.path}:${h}` });

      if (mode === "unified") {
        for (const [i, line] of hunk.lines.entries()) {
          rows.push({
            kind: ROW.LINE,
            file,
            type: line.type,
            oldNo: line.oldNo,
            newNo: line.newNo,
            text: line.text,
            key: `l:${file.path}:${h}:${i}`,
          });
        }
        continue;
      }

      for (const [i, pair] of pairLines(hunk.lines).entries()) {
        rows.push({
          kind: ROW.LINE,
          file,
          left: pair.left,
          right: pair.right,
          type: pair.left && pair.right ? (pair.left === pair.right ? "ctx" : "mod") : pair.left ? "del" : "add",
          key: `l:${file.path}:${h}:${i}`,
        });
      }
    }
  }

  return rows;
}

/** The longest text a row will render, which is what decides how many display lines it wraps to. */
function widestText(row, mode) {
  if (row.kind !== ROW.LINE) return "";
  if (mode === "unified") return row.text ?? "";
  const left = row.left?.text?.length ?? 0;
  const right = row.right?.text?.length ?? 0;
  return left >= right ? (row.left?.text ?? "") : (row.right?.text ?? "");
}

/**
 * Row height in pixels, computed rather than measured.
 *
 * With a monospace font the number of display lines a row wraps to is `ceil(chars / charsPerLine)`
 * — exact, and available before anything is in the DOM. That is what lets the scroll container
 * know its true height immediately instead of growing as rows are measured, which is the usual
 * tell that a list is virtualized.
 *
 * `measured` overrides for rows whose height genuinely cannot be derived — an expanded comment
 * thread, mainly.
 */
export function rowHeight(row, metrics) {
  const { lineHeight, charsPerLine, fileHeaderHeight, hunkHeaderHeight, wrap, measured } = metrics;

  const override = measured?.get(row.key);
  if (override !== undefined) return override;

  if (row.kind === ROW.FILE) return fileHeaderHeight;
  if (row.kind === ROW.HUNK) return hunkHeaderHeight;
  if (row.kind === ROW.SPACER) return lineHeight * 3;

  if (!wrap || !charsPerLine || charsPerLine < 1) return lineHeight;
  const chars = widestText(row, metrics.mode).length;
  return lineHeight * Math.max(1, Math.ceil(chars / charsPerLine));
}

/**
 * Running offsets for every row, plus the total. One pass, and the result supports binary search
 * for "which row is at scrollTop" — the two things a virtualizer needs.
 */
export function buildOffsets(rows, metrics) {
  const offsets = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) {
    offsets[i + 1] = offsets[i] + rowHeight(rows[i], metrics);
  }
  return offsets;
}

/** Index of the last row starting at or before `y`. Binary search over the offset table. */
export function rowAt(offsets, y) {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Rows intersecting the viewport, padded by `overscan` rows on each side so scrolling does not
 * reveal blank space before React commits.
 */
export function visibleRange(offsets, scrollTop, viewportHeight, overscan = 8) {
  const count = offsets.length - 1;
  if (count === 0) return { start: 0, end: 0 };
  const first = rowAt(offsets, scrollTop);
  const last = rowAt(offsets, scrollTop + viewportHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan + 1),
  };
}

// ─── Search ──────────────────────────────────────────────────────────────────

/** Every piece of text a row displays, so a match can be found without touching the DOM. */
function searchableText(row) {
  if (row.kind === ROW.FILE) return [row.file.path];
  if (row.kind === ROW.HUNK) return [row.context ?? ""];
  if (row.kind !== ROW.LINE) return [];
  if (row.text !== undefined) return [row.text];
  return [row.left?.text ?? "", row.right?.text ?? ""];
}

/** Build a matcher, treating an invalid regex as "no matches" rather than throwing at the caller. */
function matcher(query, { regex, caseSensitive }) {
  if (!query) return null;
  if (!regex) {
    const needle = caseSensitive ? query : query.toLowerCase();
    return (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle);
  }
  try {
    const re = new RegExp(query, caseSensitive ? "" : "i");
    return (text) => re.test(text);
  } catch {
    return () => false;
  }
}

/**
 * Row indices matching `query`.
 *
 * Searching the model rather than the DOM is what makes this work at all under virtualization —
 * the text of an unrendered row is still right here. It also buys things find-in-page cannot do:
 * `scope` narrows to added or removed lines only, and matches carry their file, so results can be
 * grouped and counted per file.
 */
export function searchRows(rows, query, { regex = false, caseSensitive = false, scope = "all" } = {}) {
  const test = matcher(query, { regex, caseSensitive });
  if (!test) return [];

  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (scope !== "all") {
      if (row.kind !== ROW.LINE) continue;
      const isAdd = row.type === "add" || row.type === "mod";
      const isDel = row.type === "del" || row.type === "mod";
      if (scope === "added" && !isAdd) continue;
      if (scope === "removed" && !isDel) continue;
    }
    if (searchableText(row).some((t) => t && test(t))) {
      hits.push({ index: i, path: row.file?.path ?? null });
    }
  }
  return hits;
}

/** Match counts per file, for a result summary the browser's own find cannot produce. */
export function countByFile(hits) {
  const counts = new Map();
  for (const hit of hits) {
    if (!hit.path) continue;
    counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
  }
  return counts;
}

/** Wrap-around navigation: the next hit at or after `from`, cycling to the start at the end. */
export function nextHit(hits, from, direction = 1) {
  if (!hits.length) return null;
  if (direction > 0) {
    const found = hits.findIndex((h) => h.index > from);
    return found === -1 ? 0 : found;
  }
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].index < from) return i;
  return hits.length - 1;
}
