import { useEffect, useRef } from "react";

const SCOPES = [
  ["all", "all"],
  ["added", "+ only"],
  ["removed", "− only"],
];

function Toggle({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        "rounded px-1.5 py-0.5 text-[11px] font-medium " +
        (active
          ? "bg-blue-600 text-white"
          : "text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700")
      }
    >
      {children}
    </button>
  );
}

/**
 * In-app find. Replaces the browser's, which cannot see virtualized rows.
 *
 * Worth more than what it replaces: it searches the parsed model, so it knows which lines are
 * additions, which file each hit is in, and how many hits there are — none of which find-in-page
 * can tell you.
 */
export default function DiffSearch({
  query,
  onQuery,
  options,
  onOptions,
  hits,
  active,
  onNavigate,
  onClose,
  fileCount,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onNavigate(e.shiftKey ? -1 : 1);
    }
  };

  const position = hits.length ? `${active + 1} of ${hits.length}` : query ? "no matches" : "";
  const files = fileCount > 1 ? ` · ${fileCount} files` : "";

  return (
    <div
      data-diff-search
      className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in diff"
        className="w-64 rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800"
      />

      <span className="min-w-[7rem] font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
        {position}
        {hits.length > 0 && files}
      </span>

      <button
        type="button"
        onClick={() => onNavigate(-1)}
        disabled={!hits.length}
        className="rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700"
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => onNavigate(1)}
        disabled={!hits.length}
        className="rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700"
        title="Next match (Enter)"
      >
        ↓
      </button>

      <div className="ml-2 flex items-center gap-1">
        <Toggle
          active={options.caseSensitive}
          onClick={() => onOptions({ ...options, caseSensitive: !options.caseSensitive })}
          title="Match case"
        >
          Aa
        </Toggle>
        <Toggle
          active={options.regex}
          onClick={() => onOptions({ ...options, regex: !options.regex })}
          title="Regular expression"
        >
          .*
        </Toggle>
      </div>

      <div className="flex items-center gap-1">
        {SCOPES.map(([value, label]) => (
          <Toggle
            key={value}
            active={options.scope === value}
            onClick={() => onOptions({ ...options, scope: value })}
            title={`Search ${label}`}
          >
            {label}
          </Toggle>
        ))}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="ml-auto rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
}
