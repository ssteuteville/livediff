import { useState } from "react";

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function AuthorBadge({ author }) {
  const isClaude = author === "claude";
  return (
    <span
      className={
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
        (isClaude
          ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
          : "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300")
      }
    >
      {isClaude ? "Claude" : "You"}
    </span>
  );
}

function Comment({ comment, onResolve, onReopen, onDelete, onReply }) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const resolved = comment.status === "resolved";

  return (
    <div className="rounded-md border border-neutral-200 bg-white text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-800">
        <AuthorBadge author={comment.author} />
        <span className="text-[11px] text-neutral-400">{timeAgo(comment.createdAt)}</span>
        {resolved && (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-500/20 dark:text-green-300">
            Resolved
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => (resolved ? onReopen(comment.id) : onResolve(comment.id))}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {resolved ? "Reopen" : "Resolve"}
          </button>
          <button
            onClick={() => onDelete(comment.id)}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="whitespace-pre-wrap px-3 py-2 text-neutral-800 dark:text-neutral-100">{comment.body}</div>

      {comment.replies?.length > 0 && (
        <div className="space-y-1.5 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
          {comment.replies.map((r, i) => (
            <div key={i} className="rounded bg-neutral-50 p-2 dark:bg-neutral-800/50">
              <div className="mb-0.5 flex items-center gap-2">
                <AuthorBadge author={r.author} />
                <span className="text-[11px] text-neutral-400">{timeAgo(r.ts)}</span>
              </div>
              <div className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">{r.body}</div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-neutral-100 px-3 py-1.5 dark:border-neutral-800">
        {replying ? (
          <div>
            <textarea
              autoFocus
              rows={2}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && reply.trim()) {
                  onReply(comment.id, reply.trim());
                  setReply("");
                  setReplying(false);
                }
                if (e.key === "Escape") setReplying(false);
              }}
              placeholder="Reply…"
              className="w-full resize-y rounded border border-neutral-300 bg-white p-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <div className="mt-1 flex gap-2">
              <button
                onClick={() => {
                  if (reply.trim()) {
                    onReply(comment.id, reply.trim());
                    setReply("");
                    setReplying(false);
                  }
                }}
                className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700"
              >
                Reply
              </button>
              <button onClick={() => setReplying(false)} className="text-xs text-neutral-500">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setReplying(true)}
            className="text-[11px] text-neutral-500 hover:text-blue-600"
          >
            Reply
          </button>
        )}
      </div>
    </div>
  );
}

export default function CommentThread({ comments, onResolve, onReopen, onDelete, onReply }) {
  return (
    <div className="space-y-2 border-y border-amber-300/40 bg-amber-50/40 px-3 py-2 dark:border-amber-500/20 dark:bg-amber-950/10">
      {comments.map((c) => (
        <Comment
          key={c.id}
          comment={c}
          onResolve={onResolve}
          onReopen={onReopen}
          onDelete={onDelete}
          onReply={onReply}
        />
      ))}
    </div>
  );
}
