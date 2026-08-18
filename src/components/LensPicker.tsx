import { useEffect, useRef, useState } from "react";
import type { Lens } from "../../shared/types.ts";

const FULL_DIFF = "Full diff";

function countLabel(count: number): string {
  if (count === 1) return "1 file";
  return `${count} files`;
}

function fileSummary(count: number): string {
  if (count === 0) return "matches nothing in this diff";
  return countLabel(count);
}

function LensRow({
  label,
  why,
  summary,
  active,
  muted,
  onSelect,
}: {
  label: string;
  why: string | null;
  summary: string | null;
  active: boolean;
  muted: boolean;
  onSelect: () => void;
}) {
  const tone = active
    ? "bg-blue-600 text-white"
    : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800";
  const detail = active ? "text-blue-100" : "text-neutral-500 dark:text-neutral-400";
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-lens-option={label}
      onClick={onSelect}
      className={"w-full px-3 py-2 text-left " + tone}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className={"truncate font-medium " + (muted ? "italic" : "")}>{label}</span>
        {summary !== null && <span className={"shrink-0 text-xs " + detail}>{summary}</span>}
      </span>
      {why && <span className={"mt-0.5 block text-xs " + detail}>{why}</span>}
    </button>
  );
}

/**
 * The header's readout of how the diff is currently being read, and the way to change it.
 *
 * It always states the applied lens — a filtered diff that looked like an unfiltered one would be
 * a reviewer confidently reading the wrong thing. The catalog lives behind a click because the
 * chrome's job is the current state, not the menu.
 */
export function LensPicker({
  lenses,
  active,
  counts,
  onSelect,
}: {
  lenses: Lens[];
  active: Lens | null;
  counts: Map<string, number>;
  onSelect: (name: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && box.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (lenses.length === 0) return null;

  const choose = (name: string | null) => {
    onSelect(name);
    setOpen(false);
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        data-lens-control
        data-lens-active={active ? "true" : "false"}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={
          "flex items-center gap-1.5 rounded border px-2 py-1 " +
          (active
            ? "border-blue-600 bg-blue-600 text-white"
            : "border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300")
        }
        title="Choose how to read this change"
      >
        <span className="text-neutral-400 dark:text-neutral-500">lens:</span>
        <span className="max-w-40 truncate font-medium">{active ? active.name : FULL_DIFF}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          data-lens-menu
          className="absolute left-0 z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <LensRow
            label={FULL_DIFF}
            why="every file in the change"
            summary={null}
            active={active === null}
            muted={false}
            onSelect={() => choose(null)}
          />
          <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
          {lenses.map((lens) => (
            <LensRow
              key={lens.name}
              label={lens.name}
              why={lens.why}
              summary={fileSummary(counts.get(lens.name) ?? 0)}
              active={active?.name === lens.name}
              muted={(counts.get(lens.name) ?? 0) === 0}
              onSelect={() => choose(lens.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
