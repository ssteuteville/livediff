/**
 * Turn a flat list of changed paths into a directory tree.
 *
 * Pure: no DOM, no React. A diff arrives as paths, and a sidebar that lists forty of them flat
 * tells you nothing about how they relate. The tree is navigation, not a filesystem browser —
 * which is why runs of single-child directories collapse into one row rather than costing a level
 * of indentation each, the same choice VS Code's explorer makes with "compact folders".
 */

export interface FileTreeEntry {
  path: string;
  index: number;
  additions: number;
  deletions: number;
  openComments: number;
}

export interface TreeFileNode {
  type: "file";
  name: string;
  path: string;
  entry: FileTreeEntry;
}

export interface TreeDirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  files: number;
  openComments: number;
}

export type TreeNode = TreeDirNode | TreeFileNode;

interface Building {
  dirs: Map<string, Building>;
  files: FileTreeEntry[];
}

function building(): Building {
  return { dirs: new Map(), files: [] };
}

function byName(a: TreeNode, b: TreeNode): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function countFiles(nodes: readonly TreeNode[]): number {
  return nodes.reduce((total, node) => total + (node.type === "file" ? 1 : node.files), 0);
}

function countOpenComments(nodes: readonly TreeNode[]): number {
  return nodes.reduce((total, node) => {
    return total + (node.type === "file" ? node.entry.openComments : node.openComments);
  }, 0);
}

/**
 * Collapse a directory that holds nothing but one other directory into a single row.
 *
 * Children are built before this runs, so a chain of any length folds from the bottom up and
 * `src` → `main` → `java` arrives here already reduced to one node to absorb.
 */
function compact(dir: TreeDirNode): TreeDirNode {
  const only = dir.children.length === 1 ? dir.children[0] : undefined;
  if (only === undefined || only.type !== "dir") return dir;
  return { ...only, name: `${dir.name}/${only.name}` };
}

function toDir(name: string, prefix: string, source: Building): TreeDirNode {
  const path = prefix ? `${prefix}/${name}` : name;
  const children = toNodes(source, path);
  return {
    type: "dir",
    name,
    path,
    children,
    files: countFiles(children),
    openComments: countOpenComments(children),
  };
}

function toFile(entry: FileTreeEntry): TreeFileNode {
  return {
    type: "file",
    name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
    path: entry.path,
    entry,
  };
}

function toNodes(source: Building, prefix: string): TreeNode[] {
  const dirs: TreeNode[] = [];
  for (const [name, child] of source.dirs) dirs.push(compact(toDir(name, prefix, child)));
  const files: TreeNode[] = source.files.map(toFile);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

/**
 * Build the tree. Directories sort before files, each group alphabetically.
 *
 * Ordering is deliberately not the diff's own order: git hands paths over sorted, but once they
 * are grouped by directory that order no longer survives, and a tree that reshuffles as files
 * change would be worse than one that is merely different from the diff.
 */
export function buildFileTree(entries: readonly FileTreeEntry[]): TreeNode[] {
  const root = building();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const name = segments.pop();
    if (name === undefined || name === "") continue;
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = building();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push(entry);
  }
  return toNodes(root, "");
}

/** Every directory path in the tree, for expand-all and collapse-all. */
export function directoryPaths(nodes: readonly TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type !== "dir") continue;
    paths.push(node.path);
    paths.push(...directoryPaths(node.children));
  }
  return paths;
}
