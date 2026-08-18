export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffFile {
  path: string;
  oldPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  lang: string;
  patch: string;
}

export interface Diff {
  repo: string;
  branch: string;
  head: string | null;
  base: string | null;
  files: DiffFile[];
}

export interface Reply {
  author: "user" | "claude";
  body: string;
  ts: string;
}

export interface Comment {
  id: string;
  file: string;
  side: "old" | "new";
  line: number;
  lineContent: string;
  body: string;
  author: "user" | "claude";
  status: "open" | "resolved";
  branch: string | null;
  archivedAt: string | null;
  replies: Reply[];
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  path: string;
  label: string;
  addedAt: string;
  /** The ref this worktree is reviewed against, or null for "the last commit". */
  base: string | null;
}

export interface Review {
  reviewId: string;
  ws: string;
  startedAt: string;
}

export interface Highlight {
  path: string;
  /** New-side line number, 1-based and inclusive. */
  start: number;
  /** New-side line number, 1-based and inclusive; never less than `start`. */
  end: number;
}

/**
 * One way of reading a change: the files it selects, and the ranges inside them worth looking at.
 *
 * A lens belongs to a review handoff rather than to the repository — the agent writes the whole
 * set when it stops working, and the next handoff replaces it. Nothing keeps it current in
 * between, which is why highlights carry plain line numbers and need no drift anchor.
 */
export interface Lens {
  name: string;
  why: string | null;
  /** Glob patterns; a pattern with no metacharacter is a literal path matching only itself. */
  paths: string[];
  highlights: Highlight[];
  createdAt: string;
}
