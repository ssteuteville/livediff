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
import type { HubEvent, NewComment, WorkspaceSummary } from "./api.ts";
import FastDiff from "./components/FastDiff.tsx";
import CommentDrawer from "./components/CommentDrawer.tsx";
import WorkspaceRail from "./components/WorkspaceRail.tsx";
import ReviewBanner from "./components/ReviewBanner.tsx";
import { RENDERER, RENDERERS, DIFF_REFETCH_DEBOUNCE_MS } from "../shared/constants.ts";
import {
  fetchWorkspaces,
  addWorkspace,
  removeWorkspace,
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
  const renderer = isRenderer(requested) ? requested : RENDERER;
  const fast = renderer === "fast";

  // Mirrors for use inside the once-only SSE subscription.
  const selectedRef = useRef<string | null>(null);
  const baseRef = useRef("");
  selectedRef.current = selected;
  baseRef.current = base;

  const loadWorkspaces = useCallback(
    () =>
      fetchWorkspaces()
        .then((next) => {
          keepIfSame(setWorkspaces)(next);
          setLoaded(true);
        })
        .catch(() => {}),
    [],
  );

  // Saving several files in a row fires several diff events. Only the last answer is worth having,
  // and without this the second-to-last can land after it and put a stale diff on screen.
  const diffRequest = useRef(0);

  const loadDiff = useCallback((ws: string | null, b: string): Promise<void> => {
    if (!ws) {
      setDiff(null);
      return Promise.resolve();
    }
    const request = ++diffRequest.current;
    return fetchDiff(ws, b || undefined)
      .then((next) => {
        if (request === diffRequest.current) keepIfSame(setDiff)(next);
      })
      .catch((cause: unknown) => {
        if (request === diffRequest.current) setError(errorMessage(cause));
      });
  }, []);

  const loadComments = useCallback((ws: string | null): Promise<void> => {
    if (!ws) {
      setComments([]);
      return Promise.resolve();
    }
    return fetchComments(ws)
      .then(keepIfSame(setComments))
      .catch(() => {});
  }, []);

  // A save that touches twenty files arrives as twenty events. Coalesce them into one fetch.
  const diffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refetchDiffSoon = useCallback(() => {
    clearTimeout(diffTimer.current);
    diffTimer.current = setTimeout(
      () => loadDiff(selectedRef.current, baseRef.current),
      DIFF_REFETCH_DEBOUNCE_MS,
    );
  }, [loadDiff]);

  useEffect(() => () => clearTimeout(diffTimer.current), []);

  const loadReview = useCallback((ws: string | null): Promise<void> => {
    if (!ws) {
      setReview(null);
      return Promise.resolve();
    }
    return fetchReview(ws)
      .then(setReview)
      .catch(() => setReview(null));
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Preselect from the URL (?ws=<id> or ?path=<dir>).
  useEffect(() => {
    const ws = urlParams.get("ws");
    const path = urlParams.get("path");
    if (ws) setSelected(ws);
    else if (path)
      resolvePath(path)
        .then((workspace) => setSelected(workspace.id))
        .catch(() => {});
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

  useEffect(() => {
    loadDiff(selected, base);
    loadComments(selected);
    loadReview(selected);
  }, [selected, base, loadDiff, loadComments, loadReview]);

  // Branch list for the compare-against picker. Keyed on the workspace only: branches change far
  // less often than the diff, and refetching them on every base change would be pure noise.
  useEffect(() => {
    if (!selected) {
      setRefs([]);
      return;
    }
    fetchRefs(selected)
      .then(keepIfSame(setRefs))
      .catch(() => {});
  }, [selected]);

  useEffect(() => {
    return subscribe({
      onWorkspaces: () => loadWorkspaces(),
      onDiff: (event) => {
        const { ws } = event;
        loadWorkspaces();
        if (ws === selectedRef.current) {
          refetchDiffSoon();
          setFlash(true);
          setTimeout(() => setFlash(false), 900);
        }
      },
      onComments: (event) => {
        const { ws } = event;
        loadWorkspaces();
        if (ws === selectedRef.current) loadComments(selectedRef.current);
      },
      onReview: (event) => {
        if (!isReviewEvent(event)) return;
        const { ws, state } = event;
        if (ws !== selectedRef.current) return;
        if (state === "open") loadReview(selectedRef.current);
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

        {review && (
          <ReviewBanner openCount={openTotal} total={comments.length} onDone={onDoneReviewing} />
        )}

        <div className="ml-auto flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            vs
            <span className="relative flex items-center">
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
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
                  onClick={() => setBase("")}
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

        {selectedWs && (
          <aside
            data-file-list
            className="w-60 shrink-0 overflow-y-auto border-r border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <button
              type="button"
              data-see-all-comments
              onClick={() => setShowAll(Date.now())}
              disabled={comments.length === 0}
              title={comments.length > 0 ? "See every comment in this worktree" : undefined}
              className="w-full rounded px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-400 enabled:hover:bg-neutral-100 enabled:hover:text-neutral-600 dark:enabled:hover:bg-neutral-800"
            >
              {visibleFiles.length} files · {openTotal} open
            </button>
            {visibleFiles.map((f, i) => {
              const fc = commentsByFile.get(f.path)?.filter((c) => c.status === "open").length ?? 0;
              return (
                <button
                  key={f.path}
                  data-file-item={f.path}
                  onClick={() => scrollToFile(i, f.path)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span
                    className="truncate font-mono text-neutral-700 dark:text-neutral-200"
                    title={f.path}
                  >
                    {f.path.split("/").pop()}
                  </span>
                  {fc > 0 && (
                    <span className="ml-auto rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                      {fc}
                    </span>
                  )}
                  <span className={"text-[10px] text-neutral-400 " + (fc > 0 ? "" : "ml-auto")}>
                    {f.additions > 0 && (
                      <span className="text-green-600 dark:text-green-400">+{f.additions}</span>
                    )}{" "}
                    {f.deletions > 0 && (
                      <span className="text-red-600 dark:text-red-400">−{f.deletions}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </aside>
        )}

        <main
          className={fast ? "flex min-w-0 flex-1 flex-col" : "min-w-0 flex-1 overflow-y-auto p-4"}
        >
          {error && (
            <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300">
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
