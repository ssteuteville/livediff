import { access } from "node:fs/promises";
import { readRegistry, registryPath, idFor } from "./registry.js";
import { toplevel } from "./git.js";
import { mergeInto } from "./comments.js";
import { writeJsonAtomic } from "./atomic.js";

/**
 * Pre-0.4 registries hashed whatever path was passed to `livediff add`, so a repo could appear
 * several times — once per subdirectory it was invoked from — each with its own comments file.
 * Collapse those onto the worktree root and merge their comments. Idempotent.
 */
export async function migrateRegistry() {
  const workspaces = await readRegistry();
  if (!workspaces.length) return { normalized: 0, merged: 0 };

  // Probe every entry concurrently first — this runs before the hub starts listening, and one
  // git spawn per workspace in series delays every startup.
  const roots = await Promise.all(
    workspaces.map(async (ws) => {
      try {
        await access(ws.path);
      } catch {
        return null; // path is gone — drop it
      }
      return toplevel(ws.path);
    })
  );

  const byRoot = new Map();
  let normalized = 0;
  let merged = 0;

  for (const [index, ws] of workspaces.entries()) {
    const root = roots[index];
    if (!root) continue;
    if (root !== ws.path) normalized++;

    const id = idFor(root);
    const winner = byRoot.get(id);
    if (!winner) {
      byRoot.set(id, { ...ws, id, path: root });
      if (ws.id !== id) await mergeInto(ws.id, id);
      continue;
    }
    await mergeInto(ws.id, id);
    merged++;
  }

  const next = [...byRoot.values()];
  const changed =
    next.length !== workspaces.length ||
    next.some((w, i) => w.id !== workspaces[i].id || w.path !== workspaces[i].path);
  if (changed) await writeJsonAtomic(registryPath(), { workspaces: next });

  return { normalized, merged };
}
