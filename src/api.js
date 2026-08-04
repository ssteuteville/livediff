async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchWorkspaces() {
  return fetch("/api/workspaces").then(json).then((d) => d.workspaces);
}

export function addWorkspace(path, label) {
  return fetch("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, label }),
  }).then(json);
}

export function removeWorkspace(id) {
  return fetch(`/api/workspaces/${id}`, { method: "DELETE" }).then(json);
}

/** Resolve the workspace containing a filesystem path. Returns { id, path, label } or throws. */
export function resolvePath(path) {
  return fetch(`/api/resolve?path=${encodeURIComponent(path)}`).then(json);
}

export function fetchDiff(ws, base) {
  const q = new URLSearchParams({ ws });
  if (base) q.set("base", base);
  return fetch(`/api/diff?${q}`).then(json);
}

export function fetchRefs(ws) {
  return fetch(`/api/refs?ws=${ws}`).then(json).then((d) => d.branches);
}

export function fetchComments(ws) {
  return fetch(`/api/comments?ws=${ws}`).then(json).then((d) => d.comments);
}

export function createComment(ws, input) {
  return fetch(`/api/comments?ws=${ws}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then(json);
}

export function patchComment(ws, id, patch) {
  return fetch(`/api/comments/${id}?ws=${ws}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then(json);
}

export function removeComment(ws, id) {
  return fetch(`/api/comments/${id}?ws=${ws}`, { method: "DELETE" }).then(json);
}

/** The open review request for a workspace, or null. Set by `livediff <path> --wait`. */
export function fetchReview(ws) {
  return fetch(`/api/reviews?ws=${ws}`).then(json).then((d) => d.review);
}

export function completeReview(reviewId) {
  return fetch(`/api/reviews/${reviewId}/done`, { method: "POST" }).then(json);
}

/**
 * Subscribe to live hub events. Handlers receive the parsed payload `{ ws, reason }`.
 * Returns an unsubscribe function.
 */
export function subscribe({ onDiff, onComments, onWorkspaces, onReview }) {
  const es = new EventSource("/api/events");
  const parse = (fn) => (e) => {
    let data = {};
    try {
      data = JSON.parse(e.data);
    } catch {
      /* ignore */
    }
    fn?.(data);
  };
  es.addEventListener("diff", parse(onDiff));
  es.addEventListener("comments", parse(onComments));
  es.addEventListener("workspaces", parse(onWorkspaces));
  es.addEventListener("review", parse(onReview));
  return () => es.close();
}
