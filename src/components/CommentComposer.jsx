import { useState } from "react";

export default function CommentComposer({ onSubmit, onCancel, placeholder = "Leave a comment for the agent…" }) {
  const [body, setBody] = useState("");
  const submit = () => {
    const trimmed = body.trim();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <div className="border-y border-amber-300/60 bg-amber-50 p-2 dark:border-amber-500/30 dark:bg-amber-950/30">
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        rows={3}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-neutral-300 bg-white p-2 text-sm text-neutral-900 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={submit}
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          Comment
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <span className="ml-auto text-[11px] text-neutral-400">⌘↵ to submit</span>
      </div>
    </div>
  );
}
