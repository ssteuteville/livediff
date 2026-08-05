/**
 * When a comment stops being live, gets archived, and finally gets deleted.
 *
 * Pure: no I/O and no clock — `now` is always a parameter, so every threshold is testable
 * without sleeping or faking timers. Orphaning is never stored, only computed, so it heals
 * itself the moment a file returns to the diff.
 */

import { DAY_MS, ORPHAN_ARCHIVE_DAYS, PURGE_DAYS, RESOLVED_ARCHIVE_DAYS } from "./constants.js";

export type CommentStatus = "open" | "resolved";

export interface LifecycleComment {
  archivedAt: string | null;
  file: string;
  status: CommentStatus;
  updatedAt: string;
}

export interface ArchiveContext {
  orphaned: boolean;
  now: number;
}

export interface RetentionPolicy {
  orphanArchiveAfterDays: number;
  resolvedArchiveAfterDays: number;
  purgeAfterDays: number;
}

const DEFAULT_RETENTION: RetentionPolicy = {
  orphanArchiveAfterDays: ORPHAN_ARCHIVE_DAYS,
  resolvedArchiveAfterDays: RESOLVED_ARCHIVE_DAYS,
  purgeAfterDays: PURGE_DAYS,
};

const ageInDays = (iso: string, now: number): number => (now - Date.parse(iso)) / DAY_MS;

/** A comment is orphaned when the file it was left on is no longer part of the diff. */
export function isOrphaned(
  comment: Pick<LifecycleComment, "file">,
  changedPaths: ReadonlySet<string>,
): boolean {
  return !changedPaths.has(comment.file);
}

/**
 * Either trigger archives: orphaned and stale, or resolved and stale. An open comment that is
 * still in the diff never archives, however old — it is live work, not clutter.
 */
export function shouldArchive(
  comment: LifecycleComment,
  { orphaned, now }: ArchiveContext,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): boolean {
  if (comment.archivedAt) return false;
  const age = ageInDays(comment.updatedAt, now);
  if (orphaned && age > policy.orphanArchiveAfterDays) return true;
  return comment.status === "resolved" && age > policy.resolvedArchiveAfterDays;
}

export function shouldPurge(
  comment: Pick<LifecycleComment, "archivedAt">,
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): boolean {
  if (!comment.archivedAt) return false;
  return ageInDays(comment.archivedAt, now) > policy.purgeAfterDays;
}

/** Days left before purge, or null when the comment is not archived. */
export function daysUntilPurge(
  comment: Pick<LifecycleComment, "archivedAt">,
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): number | null {
  if (!comment.archivedAt) return null;
  return Math.ceil(policy.purgeAfterDays - ageInDays(comment.archivedAt, now));
}
