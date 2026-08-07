import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildOffsets, rowAt, visibleRange } from "../diff-model.js";
import type { RefObject } from "react";
import type { DiffMetrics, DiffRow } from "../diff-model.js";

export interface TextMetrics {
  charWidth: number;
  proseCharWidth: number;
  lineHeight: number;
  width: number;
}

type ElementRef = RefObject<HTMLElement | null>;

interface VirtualRowsOptions {
  rows: DiffRow[];
  metrics: DiffMetrics;
  containerRef: ElementRef;
  overscan?: number;
}

interface ScrollToRowOptions {
  align?: "center" | "start";
}

interface ScrollAnchor {
  key: string;
  delta: number;
}

interface ScrollAnchorOptions {
  rows: DiffRow[];
  containerRef: ElementRef;
  offsets: Float64Array;
}

/**
 * Measure the font actually in use, so wrapped-row heights can be computed instead of observed.
 *
 * The whole no-jank property depends on this being right: one character measured once gives every
 * row's height for free. Re-measures on resize, and on font load — a webfont arriving late would
 * otherwise silently invalidate every height computed before it.
 */
const HIDDEN_PROBE = "position:absolute;visibility:hidden;white-space:pre;";

// Comment bodies are proportional text at a different size from the diff's monospace, so one
// character width cannot answer for both. Matches the card body's `font-sans text-sm`.
const PROSE_FONT =
  'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;';

function probeWidth(el: HTMLElement, css: string, sample: string): number {
  const probe = document.createElement("span");
  probe.textContent = sample;
  probe.style.cssText = HIDDEN_PROBE + css;
  el.appendChild(probe);
  const width = probe.getBoundingClientRect().width / sample.length;
  el.removeChild(probe);
  return width;
}

export function useTextMetrics(ref: ElementRef): TextMetrics {
  const [metrics, setMetrics] = useState<TextMetrics>({
    charWidth: 8,
    proseCharWidth: 7,
    lineHeight: 20,
    width: 0,
  });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const charWidth = probeWidth(el, "", "0".repeat(100));
    // Averaged over prose rather than a repeated glyph: proportional widths vary per character,
    // and "0" repeated would overstate a typical sentence by a third.
    const proseCharWidth = probeWidth(
      el,
      PROSE_FONT,
      "the quick brown fox jumps over the lazy dog, and then it does so again ",
    );

    const style = getComputedStyle(el);
    const parsed = parseFloat(style.lineHeight);
    const lineHeight = Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.5;

    setMetrics((prev) => {
      const next = {
        charWidth: charWidth || prev.charWidth,
        proseCharWidth: proseCharWidth || prev.proseCharWidth,
        lineHeight,
        width: el.clientWidth,
      };
      const same =
        Math.abs(next.charWidth - prev.charWidth) < 0.01 &&
        Math.abs(next.proseCharWidth - prev.proseCharWidth) < 0.01 &&
        Math.abs(next.lineHeight - prev.lineHeight) < 0.01 &&
        next.width === prev.width;
      return same ? prev : next;
    });
  }, [ref]);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [measure, ref]);

  return metrics;
}

/**
 * Virtualize a row list against a scroll container.
 *
 * Deliberately hand-rolled rather than pulled from a library: because heights here are computed
 * rather than measured, the usual hard part — estimating, measuring, and reconciling — does not
 * exist, and what remains is an offset table plus a binary search. A general virtualizer would
 * have to be talked out of measuring.
 *
 * Returns the rows to render, their absolute offsets, the total height, and a scrollToRow.
 */
export function useVirtualRows({ rows, metrics, containerRef, overscan = 8 }: VirtualRowsOptions) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const frame = useRef<number | null>(null);

  const offsets = useMemo(() => buildOffsets(rows, metrics), [rows, metrics]);
  const totalHeight = offsets[offsets.length - 1] ?? 0;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const read = () => {
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight);
    };
    read();

    // Coalesce to one read per frame: scroll fires far faster than React can usefully re-render.
    const onScroll = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        read();
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [containerRef]);

  const range = useMemo(
    () => visibleRange(offsets, scrollTop, viewport || 800, overscan),
    [offsets, scrollTop, viewport, overscan],
  );

  const scrollToRow = useCallback(
    (index: number, { align = "center" }: ScrollToRowOptions = {}) => {
      const el = containerRef.current;
      if (!el || index < 0 || index >= offsets.length - 1) return;
      const top = offsets[index] ?? 0;
      const height = (offsets[index + 1] ?? top) - top;
      const target = align === "start" ? top : top - Math.max(0, (el.clientHeight - height) / 2);
      el.scrollTo({ top: Math.max(0, target), behavior: "auto" });
    },
    [containerRef, offsets],
  );

  /** The row currently at the top of the viewport — the anchor for keeping scroll stable. */
  const topRow = useCallback(() => rowAt(offsets, scrollTop), [offsets, scrollTop]);

  return { range, offsets, totalHeight, scrollToRow, topRow, viewport, scrollTop };
}

/**
 * Keep the reader's place across a diff update.
 *
 * livediff refetches the whole diff whenever the worktree changes, which reorders and renumbers
 * rows. Without this, saving a file while scrolled deep into a diff teleports you somewhere else —
 * the failure that would make a virtualized view feel broken in exactly the situation livediff
 * exists for. Anchoring on a row's identity rather than its index survives the update.
 */
export function useScrollAnchor({ rows, containerRef, offsets }: ScrollAnchorOptions): void {
  const anchor = useRef<ScrollAnchor | null>(null);
  const latest = useRef<Pick<ScrollAnchorOptions, "rows" | "offsets">>({ rows, offsets });
  latest.current = { rows, offsets };

  // Remembered on every scroll rather than when the rows change, because by the time a change is
  // observable the old rows are already gone — anchoring on a dependency would restore whatever
  // position the reader was in when the model was last replaced, which is usually the top.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const remember = () => {
      const { rows: current, offsets: at } = latest.current;
      const index = rowAt(at, el.scrollTop);
      const row = current[index];
      anchor.current = row ? { key: row.key, delta: el.scrollTop - (at[index] ?? 0) } : null;
    };
    remember();
    el.addEventListener("scroll", remember, { passive: true });
    return () => el.removeEventListener("scroll", remember);
  }, [containerRef]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const saved = anchor.current;
    if (!el || !saved?.key) return;
    const index = rows.findIndex((r) => r.key === saved.key);
    if (index === -1) return; // the anchored row is gone; leave the scroll where it is
    const top = (offsets[index] ?? 0) + saved.delta;
    if (Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top;
  }, [rows, offsets, containerRef]);
}
