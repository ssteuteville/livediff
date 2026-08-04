import { useState } from "react";

function WorkspaceRow({ ws, selected, onSelect, onRemove }) {
  return (
    <div
      onClick={() => onSelect(ws.id)}
      className={
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm " +
        (selected
          ? "bg-blue-600 text-white"
          : "text-neutral-700 hover:bg-neutral-200 dark:text-neutral-200 dark:hover:bg-neutral-800")
      }
    >
      <span
        className={
          "h-1.5 w-1.5 shrink-0 rounded-full " +
          (!ws.valid ? "bg-red-400" : ws.changedFiles > 0 ? "bg-amber-400" : "bg-neutral-400/60")
        }
        title={ws.valid ? `${ws.changedFiles} changed files` : "not a git repo / missing"}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={ws.path}>
          {ws.label}
        </div>
        <div
          className={"truncate text-[11px] " + (selected ? "text-blue-100" : "text-neutral-400")}
        >
          {ws.valid ? `${ws.branch}${ws.head ? "@" + ws.head : ""}` : "unavailable"}
        </div>
      </div>
      {ws.openComments > 0 && (
        <span
          data-rail-comment-count
          className={
            "shrink-0 rounded-full px-1.5 text-[10px] font-semibold " +
            (selected
              ? "bg-white/25 text-white"
              : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300")
          }
          title={`${ws.openComments} open comments`}
        >
          {ws.openComments}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(ws.id);
        }}
        className={
          "shrink-0 rounded px-1 text-xs opacity-0 group-hover:opacity-100 " +
          (selected ? "hover:bg-white/20" : "hover:bg-neutral-300 dark:hover:bg-neutral-700")
        }
        title="Unregister (does not touch the repo)"
      >
        ×
      </button>
    </div>
  );
}

export default function WorkspaceRail({ workspaces, selected, onSelect, onRemove, onAdd }) {
  const [path, setPath] = useState("");
  const submit = () => {
    const p = path.trim();
    if (p) {
      onAdd(p);
      setPath("");
    }
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Workspaces
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {workspaces.length === 0 ? (
          <div className="px-2 py-6 text-xs leading-relaxed text-neutral-400">
            No workspaces yet. Ask Claude to register a worktree, or run{" "}
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">livediff .</code> in
            one.
          </div>
        ) : (
          workspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              ws={ws}
              selected={ws.id === selected}
              onSelect={onSelect}
              onRemove={onRemove}
            />
          ))
        )}
      </div>

      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <div className="flex gap-1">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="add path…"
            className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800"
          />
          <button
            onClick={submit}
            className="rounded bg-neutral-800 px-2 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900"
          >
            +
          </button>
        </div>
      </div>
    </aside>
  );
}
