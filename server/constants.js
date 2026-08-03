/**
 * Every tunable value livediff has, in one place.
 *
 * The rule for what belongs here: a value is a constant if changing it is a *policy* decision,
 * or if the same literal has to agree across more than one file. A value that only makes sense
 * inside one function stays there — a lookup table of file extensions or a set of terminal
 * glyphs is not configuration, and hoisting it would only add indirection.
 *
 * This module imports nothing, so anything may import it without risking a cycle.
 */

// ─── Time ────────────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

// ─── Comment lifecycle ───────────────────────────────────────────────────────
// Nothing is destroyed less than ORPHAN_ARCHIVE_DAYS + PURGE_DAYS after a comment's last
// activity. Changing these changes how long review notes survive, so they are policy.

/** Days a comment's file may be absent from the diff before the comment is archived. */
export const ORPHAN_ARCHIVE_DAYS = 5;

/** Days a resolved comment may sit untouched before it is archived, even if still in the diff. */
export const RESOLVED_ARCHIVE_DAYS = 30;

/** Days an archived comment is kept before it is deleted. `livediff restore` works until then. */
export const PURGE_DAYS = 200;

/** How often the hub sweeps for comments to archive or purge, while a browser is attached. */
export const SWEEP_INTERVAL_MS = 12 * HOUR_MS;

// ─── Networking ──────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 4180;

/** How many consecutive ports to try before giving up on binding. */
export const PORT_FALLBACK_ATTEMPTS = 20;

/** Bind and probe address. Never 0.0.0.0: the hub must not be reachable off this machine. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Retry hint sent to EventSource clients, in ms. */
export const SSE_RETRY_MS = 2000;

// ─── Timing ──────────────────────────────────────────────────────────────────

/** Worktree poll interval while at least one browser is attached. */
export const DEFAULT_POLL_MS = 1000;

/**
 * How long a spawn lock may exist before another process may break it. Reported by `doctor` and
 * enforced by `hub-state`; these disagreed by unit before this module existed.
 */
export const LOCK_STALE_MS = 30_000;

/** How long to wait for a freshly spawned hub to answer before declaring failure. */
export const SPAWN_WAIT_TIMEOUT_MS = 10_000;

/** How long to wait for a hub's port to go quiet after asking it to shut down. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

/** Default timeout for an `/api/meta` health probe. */
export const PROBE_TIMEOUT_MS = 500;

/** Coalescing window for filesystem watch events on the config directory. */
export const CONFIG_WATCH_DEBOUNCE_MS = 50;

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Directory name used under both XDG config and XDG state. */
export const APP_DIR_NAME = "livediff";

export const STATE_FILENAME = "hub.json";
export const LOCK_FILENAME = "hub.lock";
export const LOG_FILENAME = "hub.log";
export const REGISTRY_FILENAME = "workspaces.json";
export const COMMENTS_DIR_NAME = "comments";

/** Where pre-0.3 versions wrote comments, inside the repo. Detected and migrated away. */
export const LEGACY_COMMENT_DIR = ".diff-review";

/** Schema version written into every comment store. */
export const COMMENT_STORE_VERSION = 2;

// ─── Identifiers ─────────────────────────────────────────────────────────────

/** Length of a workspace, comment, or review id. Short enough to type, long enough not to collide. */
export const ID_LENGTH = 8;

export const ID_PATTERN = /^[0-9a-f]{8}$/;

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Longest quoted source line printed as a comment anchor before truncation. */
export const MAX_ANCHOR_LENGTH = 120;

/** Max stdout accepted from a git subprocess. A 20k-line diff is ~2.5MB, so this is generous. */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Bytes of a file inspected for a NUL byte when deciding whether it is binary — git's heuristic. */
export const BINARY_SNIFF_BYTES = 8000;

/** Archive size at which `doctor` escalates from reporting to suggesting a prune. */
export const ARCHIVE_WARN_BYTES = 5 * 1024 * 1024;

// ─── Process ─────────────────────────────────────────────────────────────────

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

// ─── Environment variables ───────────────────────────────────────────────────
// Named here so the help text and the code that reads them can never drift apart.

export const ENV = {
  PORT: "LIVEDIFF_PORT",
  POLL_MS: "LIVEDIFF_POLL_MS",
  BROWSER: "LIVEDIFF_BROWSER",
  OPEN: "LIVEDIFF_OPEN",
  RENDERER: "LIVEDIFF_RENDERER",
  XDG_CONFIG_HOME: "XDG_CONFIG_HOME",
  XDG_STATE_HOME: "XDG_STATE_HOME",
  NO_COLOR: "NO_COLOR",
};

// ─── Feature flags ───────────────────────────────────────────────────────────

/**
 * Which diff renderer the UI uses, and therefore which one the CLI hands out to humans and
 * agents. Flip this to move everyone; append `?renderer=classic` or `?renderer=fast` to a URL to
 * override it for one tab, which is how the two get compared on the same diff.
 *
 *   "classic" — @git-diff-view/react's DiffView. Renders every row.
 *   "fast"    — virtualized rows with in-app search.
 */
export const RENDERER = "classic";

export const RENDERERS = ["classic", "fast"];

// ─── Virtualized renderer layout ─────────────────────────────────────────────

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

/** How tall an expanded thread may grow before it scrolls internally. */
export const COMMENT_EXPANDED_MAX_PX = 460;
