# Research

This page records the evidence that remains useful after a task is complete. It is deliberately shorter than the original investigations; commit history retains measurements, probes, and implementation details.

## Large diffs

The large-diff investigation established three durable facts:

- Repeated per-file Git processes were an avoidable server cost and should be reduced before changing the renderer.
- Parsing is not the primary bottleneck; browser DOM node count is.
- Full virtualization has real trade-offs for native browser find and variable-height inline comment threads.

The working direction is bounded rendering with clear navigation. The fast renderer already uses a virtual row window and an in-app find flow that can search content outside the DOM. Native browser find and Safari compatibility are deliberately not requirements for that renderer. A single minified line is a special case: it can defeat row-based rendering, so extremely dense generated content receives a safe highlighting cutoff rather than syntax-tokenizing indefinitely.

## Known limitations

- Diff refetches are not yet debounced or cancelled. A worktree change rebuilds the model, while scroll anchoring preserves the reader's position rather than reducing the work.
- The row model can be flattened again when the comments array changes identity, even if no comment changed.
- Comment placement is keyed by file path, side, and line number. A comparison-base change can leave a comment unanchored in the drawer. The original source line is retained and shown to agents, but the browser does not yet re-anchor by content.

## Integration research

The comparison with cmux-hub reinforced the CLI-first choice. A terminal-specific socket can be excellent within one host application, but LiveDiff's CLI keeps the same review loop available to multiple agent environments and plain terminal workflows.

The comparison also identified candidates to revisit only when they solve an observed user problem: hosted PR context, commit-history browsing, interactive base selection, and configurable actions.

## Resolved findings

- Deep links must select the named workspace rather than fall back to the first registered one.
- Build artifacts must be produced before end-to-end fixture generation, so fresh CI checkouts exercise the same runtime path as local development.
- Server TypeScript migration required a compiled runtime boundary; source-level type stripping was not a reliable replacement for the package's runtime requirements.

## Research practice

New research should record the question, evidence, conclusion, and the decision it changes. Keep only conclusions that remain relevant here; put one-off probes and completed handoffs in the commit that introduced them.
