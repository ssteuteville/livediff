import { useState } from "react";

function label(openCount, total) {
  if (total === 0) return "Done reviewing";
  if (openCount === total) return `Done reviewing (${total} comments)`;
  return `Done reviewing (${total} comments, ${openCount} open)`;
}

/**
 * Shown only while someone is blocked on this workspace — `livediff <path> --wait` opens the
 * request that makes this appear. Clicking it releases the waiting CLI.
 */
export default function ReviewBanner({ openCount, total, onDone }) {
  const [busy, setBusy] = useState(false);

  const click = () => {
    setBusy(true);
    Promise.resolve(onDone()).finally(() => setBusy(false));
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
