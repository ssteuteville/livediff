import { useState } from "react";

interface ReviewBannerProps {
  openCount: number;
  /** Releases the blocked CLI. May be async; the button stays disabled until it settles. */
  onDone: () => void | Promise<unknown>;
}

/**
 * Open comments only.
 *
 * This used to count every comment on the branch, so reviewing a branch a second time opened
 * with "3 comments" already on the button — work that had been done and resolved rounds ago.
 * The count exists to say whether anything is still outstanding, and a resolved comment is not.
 */
function label(openCount: number): string {
  if (openCount === 0) return "Done reviewing";
  return `Done reviewing (${openCount} open)`;
}

/**
 * Shown only while someone is blocked on this workspace — `livediff <path> --wait` opens the
 * request that makes this appear. Clicking it releases the waiting CLI.
 */
export default function ReviewBanner({ openCount, onDone }: ReviewBannerProps) {
  const [busy, setBusy] = useState(false);

  const click = () => {
    setBusy(true);
    void Promise.resolve(onDone())
      .finally(() => setBusy(false))
      .catch(() => {});
  };

  return (
    <button
      onClick={click}
      disabled={busy}
      title="A livediff --wait command is blocked on this review"
      className="flex items-center gap-1.5 rounded bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      {busy ? "…" : label(openCount)}
    </button>
  );
}
