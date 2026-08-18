import type { Comment, Diff, Lens, Reply, Review, Workspace } from "../shared/types.ts";
import type { Renderer } from "../shared/constants.ts";

/** The payload every hub event carries: which workspace moved, and why. */
export interface HubEvent {
  ws?: string;
  reason?: string;
}

export interface Subscribers {
  onDiff?: (e: HubEvent) => void;
  onComments?: (e: HubEvent) => void;
  onWorkspaces?: (e: HubEvent) => void;
  onReview?: (e: HubEvent) => void;
  onLenses?: (e: HubEvent) => void;
}

/** A workspace as the rail sees it: the registry record plus the hub's live summary. */
export interface WorkspaceSummary extends Workspace {
  valid: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: number;
  openComments: number;
}

export type NewComment = Pick<Comment, "file" | "side" | "line" | "body"> &
  Partial<Pick<Comment, "lineContent">>;

export function fetchDefaultRenderer(): Promise<Renderer> {
  return fetch("/api/config")
    .then(asJson<{ defaultRenderer: Renderer }>())
    .then((config) => config.defaultRenderer);
}

/**
 * The hub explains itself on failure — `{ error: "not a ref in this worktree: mian" }`. Throwing
 * the status line instead would put "400 Bad Request" in front of the user and drop the sentence
 * that says what to do about it.
 */
async function failure(res: Response): Promise<Error> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body["error"] === "string") return new Error(body["error"]);
  } catch {
    /* not JSON — fall back to the status line */
  }
  return new Error(`${res.status} ${res.statusText}`);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await failure(res);
  return await res.json();
}

const asJson =
  <T>() =>
  (res: Response) =>
    json<T>(res);

export function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
  return fetch("/api/workspaces")
    .then(asJson<{ workspaces: WorkspaceSummary[] }>())
    .then((d) => d.workspaces);
}

export function addWorkspace(path: string, label?: string): Promise<Workspace> {
  return fetch("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, label }),
  }).then(asJson<Workspace>());
}

/** Persist the ref this workspace is reviewed against, so the CLI and the sweep agree with it. */
export function setWorkspaceBase(id: string, base: string | null): Promise<Workspace> {
  return fetch(`/api/workspaces/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base }),
  }).then(asJson<Workspace>());
}

export function removeWorkspace(id: string): Promise<{ ok: boolean }> {
  return fetch(`/api/workspaces/${id}`, { method: "DELETE" }).then(asJson<{ ok: boolean }>());
}

/** Resolve the workspace containing a filesystem path. Returns the record or throws. */
export function resolvePath(path: string): Promise<Workspace> {
  return fetch(`/api/resolve?path=${encodeURIComponent(path)}`).then(asJson<Workspace>());
}

export function fetchDiff(ws: string, base?: string): Promise<Diff> {
  const q = new URLSearchParams({ ws });
  if (base) q.set("base", base);
  return fetch(`/api/diff?${q}`).then(asJson<Diff>());
}

export function fetchRefs(ws: string): Promise<string[]> {
  return fetch(`/api/refs?ws=${ws}`)
    .then(asJson<{ branches: string[] }>())
    .then((d) => d.branches);
}

export function fetchComments(ws: string): Promise<Comment[]> {
  return fetch(`/api/comments?ws=${ws}`)
    .then(asJson<{ comments: Comment[] }>())
    .then((d) => d.comments);
}

export function createComment(ws: string, input: NewComment): Promise<Comment> {
  return fetch(`/api/comments?ws=${ws}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then(asJson<Comment>());
}

export function patchComment(
  ws: string,
  id: string,
  patch: Partial<Pick<Comment, "status">> & { reply?: Pick<Reply, "author" | "body"> },
): Promise<Comment> {
  return fetch(`/api/comments/${id}?ws=${ws}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then(asJson<Comment>());
}

export function removeComment(ws: string, id: string): Promise<{ ok: boolean }> {
  return fetch(`/api/comments/${id}?ws=${ws}`, { method: "DELETE" }).then(
    asJson<{ ok: boolean }>(),
  );
}

/** The workspace's lens set, in the order the agent wrote it — which is the order the picker shows. */
export function fetchLenses(ws: string): Promise<Lens[]> {
  return fetch(`/api/lenses?ws=${ws}`)
    .then(asJson<{ lenses: Lens[] }>())
    .then((d) => d.lenses);
}

/** The open review request for a workspace, or null. Set by `livediff <path> --wait`. */
export function fetchReview(ws: string): Promise<Review | null> {
  return fetch(`/api/reviews?ws=${ws}`)
    .then(asJson<{ review: Review | null }>())
    .then((d) => d.review);
}

export function completeReview(reviewId: string): Promise<{ ok: boolean }> {
  return fetch(`/api/reviews/${reviewId}/done`, { method: "POST" }).then(asJson<{ ok: boolean }>());
}

/**
 * Subscribe to live hub events. Handlers receive the parsed payload `{ ws, reason }`.
 * Returns an unsubscribe function.
 */
export function subscribe({
  onDiff,
  onComments,
  onWorkspaces,
  onReview,
  onLenses,
}: Subscribers): () => void {
  const es = new EventSource("/api/events");
  const parse = (fn?: (e: HubEvent) => void) => (e: MessageEvent<string>) => {
    let data: HubEvent = {};
    try {
      const parsed: unknown = JSON.parse(e.data);
      if (isHubEvent(parsed)) data = parsed;
    } catch {
      /* ignore */
    }
    fn?.(data);
  };
  es.addEventListener("diff", parse(onDiff));
  es.addEventListener("comments", parse(onComments));
  es.addEventListener("workspaces", parse(onWorkspaces));
  es.addEventListener("review", parse(onReview));
  es.addEventListener("lenses", parse(onLenses));
  return () => es.close();
}

function isHubEvent(value: unknown): value is HubEvent {
  if (!isRecord(value)) return false;
  const { ws, reason } = value;
  return (
    (ws === undefined || typeof ws === "string") &&
    (reason === undefined || typeof reason === "string")
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
