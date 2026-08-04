/** How long the UI waits for a burst of diff events to finish before refetching. */
export const DIFF_REFETCH_DEBOUNCE_MS = 80;

/**
 * Which diff renderer the UI uses, and therefore which one the CLI hands out to humans and
 * agents. Flip this to move everyone; append `?renderer=classic` or `?renderer=fast` to a URL to
 * override it for one tab, which is how the two get compared on the same diff.
 *
 *   "fast"    — virtualized rows, in-app search, inline comment threads. Renders what is on
 *               screen: ~60 rows and ~400 nodes whatever the diff's size.
 *   "classic" — @git-diff-view/react's DiffView. Renders every row, which on a 20,000-line diff
 *               means 500,000 nodes and about five seconds before anything is readable. Kept
 *               because it is the renderer every earlier version shipped.
 */
export const RENDERERS = ["classic", "fast"] as const;
export type Renderer = (typeof RENDERERS)[number];
export const RENDERER: Renderer = "fast";

/**
 * The most lines of comment body a collapsed thread shows before it truncates.
 *
 * A collapsed thread is a still image of the expanded one — same card, same controls, body clipped
 * with an ellipsis and the reply box only painted to look like one. Its height comes from the text
 * and is then capped here, so it never depends on what expanding would reveal. That is what lets
 * expanding draw over the rows below instead of pushing them down: the document height never
 * changes, and nothing under the reader's cursor moves.
 */
export const COMMENT_ROW_LINES = 7;

/** The card around those lines: thread header, comment header, reply box, borders, padding. */
export const COMMENT_ROW_CHROME_PX = 150;

/** Horizontal padding and borders between the surface edge and the comment body's text. */
export const COMMENT_CARD_INSET_PX = 50;

/** The one-line summary of the latest reply, shown only when a thread has one. */
export const COMMENT_REPLY_STRIP_PX = 34;

/** How tall an expanded thread may grow before it scrolls internally. */
export const COMMENT_EXPANDED_MAX_PX = 460;
