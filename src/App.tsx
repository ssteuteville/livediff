import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Comment, Diff, Reply, Review } from "../shared/types.ts";
import {
  fetchDefaultRenderer,
  type HubEvent,
  type NewComment,
  type WorkspaceSummary,
} from "./api.ts";
import FastDiff from "./components/FastDiff.tsx";
import CommentDrawer from "./components/CommentDrawer.tsx";
import WorkspaceRail from "./components/WorkspaceRail.tsx";
import ReviewBanner from "./components/ReviewBanner.tsx";
import FileTree from "./components/FileTree.tsx";
import type { FileTreeEntry } from "./file-tree.ts";
import { diffTotals, formatBytes } from "./diff-model.ts";
import { RENDERER, RENDERERS, DIFF_REFETCH_DEBOUNCE_MS } from "../shared/constants.ts";
import {
  fetchWorkspaces,
  addWorkspace,
  removeWorkspace,
  setWorkspaceBase,
  resolvePath,
  fetchDiff,
  fetchComments,
  fetchRefs,
  createComment,
  patchComment,
  removeComment,
  fetchReview,
  completeReview,
  subscribe,
} from "./api.ts";

// Lets a test assert which renderers the *served* bundle knows about. A stale build once produced a
// full session of measurements that all described the classic renderer.
if (typeof window !== "undefined") window.__LIVEDIFF_RENDERERS__ = [...RENDERERS];

// The classic renderer pulls in @git-diff-view and every highlight.js grammar — about a megabyte
// the fast renderer never touches. Loading it on demand keeps that off the default path.
const FileDiff = lazy(() => import("./components/FileDiff.tsx"));

// When there is no diff, no comment can be anchored to one.
const NOTHING_ANCHORED: ReadonlySet<string> = new Set();

const COMPARE_FIELD = "w-44 rounded border px-2 py-1 font-mono outline-none focus:border-blue-500 ";

/**
 * A chosen ref changes what the whole page means, so the field has to read as active rather than as
 * an empty box someone typed in. Tinted and bordered when set, plain while it is showing HEAD.
 */
type DiffMode = "split" | "unified";
type CommentFilter = "all" | Comment["status"];
type Theme = "dark" | "light";
type CommentAction = Partial<Pick<Comment, "status">> & {
  delete?: boolean;
  reply?: Pick<Reply, "author" | "body">;
};
type ReviewEvent = HubEvent & { state: "open" | "done" | "cancelled" };

function comparingClass(base: string): string {
  if (base) {
    return (
      COMPARE_FIELD +
      "no-caret pr-6 border-blue-400 bg-blue-50 font-medium text-blue-800 " +
      "dark:border-blue-500/60 dark:bg-blue-500/10 dark:text-blue-200"
    );
  }
  return COMPARE_FIELD + "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800";
}

/**
 * Keep the previous value when a refetch returns the same thing.
 *
 * Every event refetches, and a fresh array from JSON is a new identity even when nothing changed —
 * which invalidates the row model and re-flattens a 20,000-row diff to arrive back where it was.
 * Saving one file broadcasts to every workspace's watchers, so this is the common case, not the
 * rare one. Comparing the serialized form costs a millisecond against rebuilding everything.
 */
function keepIfSame<T>(setState: Dispatch<SetStateAction<T>>): (next: T) => void {
  return (next) =>
    setState((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRenderer(value: string | null): value is (typeof RENDERERS)[number] {
  return value === "classic" || value === "fast";
}

function isReviewEvent(event: HubEvent): event is ReviewEvent {
  return (
    "state" in event &&
    (event.state === "open" || event.state === "done" || event.state === "cancelled")
  );
}

function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme;
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [base, setBase] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [mode, setMode] = useState<DiffMode>("split");
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [flash, setFlash] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jump, setJump] = useState<{ path: string; nonce: number } | null>(null);
  const [showAll, setShowAll] = useState(0);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // Focused mode opens straight into one worktree's diff, where the width matters more than the
  // file list — you already know which worktree you asked for. The hub view keeps it open.
  const [filesCollapsed, setFilesCollapsed] = useState(() => {
    const focus = new URLSearchParams(window.location.search).get("focus");
    return focus !== null && focus !== "0";
  });
  const [configuredRenderer, setConfiguredRenderer] = useState(RENDERER);
  const theme = useTheme();
  const fileRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Deep-link / focused mode via URL params: ?ws=<id> or ?path=<dir> targets a workspace,
  // ?focus=1 hides the workspaces rail and opens straight to it.
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const focusParam = urlParams.get("focus");
  const focused = focusParam !== null && focusParam !== "0";
  // ?dir=<subpath> narrows the view to one directory. It is a filter, not a workspace: comments
  // stay keyed to the worktree, so nothing is hidden from the CLI by scoping the browser.
  const dir = (urlParams.get("dir") || "").replace(/\/+$/, "");
  // ?renderer=classic|fast overrides the build-time default for one tab, so the two can be
  // compared on the same diff without a rebuild. See RENDERER in server/constants.js.
  const requested = urlParams.get("renderer");
  const renderer = isRenderer(requested) ? requested : configuredRenderer;
  const fast = renderer === "fast";

  useEffect(() => {
    if (requested !== null) return;
    void fetchDefaultRenderer()
      .then(setConfiguredRenderer)
      .catch(() => undefined);
  }, [requested]);

  // Mirrors for use inside the once-only SSE subscription.
  const selectedRef = useRef<string | null>(null);
  const baseRef = useRef("");
  selectedRef.current = selected;
  baseRef.current = base;

  const loadWorkspaces = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchWorkspaces();
      keepIfSame(setWorkspaces)(next);
      setLoaded(true);
    } catch {}
  }, []);

  // Saving several files in a row fires several diff events. Only the last answer is worth having,
  // and without this the second-to-last can land after it and put a stale diff on screen.
  const diffRequest = useRef(0);

  // The workspace whose stored base is currently in `base`, and the value the registry is believed
  // to hold for it. A ref, not state: adopting must not trigger a write, and a write must not
  // trigger a re-render. Only ever one entry — the app shows one workspace at a time.
  const adopted = useRef<{ ws: string; base: string } | null>(null);

  // Non-zero while a base is being written. The adopt effect stands down for that window, so a
  // `fetchWorkspaces` already in flight cannot resolve with the pre-write value and rewrite the
  // field out from under whoever is typing in it.
  const writingBase = useRef(0);

  /**
   * Write the base back to the registry.
   *
   * Called when a comparison is committed — leaving the field, pressing Enter, clearing it — and
   * never on every keystroke. It used to fire from a successful diff load on the theory that a
   * loaded diff proved the ref was good. It does not: `git()` on the server returns partial stdout
   * when git exits non-zero, so an unknown ref yields an empty diff and a 200, and typing "main"
   * would persist "m", "ma", "mai" on the way. A stored ref that resolves to nothing hides every
   * comment in the worktree, which is the exact failure this base field exists to prevent. The
   * server now rejects a ref it cannot resolve; this reports that rather than swallowing it.
   */
  const persistBase = useCallback(
    (ws: string, b: string): void => {
      const at = adopted.current;
      if (at === null || at.ws !== ws || at.base === b) return;
      adopted.current = { ws, base: b };
      writingBase.current++;
      void setWorkspaceBase(ws, b || null)
        .catch((cause: unknown) => {
          // Put the old value back so a later attempt can retry; leaving the optimistic one would
          // make the registry and this tab disagree silently for as long as the tab stayed open.
          adopted.current = { ws, base: at.base };
          setError(errorMessage(cause));
        })
        .finally(() => {
          writingBase.current--;
          void loadWorkspaces();
        });
    },
    [loadWorkspaces],
  );

  const commitBase = useCallback(() => {
    if (selected) persistBase(selected, base);
  }, [persistBase, selected, base]);

  const loadDiff = useCallback(async (ws: string | null, b: string): Promise<void> => {
    if (!ws) {
      setDiff(null);
      return;
    }
    const request = ++diffRequest.current;
    try {
      const next = await fetchDiff(ws, b || undefined);
      if (request === diffRequest.current) keepIfSame(setDiff)(next);
    } catch (cause: unknown) {
      if (request === diffRequest.current) setError(errorMessage(cause));
    }
  }, []);

  const loadComments = useCallback(async (ws: string | null): Promise<void> => {
    if (!ws) {
      setComments([]);
      return;
    }
    try {
      keepIfSame(setComments)(await fetchComments(ws));
    } catch {}
  }, []);

  // A save that touches twenty files arrives as twenty events. Coalesce them into one fetch.
  const diffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refetchDiffSoon = useCallback(() => {
    clearTimeout(diffTimer.current);
    diffTimer.current = setTimeout(
      () => void loadDiff(selectedRef.current, baseRef.current),
      DIFF_REFETCH_DEBOUNCE_MS,
    );
  }, [loadDiff]);

  useEffect(() => () => clearTimeout(diffTimer.current), []);

  const loadReview = useCallback(async (ws: string | null): Promise<void> => {
    if (!ws) {
      setReview(null);
      return;
    }
    try {
      setReview(await fetchReview(ws));
    } catch {
      setReview(null);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Preselect from the URL (?ws=<id> or ?path=<dir>).
  useEffect(() => {
    const ws = urlParams.get("ws");
    const path = urlParams.get("path");
    if (ws) setSelected(ws);
    else if (path)
      void (async () => {
        try {
          setSelected((await resolvePath(path)).id);
        } catch {}
      })();
  }, [urlParams]);

  // Keep a valid selection as the workspace list changes.
  useEffect(() => {
    // "Not fetched yet" is not "there are none". Without this the empty first render clears the
    // selection a ?ws= deep link just made, and the list arriving falls back to workspaces[0] —
    // so deep links silently opened whichever workspace happened to be first.
    if (!loaded) return;
    if (workspaces.length === 0) {
      if (!focused) setSelected(null);
      return;
    }
    if (selected && workspaces.some((w) => w.id === selected)) return;
    if (focused) return; // focused mode targets a specific workspace via URL; no fallback
    const firstWorkspace = workspaces[0];
    if (firstWorkspace) setSelected(firstWorkspace.id);
  }, [workspaces, selected, focused, loaded]);

  // The base belongs to the worktree, not to this tab. Adopt the stored one when a workspace is
  // selected, so a browser opened after `livediff --base main` shows the same comparison the CLI
  // and the background sweep are already using.
  //
  // Keyed on the stored value rather than on the workspace id alone, so `livediff open --base main`
  // run while this tab is open moves the tab too — the registry write broadcasts, the list
  // refreshes, and this re-adopts. A base this tab just wrote is already recorded as adopted, so
  // that round trip does not fight the field the user is typing in.
  useEffect(() => {
    if (!selected || writingBase.current > 0) return;
    const ws = workspaces.find((w) => w.id === selected);
    if (!ws) return;
    const stored = ws.base ?? "";
    if (adopted.current?.ws === selected && adopted.current.base === stored) return;
    adopted.current = { ws: selected, base: stored };
    setBase(stored);
  }, [selected, workspaces]);

  useEffect(() => {
    // A highlight left over from the previous workspace would point at a file that is no longer
    // on screen. The diff renderer reports the real one as soon as it has rows.
    setActiveFile(null);
    void loadDiff(selected, base);
    void loadComments(selected);
    void loadReview(selected);
  }, [selected, base, loadDiff, loadComments, loadReview]);

  // Branch list for the compare-against picker. Keyed on the workspace only: branches change far
  // less often than the diff, and refetching them on every base change would be pure noise.
  useEffect(() => {
    if (!selected) {
      setRefs([]);
      return;
    }
    void (async () => {
      try {
        keepIfSame(setRefs)(await fetchRefs(selected));
      } catch {}
    })();
  }, [selected]);

  useEffect(() => {
    return subscribe({
      onWorkspaces: () => void loadWorkspaces(),
      onDiff: (event) => {
        const { ws } = event;
        void loadWorkspaces();
        if (ws === selectedRef.current) {
          refetchDiffSoon();
          setFlash(true);
          setTimeout(() => setFlash(false), 900);
        }
      },
      onComments: (event) => {
        const { ws } = event;
        void loadWorkspaces();
        if (ws === selectedRef.current) void loadComments(selectedRef.current);
      },
      onReview: (event) => {
        if (!isReviewEvent(event)) return;
        const { ws, state } = event;
        if (ws !== selectedRef.current) return;
        if (state === "open") void loadReview(selectedRef.current);
        else setReview(null);
      },
    });
  }, [loadWorkspaces, refetchDiffSoon, loadComments, loadReview]);

  const onDoneReviewing = useCallback(
    () =>
      review === null
        ? Promise.resolve()
        : completeReview(review.reviewId)
            .then(() => setReview(null))
            .catch(() => {}),
    [review],
  );

  const onAddWorkspace = useCallback(
    (path: string) =>
      addWorkspace(path)
        .then(loadWorkspaces)
        .catch((cause: unknown) => setError(errorMessage(cause))),
    [loadWorkspaces],
  );
  const onRemoveWorkspace = useCallback(
    (id: string) =>
      removeWorkspace(id)
        .then(loadWorkspaces)
        .catch(() => {}),
    [loadWorkspaces],
  );

  const onAddComment = useCallback(
    (input: NewComment) =>
      selected === null
        ? Promise.resolve()
        : createComment(selected, input).then(() => loadComments(selected)),
    [selected, loadComments],
  );
  const onCommentAction = useCallback(
    (id: string, action: CommentAction) => {
      if (selected === null) return Promise.resolve();
      const p =
        "delete" in action ? removeComment(selected, id) : patchComment(selected, id, action);
      return p.then(() => loadComments(selected));
    },
    [selected, loadComments],
  );

  const visibleComments = useMemo(() => {
    if (filter === "all") return comments;
    return comments.filter((c) => c.status === filter);
  }, [comments, filter]);

  const visibleFiles = useMemo(() => {
    const files = diff?.files ?? [];
    if (!dir) return files;
    return files.filter((f) => f.path === dir || f.path.startsWith(`${dir}/`));
  }, [diff, dir]);

  const commentsByFile = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const c of visibleComments) {
      const fileComments = map.get(c.file);
      if (fileComments) fileComments.push(c);
      else map.set(c.file, [c]);
    }
    return map;
  }, [visibleComments]);

  const fileEntries = useMemo<FileTreeEntry[]>(
    () =>
      visibleFiles.map((f, index) => ({
        path: f.path,
        index,
        additions: f.additions,
        deletions: f.deletions,
        openComments: commentsByFile.get(f.path)?.filter((c) => c.status === "open").length ?? 0,
      })),
    [visibleFiles, commentsByFile],
  );

  const totals = useMemo(() => diffTotals(visibleFiles), [visibleFiles]);

  const selectedWs = workspaces.find((w) => w.id === selected);
  const openTotal = comments.filter((c) => c.status === "open").length;
  // The two renderers scroll differently: classic has a DOM node per file, the fast one has to be
  // told which row to jump to. The nonce makes clicking the same file twice scroll again.
  const scrollToFile = (index: number, path: string) => {
    if (fast) setJump({ path, nonce: Date.now() });
    else fileRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex h-full flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="font-semibold tracking-tight">livediff</span>
        {focused && selectedWs && (
          <span className="font-mono text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {selectedWs.label}
            {dir && <span className="text-neutral-400">/{dir}</span>}
          </span>
        )}
        {selectedWs && (
          <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {selectedWs.branch}
            {selectedWs.head ? `@${selectedWs.head}` : ""}
          </span>
        )}
        {selectedWs && (
          <span
            className={
              "flex items-center gap-1.5 text-xs transition-colors " +
              (flash ? "text-amber-500" : "text-green-600 dark:text-green-400")
            }
          >
            <span className={"h-2 w-2 rounded-full " + (flash ? "bg-amber-400" : "bg-green-500")} />
            {flash ? "updated" : "live"}
          </span>
        )}

        {/* In the header rather than a strip of its own: the size of the diff is worth knowing
            before you start, but not worth a row of vertical space on every screen. */}
        {selectedWs && totals.files > 0 && (
          <span
            data-diff-summary
            className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400"
          >
            <span data-diff-files={totals.files}>
              {totals.files} file{totals.files === 1 ? "" : "s"}
            </span>
            <span
              data-diff-additions={totals.additions}
              className="text-green-600 dark:text-green-400"
            >
              +{totals.additions}
            </span>
            <span data-diff-deletions={totals.deletions} className="text-red-600 dark:text-red-400">
              −{totals.deletions}
            </span>
            <span
              data-diff-bytes={totals.bytes}
              className="tabular-nums text-neutral-400 dark:text-neutral-500"
              title="Total size of the diff text, not of the files"
            >
              {formatBytes(totals.bytes)}
            </span>
          </span>
        )}

        {review && (
          <ReviewBanner openCount={openTotal} total={comments.length} onDone={onDoneReviewing} />
        )}

        <div className="ml-auto flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            vs
            <span className="relative flex items-center">
              {/* Committed on blur and on Enter, not per keystroke: the value outlives this tab,
                  so half-typed refs must never reach the registry. */}
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                onBlur={commitBase}
                onKeyDown={(e) => e.key === "Enter" && commitBase()}
                list="livediff-refs"
                data-compare-against
                placeholder="HEAD"
                title="Compare the working tree against a branch, from where it diverged"
                className={comparingClass(base)}
              />
              {base && (
                <button
                  type="button"
                  data-clear-compare
                  onClick={() => {
                    setBase("");
                    if (selected) persistBase(selected, "");
                  }}
                  title="Back to comparing against the last commit"
                  className="absolute right-1 rounded px-1 text-[11px] leading-none text-blue-600 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-500/20"
                >
                  ✕
                </button>
              )}
            </span>
          </label>
          <datalist id="livediff-refs">
            <option value="HEAD">last commit — uncommitted changes only</option>
            {refs.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <div className="flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            {(
              [
                ["split", "Split"],
                ["unified", "Unified"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={label}
                onClick={() => setMode(m)}
                className={
                  "px-2 py-1 " +
                  (mode === m
                    ? "bg-blue-600 text-white"
                    : "bg-white text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300")
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            {(["all", "open", "resolved"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={
                  "px-2 py-1 capitalize " +
                  (filter === f
                    ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900"
                    : "bg-white text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300")
                }
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!focused && (
          <WorkspaceRail
            workspaces={workspaces}
            selected={selected}
            onSelect={setSelected}
            onRemove={onRemoveWorkspace}
            onAdd={onAddWorkspace}
          />
        )}

        {/* Collapsed, the panel keeps a spine rather than vanishing: somewhere to click to get it
            back, and the two counts worth knowing without it. */}
        {selectedWs && filesCollapsed && (
          <div className="flex w-9 shrink-0 flex-col items-center gap-2 border-r border-neutral-200 bg-white pt-2 dark:border-neutral-800 dark:bg-neutral-900">
            <button
              type="button"
              data-file-panel-toggle
              aria-expanded="false"
              aria-controls="livediff-file-list"
              onClick={() => setFilesCollapsed(false)}
              title="Show files"
              className="w-full py-1 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
            >
              ▶<span className="block text-[10px] tabular-nums">{visibleFiles.length}</span>
            </button>
            {/* Reaching every comment must not depend on the panel being open — collapsed is the
                default in focused mode, and this is the one action with no other route to it. */}
            {comments.length > 0 && (
              <button
                type="button"
                data-see-all-comments
                onClick={() => setShowAll(Date.now())}
                title="See every comment in this worktree"
                className={
                  "rounded-full px-1 text-[10px] " +
                  (openTotal > 0
                    ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-300"
                    : "text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800")
                }
              >
                {openTotal}
              </button>
            )}
          </div>
        )}

        {selectedWs && !filesCollapsed && (
          <aside
            id="livediff-file-list"
            data-file-list
            className="w-60 shrink-0 overflow-y-auto border-r border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-see-all-comments
                onClick={() => setShowAll(Date.now())}
                disabled={comments.length === 0}
                title={comments.length > 0 ? "See every comment in this worktree" : undefined}
                className="flex-1 rounded px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-400 enabled:hover:bg-neutral-100 enabled:hover:text-neutral-600 dark:enabled:hover:bg-neutral-800"
              >
                {visibleFiles.length} files · {openTotal} open
              </button>
              <button
                type="button"
                data-file-panel-toggle
                aria-expanded="true"
                aria-controls="livediff-file-list"
                onClick={() => setFilesCollapsed(true)}
                title="Hide files"
                className="shrink-0 rounded px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
              >
                ◀
              </button>
            </div>
            <FileTree
              entries={fileEntries}
              activePath={activeFile}
              onSelect={(entry) => scrollToFile(entry.index, entry.path)}
            />
          </aside>
        )}

        <main
          className={fast ? "flex min-w-0 flex-1 flex-col" : "min-w-0 flex-1 overflow-y-auto p-4"}
        >
          {error && (
            <div
              data-error
              className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300"
            >
              {error}
            </div>
          )}
          {!selectedWs && focused && (
            <div className="mt-24 text-center text-sm text-neutral-400">
              That workspace isn’t registered. Run{" "}
              <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">
                livediff &lt;path&gt;
              </code>{" "}
              first.
            </div>
          )}
          {!selectedWs && !focused && (
            <div className="mt-24 text-center text-sm text-neutral-400">
              No workspace selected. Register a worktree to get started — run{" "}
              <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">livediff .</code> in
              it, or ask Claude.
            </div>
          )}
          {selectedWs && diff && visibleFiles.length === 0 && (
            <div className="flex min-h-0 flex-1">
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-neutral-400">
                <p>{dir ? `No changes under ${dir}.` : "No changes in this worktree."}</p>
                {/* With no files there are no headers to hang them off, and these are exactly the
                    comments worth finding: the diff moved on, the thread did not. */}
                {comments.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll(Date.now())}
                    className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    Read {comments.length} comment{comments.length === 1 ? "" : "s"} left here
                  </button>
                )}
              </div>
              {showAll > 0 && (
                <CommentDrawer
                  path={null}
                  comments={comments}
                  anchored={NOTHING_ANCHORED}
                  onClose={() => setShowAll(0)}
                  onCommentAction={onCommentAction}
                />
              )}
            </div>
          )}
          {selectedWs && diff && fast && visibleFiles.length > 0 && (
            <FastDiff
              diff={{ ...diff, files: visibleFiles }}
              comments={visibleComments}
              mode={mode}
              jump={jump}
              showAll={showAll}
              onAddComment={onAddComment}
              onCommentAction={onCommentAction}
              onActiveFile={setActiveFile}
            />
          )}
          {selectedWs && !fast && visibleFiles.length > 0 && (
            <Suspense
              fallback={
                <div className="mt-24 text-center text-sm text-neutral-400">Loading diff view…</div>
              }
            >
              {visibleFiles.map((f, i) => (
                <div
                  key={f.path}
                  ref={(element) => {
                    fileRefs.current[i] = element;
                  }}
                >
                  <FileDiff
                    file={f}
                    comments={commentsByFile.get(f.path) ?? []}
                    mode={mode}
                    theme={theme}
                    onAddComment={onAddComment}
                    onCommentAction={onCommentAction}
                  />
                </div>
              ))}
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
