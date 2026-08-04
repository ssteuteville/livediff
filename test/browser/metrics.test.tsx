import { test, expect, vi } from "vitest";
import { useRef } from "react";
import { render } from "vitest-browser-react";
import { useTextMetrics } from "../../src/hooks/useVirtualRows.js";

// Browser tests assert with `expect`, not node:assert — Vite externalizes node builtins in the
// browser. The node project keeps node:assert/strict.

// The hook falls back to these until it has measured anything. A test that only checked for
// positive numbers would pass on the fallback and prove nothing.
const FALLBACK = { charWidth: 8, proseCharWidth: 7, lineHeight: 20 };

type Metrics = { charWidth: number; proseCharWidth: number; lineHeight: number; width: number };

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  const metrics = useTextMetrics(ref);
  return (
    <div
      ref={ref}
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: "13px",
        lineHeight: "20px",
        width: "800px",
      }}
      data-metrics={JSON.stringify(metrics)}
    >
      probe
    </div>
  );
}

async function measured(): Promise<Metrics> {
  render(<Probe />);
  let metrics: Metrics | null = null;
  await vi.waitFor(() => {
    const raw = document.body.querySelector("[data-metrics]")?.getAttribute("data-metrics");
    expect(raw, "probe never rendered").toBeTruthy();
    metrics = JSON.parse(raw!) as Metrics;
    expect(metrics.width, "the hook has not measured its container yet").not.toBe(0);
  });
  return metrics!;
}

test("text metrics come from a real measurement, not the fallback", async () => {
  const metrics = await measured();

  expect(metrics.width, "container width was not observed").toBe(800);
  expect(
    metrics.charWidth,
    "charWidth is still the hardcoded fallback — nothing was measured",
  ).not.toBe(FALLBACK.charWidth);
  expect(metrics.charWidth).toBeGreaterThan(0);
  expect(metrics.lineHeight).toBeGreaterThan(0);
});

test("prose is measured separately from monospace", async () => {
  const metrics = await measured();

  // The bug this pins: comment-slot heights once estimated proportional text with monospace
  // half-width metrics, which produced dead space in some slots and clipping in others.
  expect(
    metrics.proseCharWidth,
    "prose and monospace widths are identical — the prose probe is not measuring proportional text",
  ).not.toBe(metrics.charWidth);
  expect(metrics.proseCharWidth, "proseCharWidth is still the hardcoded fallback").not.toBe(
    FALLBACK.proseCharWidth,
  );
});
