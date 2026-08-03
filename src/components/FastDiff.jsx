import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROW, buildRows, searchRows, countByFile, nextHit } from "../diff-model.js";
import { useTextMetrics, useVirtualRows, useScrollAnchor } from "../hooks/useVirtualRows.js";
import DiffSearch from "./DiffSearch.jsx";
import CommentThread from "./CommentThread.jsx";
import CommentComposer from "./CommentComposer.jsx";

const GUTTER = "w-12 shrink-0 select-none text-right text-neutral-400";

const GAP = {
  add: "bg-green-50 dark:bg-green-500/10",
  del: "bg-red-50 dark:bg-red-500/10",
  mod: "",
  ctx: "",
};

const STATUS_STYLES = {
  added: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300",
  deleted: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  modified: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  renamed: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
};

/** Split a line into the parts before, inside, and after a match, for highlighting. */
function highlight(text, query, { regex, caseSensitive }) {
  if (!query) return null;
  try {
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(pattern, caseSensitive ? "" : "i");
    const m = re.exec(text);
    if (!m || !m[0]) return null;
    return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
  } catch {
    return null;
  }
}

function LineText({ text, query, options }) {
  const parts = highlight(text ?? "", query, options);
  if (!parts) return <span className="whitespace-pre-wrap break-all">{text}</span>;
  const [before, match, after] = parts;
  return (
    <span className="whitespace-pre-wrap break-all">
      {before}
      <mark className="rounded-sm bg-amber-300 text-black dark:bg-amber-400">{match}</mark>
      {after}
    </span>
  );
}

function Side({ line, kind, query, options, onAdd }) {
  const bg = kind === "add" ? GAP.add : kind === "del" ? GAP.del : "";
  return (
    <div className={"group flex min-w-0 flex-1 " + bg}>
      <span className={GUTTER}>{line?.oldNo ?? line?.newNo ?? ""}</span>
      <span className="w-4 shrink-0 select-none text-center text-neutral-400">
        {kind === "add" ? "+" : kind === "del" ? "−" : ""}
      </span>
      <div className="min-w-0 flex-1 pr-2">
        {line ? <LineText text={line.text} query={query} options={options} /> : null}
      </div>
      {line && onAdd && (
        <button
          type="button"
          onClick={() => onAdd(line)}
          className="invisible shrink-0 px-1 text-xs text-blue-600 group-hover:visible dark:text-blue-400"
          title="Comment on this line"
        >
          +
        </button>
      )}
    </div>
  );
}

function FileHeader({ file }) {
  return (
    <div className="flex h-full items-center gap-2 border-y border-neutral-200 bg-neutral-50 px-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <span
        className={
          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase " +
          (STATUS_STYLES[file.status] || STATUS_STYLES.modified)
        }
      >
        {file.status}
      </span>
      <span className="truncate font-mono text-neutral-800 dark:text-neutral-100">{file.path}</span>
      {file.additions > 0 && <span className="text-xs text-green-600 dark:text-green-400">+{file.additions}</span>}
      {file.deletions > 0 && <span className="text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>}
    </div>
  );
}

/**
 * A virtualized diff renderer.
 *
 * Renders only the rows in view — roughly fifty, whatever the diff's size — against a scroll
 * container whose height is known exactly up front, because row heights are computed from the
 * monospace character width rather than measured. Find is in-app for the same reason the DOM is
 * small: the browser's own find cannot see rows that are not there.
 */
export default function FastDiff({ diff, comments, mode, onAddComment, onCommentAction }) {
  const scrollRef = useRef(null);
  const surfaceRef = useRef(null);
  const [composing, setComposing] = useState(null);
  const [measured] = useState(() => new Map());

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState({ regex: false, caseSensitive: false, scope: "all" });
  const [active, setActive] = useState(0);

  const text = useTextMetrics(surfaceRef);

  const rows = useMemo(() => buildRows(diff?.files ?? [], mode), [diff, mode]);

  const commentsByFile = useMemo(() => {
    const map = new Map();
    for (const c of comments ?? []) {
      if (!map.has(c.file)) map.set(c.file, []);
      map.get(c.file).push(c);
    }
    return map;
  }, [comments]);

  // Gutter and marker columns are fixed; the rest of the width is what text wraps within.
  const charsPerLine = useMemo(() => {
    const chrome = 4 * 16 + 2 * 16;
    const usable = Math.max(0, text.width - chrome) / (mode === "split" ? 2 : 1);
    return Math.max(20, Math.floor(usable / (text.charWidth || 8)));
  }, [text, mode]);

  const metrics = useMemo(
    () => ({
      lineHeight: text.lineHeight,
      charsPerLine,
      fileHeaderHeight: 40,
      hunkHeaderHeight: 26,
      wrap: true,
      mode,
      measured,
    }),
    [text.lineHeight, charsPerLine, mode, measured]
  );

  const { range, offsets, totalHeight, scrollToRow } = useVirtualRows({
    rows,
    metrics,
    containerRef: scrollRef,
  });

  useScrollAnchor({ rows, containerRef: scrollRef, offsets, deps: [diff] });

  const hits = useMemo(() => searchRows(rows, query, options), [rows, query, options]);
  const fileCount = useMemo(() => countByFile(hits).size, [hits]);

  useEffect(() => setActive(0), [query, options]);

  useEffect(() => {
    if (hits.length) scrollToRow(hits[Math.min(active, hits.length - 1)].index);
  }, [hits, active, scrollToRow]);

  const navigate = useCallback(
    (direction) => {
      if (!hits.length) return;
      const from = hits[active]?.index ?? -1;
      const next = nextHit(hits, from, direction);
      if (next !== null) setActive(next);
    },
    [hits, active]
  );

  // Cmd+F is bound deliberately: the browser's find would only see the rows in view and silently
  // report far fewer matches than exist, which is worse than replacing it outright.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeIndex = hits[active]?.index ?? -1;
  const slice = [];
  for (let i = range.start; i < range.end; i++) slice.push(i);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {searchOpen && (
        <DiffSearch
          query={query}
          onQuery={setQuery}
          options={options}
          onOptions={setOptions}
          hits={hits}
          active={active}
          fileCount={fileCount}
          onNavigate={navigate}
          onClose={() => {
            setSearchOpen(false);
            setQuery("");
          }}
        />
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div ref={surfaceRef} className="relative font-mono text-[13px] leading-5" style={{ height: totalHeight }}>
          {slice.map((i) => {
            const row = rows[i];
            const top = offsets[i];
            const height = offsets[i + 1] - top;
            const isActive = i === activeIndex;

            if (row.kind === ROW.FILE) {
              return (
                <div key={row.key} className="absolute inset-x-0" style={{ top, height }}>
                  <FileHeader file={row.file} />
                </div>
              );
            }

            if (row.kind === ROW.HUNK) {
              return (
                <div
                  key={row.key}
                  className="absolute inset-x-0 flex items-center bg-blue-50/60 px-3 text-[11px] text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"
                  style={{ top, height }}
                >
                  {row.text}
                </div>
              );
            }

            if (row.kind === ROW.SPACER) {
              return (
                <div
                  key={row.key}
                  className="absolute inset-x-0 flex items-center justify-center text-sm text-neutral-500"
                  style={{ top, height }}
                >
                  {row.text}
                </div>
              );
            }

            const ring = isActive ? "ring-2 ring-inset ring-amber-400" : "";
            const onAdd = (line) =>
              setComposing({ file: row.file.path, line: line.newNo ?? line.oldNo, side: line.newNo ? "new" : "old", text: line.text });

            if (mode === "unified") {
              return (
                <div key={row.key} className={"absolute inset-x-0 flex " + ring} style={{ top, height }}>
                  <Side line={row} kind={row.type} query={query} options={options} onAdd={onAdd} />
                </div>
              );
            }

            return (
              <div key={row.key} className={"absolute inset-x-0 flex " + ring} style={{ top, height }}>
                <Side
                  line={row.left}
                  kind={row.left && !row.right ? "del" : row.type === "mod" ? "del" : "ctx"}
                  query={query}
                  options={options}
                  onAdd={onAdd}
                />
                <div className="w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />
                <Side
                  line={row.right}
                  kind={row.right && !row.left ? "add" : row.type === "mod" ? "add" : "ctx"}
                  query={query}
                  options={options}
                  onAdd={onAdd}
                />
              </div>
            );
          })}
        </div>
      </div>

      {composing && (
        <div className="border-t border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
          <CommentComposer
            onCancel={() => setComposing(null)}
            onSubmit={(body) => {
              onAddComment({
                file: composing.file,
                side: composing.side,
                line: composing.line,
                lineContent: composing.text,
                body,
              });
              setComposing(null);
            }}
          />
        </div>
      )}

      {(comments ?? []).some((c) => c.status === "open") && (
        <details className="max-h-64 shrink-0 overflow-auto border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-300">
            {(comments ?? []).filter((c) => c.status === "open").length} open comments
          </summary>
          <div className="px-3 pb-3">
            {[...commentsByFile.entries()].map(([path, list]) => (
              <div key={path} className="mb-2">
                <div className="py-1 font-mono text-[11px] text-neutral-500">{path}</div>
                <CommentThread
                  comments={list}
                  onResolve={(id) => onCommentAction(id, { status: "resolved" })}
                  onReopen={(id) => onCommentAction(id, { status: "open" })}
                  onDelete={(id) => onCommentAction(id, { delete: true })}
                  onReply={(id, body) => onCommentAction(id, { reply: { author: "user", body } })}
                />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
