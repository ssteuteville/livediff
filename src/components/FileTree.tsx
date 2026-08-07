import { useCallback, useMemo, useState } from "react";
import { buildFileTree, directoryPaths } from "../file-tree.js";
import type { FileTreeEntry, TreeDirNode, TreeFileNode, TreeNode } from "../file-tree.js";

interface FileTreeProps {
  entries: readonly FileTreeEntry[];
  activePath: string | null;
  onSelect: (entry: FileTreeEntry) => void;
}

interface NodeProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (entry: FileTreeEntry) => void;
}

/** Indent by depth without letting a deep tree push names off the panel entirely. */
function indent(depth: number): { paddingLeft: number } {
  return { paddingLeft: 6 + Math.min(depth, 6) * 10 };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className={
        "inline-block w-3 shrink-0 text-[9px] text-neutral-400 transition-transform " +
        (open ? "rotate-90" : "")
      }
    >
      ▶
    </span>
  );
}

function CommentBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
      {count}
    </span>
  );
}

function Stat({ file }: { file: TreeFileNode }) {
  const { additions, deletions } = file.entry;
  return (
    <span className="shrink-0 text-[10px] text-neutral-400">
      {additions > 0 && <span className="text-green-600 dark:text-green-400">+{additions}</span>}{" "}
      {deletions > 0 && <span className="text-red-600 dark:text-red-400">−{deletions}</span>}
    </span>
  );
}

/**
 * The highlight is what tells you where you are in a long diff, so it has to be unmistakable at a
 * glance rather than a subtle tint — this row is the answer to "which file am I looking at".
 */
function fileClass(active: boolean): string {
  const base = "flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs ";
  if (active) {
    return base + "bg-blue-100 font-medium text-blue-900 dark:bg-blue-500/20 dark:text-blue-100";
  }
  return base + "hover:bg-neutral-100 dark:hover:bg-neutral-800";
}

function FileRow({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: TreeFileNode;
  depth: number;
  activePath: string | null;
  onSelect: (entry: FileTreeEntry) => void;
}) {
  const active = activePath === node.path;
  return (
    <button
      type="button"
      data-file-item={node.path}
      data-file-active={active ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(node.entry)}
      style={indent(depth)}
      className={fileClass(active)}
    >
      <span className="w-3 shrink-0" />
      <span className="truncate font-mono" title={node.path}>
        {node.name}
      </span>
      <CommentBadge count={node.entry.openComments} />
      <span className={node.entry.openComments > 0 ? "" : "ml-auto"}>
        <Stat file={node} />
      </span>
    </button>
  );
}

function DirRow({
  node,
  depth,
  activePath,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeDirNode;
  depth: number;
  activePath: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (entry: FileTreeEntry) => void;
}) {
  const open = !collapsed.has(node.path);
  return (
    <>
      <button
        type="button"
        data-file-dir={node.path}
        aria-expanded={open}
        onClick={() => onToggle(node.path)}
        style={indent(depth)}
        className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <Chevron open={open} />
        <span
          className="truncate font-mono text-neutral-500 dark:text-neutral-400"
          title={node.path}
        >
          {node.name}
        </span>
        <CommentBadge count={node.openComments} />
        <span
          className={
            "shrink-0 text-[10px] text-neutral-400 " + (node.openComments > 0 ? "" : "ml-auto")
          }
        >
          {node.files}
        </span>
      </button>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function TreeRow({ node, depth, activePath, collapsed, onToggle, onSelect }: NodeProps) {
  if (node.type === "file") {
    return <FileRow node={node} depth={depth} activePath={activePath} onSelect={onSelect} />;
  }
  return (
    <DirRow
      node={node}
      depth={depth}
      activePath={activePath}
      collapsed={collapsed}
      onToggle={onToggle}
      onSelect={onSelect}
    />
  );
}

/**
 * The changed files as a directory tree.
 *
 * Collapse state is keyed by directory path rather than by position, so it survives the refetch
 * that follows every save — a tree that reopened itself whenever you edited a file would be worse
 * than one that never collapsed at all.
 */
export default function FileTree({ entries, activePath, onSelect }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const allDirs = useMemo(() => directoryPaths(tree), [tree]);
  const anyOpen = allDirs.some((path) => !collapsed.has(path));

  const onToggle = useCallback((path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const onToggleAll = useCallback(() => {
    setCollapsed(anyOpen ? new Set(allDirs) : new Set());
  }, [anyOpen, allDirs]);

  return (
    <div data-file-tree>
      {allDirs.length > 0 && (
        <button
          type="button"
          data-file-tree-toggle-all
          onClick={onToggleAll}
          className="mb-1 w-full rounded px-2 py-0.5 text-left text-[10px] uppercase tracking-wide text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
        >
          {anyOpen ? "collapse all" : "expand all"}
        </button>
      )}
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          collapsed={collapsed}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
