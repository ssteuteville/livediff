/**
 * When a comment stops being live, gets archived, and finally gets deleted.
 *
 * Pure: no I/O and no clock — `now` is always a parameter, so every threshold is testable
 * without sleeping or faking timers. Orphaning is never stored, only computed, so it heals
 * itself the moment a file returns to the diff.
 */

import { DAY_MS, ORPHAN_ARCHIVE_DAYS, PURGE_DAYS, RESOLVED_ARCHIVE_DAYS } from "./constants.js";

const ageInDays = (iso, now) => (now - Date.parse(iso)) / DAY_MS;

/** A comment is orphaned when the file it was left on is no longer part of the diff. */
export function isOrphaned(comment, changedPaths) {
  return !changedPaths.has(comment.file);
}

/**
 * Either trigger archives: orphaned and stale, or resolved and stale. An open comment that is
 * still in the diff never archives, however old — it is live work, not clutter.
 */
export function shouldArchive(comment, { orphaned, now }) {
  if (comment.archivedAt) return false;
  const age = ageInDays(comment.updatedAt, now);
  if (orphaned && age > ORPHAN_ARCHIVE_DAYS) return true;
  return comment.status === "resolved" && age > RESOLVED_ARCHIVE_DAYS;
}

export function shouldPurge(comment, now) {
  if (!comment.archivedAt) return false;
  return ageInDays(comment.archivedAt, now) > PURGE_DAYS;
}

/** Days left before purge, or null when the comment is not archived. */
export function daysUntilPurge(comment, now) {
  if (!comment.archivedAt) return null;
  return Math.ceil(PURGE_DAYS - ageInDays(comment.archivedAt, now));
}
