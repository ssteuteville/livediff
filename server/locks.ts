/**
 * Serializes read-modify-write cycles that share a key.
 *
 * The hub is a single process, which is easy to mistake for a single thread of execution. A
 * handler that reads a store, awaits anything, then writes it can be interleaved by a second
 * request that read the same snapshot — and the later write silently drops the earlier one.
 * Comments never hit that window because a human clicks one at a time; an agent writing a lens
 * set does.
 */

const tails = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  // Run regardless of how the predecessor settled: one caller's failure must not strand the queue.
  const result = previous.then(fn, fn);
  const release = (): null => {
    // Only the current tail may clear the entry — anything else would drop a queued successor.
    if (tails.get(key) === tail) tails.delete(key);
    return null;
  };
  // Settling either way releases the key, so a rejected task cannot leak an entry or a successor.
  const tail = result.then(release, release);
  tails.set(key, tail);
  return result;
}

/** Test seam: proves drained keys are released rather than accumulating. */
export function lockCount(): number {
  return tails.size;
}
