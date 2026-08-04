import { useState } from "react";

interface ReviewBannerProps {
  openCount: number;
  total: number;
  /** Releases the blocked CLI. May be async; the button stays disabled until it settles. */
  onDone: () => void | Promise<unknown>;
}

function label(openCount: number, total: number): string {
  if (total === 0) return "Done reviewing";
  if (openCount === total) return `Done reviewing (${total} comments)`;
  return `Done reviewing (${total} comments, ${openCount} open)`;
}

/**
 * Shown only while someone is blocked on this workspace — `livediff <path> --wait` opens the
 * request that makes this appear. Clicking it releases the waiting CLI.
 */
export default function ReviewBanner({ openCount, total, onDone }: ReviewBannerProps) {
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
      {busy ? "…" : label(openCount, total)}
    </button>
  );
}
