import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  ROW,
  buildRows,
  searchRows,
  countByFile,
  nextHit,
  anchoredCommentIds,
} from "../diff-model.js";
import type {
  CommentRow,
  DiffLine,
  DiffMode,
  SearchOptions,
  SplitLineRow,
  UnifiedLineRow,
} from "../diff-model.js";
import type { NewComment } from "../api.ts";
import type { Comment, Diff, DiffFile, Reply } from "../../shared/types.ts";
import CommentDrawer from "./CommentDrawer.tsx";
import { useTextMetrics, useVirtualRows, useScrollAnchor } from "../hooks/useVirtualRows.ts";
import { loadGrammar, tokenize } from "../syntax.js";
import type { Token } from "../syntax.js";
import {
  COMMENT_ROW_LINES,
  COMMENT_ROW_CHROME_PX,
  COMMENT_CARD_INSET_PX,
  COMMENT_REPLY_STRIP_PX,
  COMMENT_EXPANDED_MAX_PX,
} from "../../shared/constants.ts";
import DiffSearch from "./DiffSearch.tsx";
import CommentThread, { CommentThreadPreview, ThreadHeader } from "./CommentThread.tsx";
import CommentComposer from "./CommentComposer.tsx";

type CommentAction = Partial<Pick<Comment, "status">> & {
  delete?: boolean;
  reply?: Pick<Reply, "author" | "body">;
};

interface FastDiffProps {
  diff: Diff | null;
  comments: Comment[];
  mode: DiffMode;
  jump: { path: string; nonce: number } | null;
  showAll: number;
  onAddComment: (input: NewComment) => void | Promise<void>;
  onCommentAction: (id: Comment["id"], action: CommentAction) => void | Promise<void>;
}

interface MatchRange {
  start: number;
  end: number;
}

interface MarkedToken extends Token {
  marked?: boolean;
}

type DisplayLine = DiffLine | UnifiedLineRow;
type ComposeState = {
  rowKey: string;
  file: string;
  line: number;
  side: Comment["side"];
  text: string;
};
type ExpandedState = { key: string; reply: boolean };
type DrawerState = { path: string | null };

const GUTTER = "w-12 shrink-0 select-none text-right text-neutral-400";

const GAP = {
  add: "bg-green-50 dark:bg-green-500/10",
  del: "bg-red-50 dark:bg-red-500/10",
  mod: "",
  ctx: "",
};

const MARKER: Partial<Record<"add" | "del" | "ctx", string>> = { add: "+", del: "−" };

const STATUS_STYLES = {
  added: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300",
  deleted: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  modified: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  renamed: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  copied: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
} satisfies Record<DiffFile["status"], string>;

/** The character range a search matches within a line, or null. */
function matchRange(
  text: string,
  query: string,
  { regex, caseSensitive }: SearchOptions,
): MatchRange | null {
  if (!query) return null;
  try {
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(pattern, caseSensitive ? "" : "i").exec(text);
    if (!m || !m[0]) return null;
    return { start: m.index, end: m.index + m[0].length };
  } catch {
    return null;
  }
}

/**
 * Cut syntax tokens at the search match, so a line can be coloured and marked at once.
 *
 * Doing it on the token stream rather than the text is what keeps highlighting from being an
 * either/or with find: a match landing mid-token splits that token instead of replacing the line.
 */
function splitAtMatch(tokens: readonly Token[], range: MatchRange | null): MarkedToken[] {
  if (!range) return tokens.map((token) => ({ ...token }));
  const out: MarkedToken[] = [];
  let pos = 0;
  for (const token of tokens) {
    const start = pos;
    const end = (pos += token.text.length);
    if (range.end <= start || range.start >= end) {
      out.push(token);
      continue;
    }
    const from = Math.max(start, range.start) - start;
    const to = Math.min(end, range.end) - start;
    if (from > 0) out.push({ text: token.text.slice(0, from), cls: token.cls });
    out.push({ text: token.text.slice(from, to), cls: token.cls, marked: true });
    if (to < token.text.length) out.push({ text: token.text.slice(to), cls: token.cls });
  }
  return out;
}

function TokenSpan({ token }: { token: MarkedToken }) {
  if (token.marked) {
    return (
      <mark className={"rounded-sm bg-amber-300 text-black dark:bg-amber-400 " + token.cls}>
        {token.text}
      </mark>
    );
  }
  return token.cls ? <span className={token.cls}>{token.text}</span> : token.text;
}

function LineText({
  text,
  lang,
  query,
  options,
}: {
  text: string;
  lang: string;
  query: string;
  options: SearchOptions;
}) {
  const value = text ?? "";
  const range = matchRange(value, query, options);
  const tokens = tokenize(value, lang) ?? [{ text: value, cls: "" }];
  const parts = splitAtMatch(tokens, range);
  return (
    <span className="whitespace-pre-wrap break-all">
      {parts.map((token, i) => (
        <TokenSpan key={i} token={token} />
      ))}
    </span>
  );
}

function Side({
  line,
  lang,
  kind,
  query,
  options,
  onAdd,
}: {
  line: DisplayLine | null;
  lang: string;
  kind: "add" | "del" | "ctx";
  query: string;
  options: SearchOptions;
  onAdd: ((line: DisplayLine) => void) | undefined;
}) {
  const bg = kind === "add" ? GAP.add : kind === "del" ? GAP.del : "";
  return (
    <div className={"group flex min-w-0 flex-1 " + bg}>
      <span className={GUTTER}>{line?.oldNo ?? line?.newNo ?? ""}</span>
      <span className="w-4 shrink-0 select-none text-center text-neutral-400">
        {MARKER[kind] ?? ""}
      </span>
      <div className="min-w-0 flex-1 pr-2">
        {line ? <LineText text={line.text} lang={lang} query={query} options={options} /> : null}
      </div>
      {line && onAdd && (
        <button
          type="button"
          data-add-comment
          onClick={() => onAdd(line)}
          className="mr-1 mt-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded bg-blue-600 text-sm font-semibold leading-none text-white shadow-sm transition hover:bg-blue-700 group-hover:flex focus-visible:flex"
          title="Comment on this line"
          aria-label="Comment on this line"
        >
          +
        </button>
      )}
    </div>
  );
}

/** In split mode a paired row shows a deletion on the left and an addition on the right. */
function sideKind(row: SplitLineRow, which: "left" | "right"): "add" | "del" | "ctx" {
  const line = which === "left" ? row.left : row.right;
  const opposite = which === "left" ? row.right : row.left;
  if (!line) return "ctx";
  if (!opposite) return which === "left" ? "del" : "add";
  if (row.type === "mod") return which === "left" ? "del" : "add";
  return "ctx";
}

/**
 * A collapsed thread: the expanded card, drawn and clipped.
 *
 * Nothing inside is a real control — the whole slot is one click target, and where you click
 * decides what the expanded thread opens into. Clicking the painted reply box opens it with the
 * reply field focused, which is the only reason the illusion needs to be pixel-accurate.
 */
function CommentSlot({
  row,
  lines,
  hidden,
  onOpen,
}: {
  row: CommentRow;
  lines: number;
  hidden: boolean;
  onOpen: (toReply: boolean) => void;
}) {
  const open = (e: MouseEvent<HTMLDivElement>) =>
    onOpen(e.target instanceof Element && Boolean(e.target.closest("[data-reply-placeholder]")));

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(false);
        }
      }}
      className={
        "h-full cursor-pointer font-sans transition hover:brightness-[0.98] " +
        (hidden ? "invisible" : "")
      }
    >
      <CommentThreadPreview
        comments={row.comments}
        lines={lines}
        file={row.file.path}
        line={row.line}
      />
    </div>
  );
}

function FileHeader({
  file,
  comments,
  hidden,
  onShowComments,
}: {
  file: DiffFile;
  comments: number;
  hidden: number;
  onShowComments: (path: string) => void;
}) {
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
      {file.additions > 0 && (
        <span className="text-xs text-green-600 dark:text-green-400">+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span className="text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>
      )}
      {comments > 0 && (
        <button
          type="button"
          onClick={() => onShowComments(file.path)}
          className={
            "ml-auto shrink-0 rounded px-2 py-0.5 font-sans text-[11px] font-medium " +
            (hidden > 0
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-300"
              : "text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800")
          }
          title={hidden > 0 ? `${hidden} not shown in this diff` : "See all comments on this file"}
        >
          {comments} comment{comments === 1 ? "" : "s"}
          {hidden > 0 && ` · ${hidden} hidden`}
        </button>
      )}
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
export default function FastDiff({
  diff,
  comments,
  mode,
  jump,
  showAll,
  onAddComment,
  onCommentAction,
}: FastDiffProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState<ComposeState | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [measured] = useState(() => new Map<string, number>());

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>({
    regex: false,
    caseSensitive: false,
    scope: "all",
  });
  const [active, setActive] = useState(0);

  const text = useTextMetrics(surfaceRef);

  const rows = useMemo(() => buildRows(diff?.files ?? [], mode, comments), [diff, mode, comments]);

  const anchored = useMemo(() => anchoredCommentIds(rows), [rows]);
  const commentsByFile = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const c of comments) {
      const forFile = map.get(c.file);
      if (forFile) forFile.push(c);
      else map.set(c.file, [c]);
    }
    return map;
  }, [comments]);

  // Gutter and marker columns are fixed; the rest of the width is what text wraps within.
  const charsPerLine = useMemo(() => {
    const chrome = 4 * 16 + 2 * 16;
    const usable = Math.max(0, text.width - chrome) / (mode === "split" ? 2 : 1);
    return Math.max(20, Math.floor(usable / (text.charWidth || 8)));
  }, [text, mode]);

  // A comment card spans the whole width, unlike a diff line, and is set in proportional text.
  const commentCharsPerLine = useMemo(
    () =>
      Math.max(20, Math.floor((text.width - COMMENT_CARD_INSET_PX) / (text.proseCharWidth || 7))),
    [text.width, text.proseCharWidth],
  );

  const metrics = useMemo(
    () => ({
      lineHeight: text.lineHeight,
      charsPerLine,
      fileHeaderHeight: 40,
      hunkHeaderHeight: 26,
      commentCharsPerLine,
      commentLines: COMMENT_ROW_LINES,
      commentChrome: COMMENT_ROW_CHROME_PX,
      commentReplyStrip: COMMENT_REPLY_STRIP_PX,
      wrap: true,
      mode,
      measured,
    }),
    [text.lineHeight, charsPerLine, commentCharsPerLine, mode, measured],
  );

  const { range, offsets, totalHeight, scrollToRow } = useVirtualRows({
    rows,
    metrics,
    containerRef: scrollRef,
  });

  useScrollAnchor({ rows, containerRef: scrollRef, offsets });

  // Grammars are fetched for what is on screen, not for the diff — scrolling into a Rust file is
  // what pays for the Rust grammar. Joined into a string so the effect sees a stable dependency
  // across the scroll frames that leave the visible languages unchanged.
  const [, syntaxLoaded] = useReducer((n) => n + 1, 0);
  const visibleLangs = useMemo(() => {
    const langs = new Set<string>();
    for (let i = range.start; i < range.end; i++) {
      const row = rows[i];
      if (row?.file.lang) langs.add(row.file.lang);
    }
    return [...langs].sort().join(" ");
  }, [rows, range]);

  useEffect(() => {
    if (!visibleLangs) return;
    let live = true;
    Promise.all(visibleLangs.split(" ").map(loadGrammar)).then((added) => {
      if (live && added.some(Boolean)) syntaxLoaded();
    });
    return () => {
      live = false;
    };
  }, [visibleLangs]);

  // Selecting a file in the rail scrolls to its header. Keyed on the nonce, not the path, so
  // picking the same file twice scrolls again rather than doing nothing.
  useEffect(() => {
    if (!jump?.path) return;
    const index = rows.findIndex((r) => r.kind === ROW.FILE && r.file.path === jump.path);
    if (index !== -1) scrollToRow(index, { align: "start" });
  }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showAll) setDrawer({ path: null });
  }, [showAll]);

  const hits = useMemo(() => searchRows(rows, query, options), [rows, query, options]);
  const fileCount = useMemo(() => countByFile(hits).size, [hits]);

  useEffect(() => setActive(0), [query, options]);

  useEffect(() => {
    const hit = hits[Math.min(active, hits.length - 1)];
    if (hit) scrollToRow(hit.index);
  }, [hits, active, scrollToRow]);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (!hits.length) return;
      const from = hits[active]?.index ?? -1;
      const next = nextHit(hits, from, direction);
      if (next !== null) setActive(next);
    },
    [hits, active],
  );

  // Cmd+F is bound deliberately: the browser's find would only see the rows in view and silently
  // report far fewer matches than exist, which is worse than replacing it outright.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") {
        setExpanded(null);
        setComposing(null);
        setDrawer(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Overlays are anchored by row key rather than index: a refetch renumbers every row, and an
  // expanded thread that jumped to a different line on save would be worse than not having one.
  const expandedIndex = useMemo(
    () => (expanded ? rows.findIndex((r) => r.key === expanded.key) : -1),
    [expanded, rows],
  );
  const composeIndex = useMemo(
    () => (composing ? rows.findIndex((r) => r.key === composing.rowKey) : -1),
    [composing, rows],
  );

  const activeIndex = hits[active]?.index ?? -1;
  const slice: number[] = [];
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

      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} data-diff-scroll className="min-h-0 flex-1 overflow-auto">
          <div
            ref={surfaceRef}
            className="relative font-mono text-[13px] leading-5"
            style={{ height: totalHeight }}
          >
            {slice.map((i) => {
              const row = rows[i];
              if (!row) return null;
              const top = offsets[i] ?? 0;
              const height = (offsets[i + 1] ?? top) - top;
              const isActive = i === activeIndex;

              if (row.kind === ROW.FILE) {
                const forFile = commentsByFile.get(row.file.path) ?? [];
                return (
                  <div
                    key={row.key}
                    data-row
                    data-row-kind="file"
                    className="absolute inset-x-0"
                    style={{ top, height }}
                  >
                    <FileHeader
                      file={row.file}
                      comments={forFile.length}
                      hidden={forFile.filter((c) => !anchored.has(c.id)).length}
                      onShowComments={(p) => setDrawer({ path: p })}
                    />
                  </div>
                );
              }

              if (row.kind === ROW.HUNK) {
                return (
                  <div
                    key={row.key}
                    data-row
                    data-row-kind="hunk"
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
                    data-row
                    data-row-kind="spacer"
                    className="absolute inset-x-0 flex items-center justify-center text-sm text-neutral-500"
                    style={{ top, height }}
                  >
                    {row.text}
                  </div>
                );
              }

              if (row.kind === ROW.COMMENT) {
                return (
                  <div
                    key={row.key}
                    data-row
                    data-row-kind="comment"
                    data-comment-slot
                    className="absolute inset-x-0"
                    style={{ top, height }}
                  >
                    <CommentSlot
                      row={row}
                      lines={COMMENT_ROW_LINES}
                      hidden={expanded?.key === row.key}
                      onOpen={(toReply) => setExpanded({ key: row.key, reply: toReply })}
                    />
                  </div>
                );
              }

              if (row.kind !== ROW.LINE) return null;

              const ring = isActive ? "ring-2 ring-inset ring-amber-400" : "";
              const onAdd = (line: DisplayLine) => {
                const lineNumber = line.newNo ?? line.oldNo;
                if (lineNumber === null) return;
                setComposing({
                  rowKey: row.key,
                  file: row.file.path,
                  line: lineNumber,
                  side: line.newNo === null ? "old" : "new",
                  text: line.text,
                });
              };

              const lang = row.file.lang;

              if ("text" in row) {
                return (
                  <div
                    key={row.key}
                    data-row
                    data-row-kind="line"
                    className={"absolute inset-x-0 flex " + ring}
                    style={{ top, height }}
                  >
                    <Side
                      line={row}
                      lang={lang}
                      kind={row.type}
                      query={query}
                      options={options}
                      onAdd={onAdd}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={row.key}
                  data-row
                  data-row-kind="line"
                  className={"absolute inset-x-0 flex " + ring}
                  style={{ top, height }}
                >
                  <Side
                    line={row.left}
                    lang={lang}
                    kind={sideKind(row, "left")}
                    query={query}
                    options={options}
                    onAdd={onAdd}
                  />
                  <div className="w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />
                  <Side
                    line={row.right}
                    lang={lang}
                    kind={sideKind(row, "right")}
                    query={query}
                    options={options}
                    onAdd={onAdd}
                  />
                </div>
              );
            })}

            {expanded && rows[expandedIndex]?.kind === ROW.COMMENT && (
              <div
                data-comment-expanded
                // Opaque: the thread's own tint is translucent, and the rows it covers would
                // otherwise read through the expanded card.
                className="absolute inset-x-0 z-20 overflow-auto bg-white font-sans shadow-2xl ring-1 ring-amber-400/60 dark:bg-neutral-900"
                style={{ top: offsets[expandedIndex] ?? 0, maxHeight: COMMENT_EXPANDED_MAX_PX }}
              >
                <CommentThread
                  comments={rows[expandedIndex].comments}
                  startReplying={expanded.reply}
                  header={
                    <ThreadHeader
                      comments={rows[expandedIndex].comments}
                      file={rows[expandedIndex].file.path}
                      line={rows[expandedIndex].line}
                      action={
                        <button
                          type="button"
                          onClick={() => setExpanded(null)}
                          className="rounded px-1 text-[11px] text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                        >
                          collapse
                        </button>
                      }
                    />
                  }
                  onResolve={(id) => onCommentAction(id, { status: "resolved" })}
                  onReopen={(id) => onCommentAction(id, { status: "open" })}
                  onDelete={(id) => onCommentAction(id, { delete: true })}
                  onReply={(id, body) => onCommentAction(id, { reply: { author: "user", body } })}
                />
              </div>
            )}

            {composing && composeIndex !== -1 && (
              <div
                data-comment-composer
                className="absolute inset-x-0 z-20 rounded-md border border-blue-300 bg-white p-2 font-sans shadow-xl dark:border-blue-500/40 dark:bg-neutral-900"
                style={{ top: offsets[composeIndex + 1] }}
              >
                <div className="mb-1 font-mono text-[11px] text-neutral-500">
                  {composing.file}:{composing.line}
                </div>
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
          </div>
        </div>

        {drawer && (
          <CommentDrawer
            path={drawer.path}
            comments={comments}
            anchored={anchored}
            onClose={() => setDrawer(null)}
            onGoTo={(key) => {
              const index = rows.findIndex((r) => r.key === key);
              if (index === -1) return;
              scrollToRow(index);
              setExpanded({ key, reply: false });
            }}
            onCommentAction={onCommentAction}
          />
        )}
      </div>
    </div>
  );
}
