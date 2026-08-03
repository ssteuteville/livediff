import CommentThread from "./CommentThread.jsx";

/**
 * Every comment on one file, including the ones the diff can no longer show.
 *
 * A comment outlives the line it was written against: the code moves, the hunk closes, and the
 * thread has nowhere to render even though it is still open and may already have been answered.
 * Those are the comments most worth finding — you left them, something changed, and you want to
 * know what came back. The rail counts them, so there has to be somewhere to read them.
 */
function Group({ title, entries, note, showFile, onGoTo, onCommentAction }) {
  if (entries.length === 0) return null;
  return (
    <section className="mb-4">
      <h3 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </h3>
      {note && <p className="px-3 pb-2 text-[11px] text-neutral-500">{note}</p>}
      {entries.map(({ key, file, side, line, comments }) => (
        <div key={key} data-drawer-comment className="mb-2">
          <div className="flex items-center gap-2 px-3 pb-1">
            <span className="truncate font-mono text-[11px] text-neutral-500" title={file}>
              {showFile && `${file}:`}
              {side === "old" ? "−" : "+"}
              {line}
            </span>
            {onGoTo && (
              <button
                type="button"
                onClick={() => onGoTo(key)}
                className="text-[11px] text-blue-600 hover:underline dark:text-blue-400"
              >
                show in diff
              </button>
            )}
          </div>
          <CommentThread
            comments={comments}
            onResolve={(id) => onCommentAction(id, { status: "resolved" })}
            onReopen={(id) => onCommentAction(id, { status: "open" })}
            onDelete={(id) => onCommentAction(id, { delete: true })}
            onReply={(id, body) => onCommentAction(id, { reply: { author: "user", body } })}
          />
        </div>
      ))}
    </section>
  );
}

/** Group comments by the line they were left on, in file then line order. */
function byAnchor(comments) {
  const groups = new Map();
  for (const c of comments) {
    const key = `c:${c.file}:${c.side}:${c.line}`;
    if (!groups.has(key)) groups.set(key, { key, file: c.file, side: c.side, line: c.line, comments: [] });
    groups.get(key).comments.push(c);
  }
  return [...groups.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** `path` names one file, or is null for every comment in the worktree. */
export default function CommentDrawer({ path, comments, anchored, onClose, onGoTo, onCommentAction }) {
  const scoped = path ? comments.filter((c) => c.file === path) : comments;
  const inDiff = byAnchor(scoped.filter((c) => anchored.has(c.id)));
  const gone = byAnchor(scoped.filter((c) => !anchored.has(c.id)));

  return (
    <aside
      data-comment-drawer
      className="flex w-96 shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="truncate font-mono text-xs text-neutral-700 dark:text-neutral-200" title={path ?? ""}>
          {path ?? `All comments · ${scoped.length}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {scoped.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-neutral-400">
            {path ? "No comments on this file." : "No comments in this worktree."}
          </p>
        )}
        <Group
          title="In this diff"
          entries={inDiff}
          showFile={!path}
          onGoTo={onGoTo}
          onCommentAction={onCommentAction}
        />
        <Group
          title="No longer in the diff"
          entries={gone}
          showFile={!path}
          note="The lines these were left on are not part of the current diff. They are still stored, and still yours to resolve."
          onCommentAction={onCommentAction}
        />
      </div>
    </aside>
  );
}
