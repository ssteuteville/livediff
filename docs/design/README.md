# Design artifacts

Saved exports from design tools, kept so the wireframes outlive the tool that made them.

## `livediff-ai-wireframes.dc.html`

Wireframes for the AI review UX — the lens overlay, walkthroughs, questions, notes, and the
per-file activity panel. Summarized in [`../AI-REVIEW-UX.md`](../AI-REVIEW-UX.md).

Exported from a Claude Design project:
<https://claude.ai/design/p/a0bf059d-4721-4c88-9fc2-21afe65d2ebc>

**It does not render standalone.** The file loads a `support.js` runtime that supplies the
`<x-dc>`, `<sc-for>`, and `<sc-if>` elements and evaluates the `text/x-dc` script block. That
runtime is not vendored here — open the project link to view it. The markup and the component
logic are complete in the file, so it is readable as a source of truth even where it is not
runnable.
