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
