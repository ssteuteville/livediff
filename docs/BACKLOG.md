# Backlog

Ideas worth keeping, not yet scheduled. Nothing here is designed or committed to.

Each entry records what was wanted and why, so it can be picked up cold.

## Diff viewing

### Render markdown files instead of diffing them raw

A `.md` file in a diff is read as prose, not as code, and a raw patch is the wrong view for it.
Wanted: a way to see the rendered result in the UI, probably toggled per file rather than
replacing the diff.

### Expand context around a hunk

A hunk shows the changed lines and little else. Reviewing a change often needs the lines
surrounding it, and today that means leaving the tool. Wanted: expand up/down from a hunk to
reveal unchanged context on demand.

### View and comment on a whole file

Some review questions are about the file, not the change — and the answer is in the part that
did not change. Wanted: open the full file, still able to comment on any line, with tabs or
some other navigation so it does not replace the diff view.

### Jump to a symbol's definition

Cmd+click a symbol in the UI and land on its definition. If the target is inside the diff,
scroll to it; if it is not, open it through whatever navigation the full-file view uses. This
is the natural companion to the blast-radius idea — seeing that something has callers is only
half the need, reaching them is the other half.

### Sort and filter the file list

Filter the diff's file list by regex, and sort it by something other than path. An AI-supplied
risk order is one possible sort, but the general capability should not depend on a model.

## Review workflow

### Mark a file as reviewed, and collapse it until it changes

GitHub parity. A reviewed file collapses and stays collapsed until an edit lands in it, at
which point it reopens. Makes a long diff tractable across several sittings, and pairs with
the live-updating model — the collapse has to survive a refresh but not a change.

### Edit my own comments

Comments are written mid-thought and often need fixing. Today they cannot be edited.

### Confirm whether replies to my own comments reach the agent

Open question rather than a feature: if the reviewer replies to their own comment, does that
reply appear in what the agent reads? If it does not, the natural way to add a clarification
to a note already written is silently lost. Worth verifying before designing anything on top
of it.

## AI review

These start with [`AI-REVIEW-BRAINSTORM.md`](AI-REVIEW-BRAINSTORM.md) — ten concepts, the research
and competitor survey behind them, and the CLI shapes each one implies. Reviewing it turned up
that the ten were largely one idea wearing ten hats, and the UX that came out the far side is
written up in [`AI-REVIEW-UX.md`](AI-REVIEW-UX.md). Read the brainstorm for _why_ an entry exists
and what it was competing against; read the UX doc for what it should look like.

The entries are listed roughly in build order — the first three are the substrate everything else
sits on.

### Per-file activity: one badge for comments, questions, and notes

The file header's **comments** button becomes a message icon with a count covering comments +
questions + notes, and renders nothing at all when the count is zero. The panel it opens gains
three tabs with per-tab empty states. Doable ahead of questions and notes existing — it starts as
a rename plus a tab bar with two empty tabs, and stops the header from needing a second and third
button later.

### Lens selector: the full-screen overlay

**The header control shipped** — it reads out the applied lens (`Full diff` when none) and inverts
while one is active. It currently opens a dropdown listing the set with each lens's `why` and file
count. Rejected alternatives: a floating action button, and a row of lens pills in the top bar
(doesn't survive more than three or four).

Still wanted: replacing the dropdown with the full-screen overlay, once there are walkthroughs,
questions, and notes to fill its other three tabs. A dropdown is the right size for one tab.

### Lenses that annotate

**Filtering shipped** — a lens narrows the file list and diff body to the files it matches, and
marks new-side line ranges as a translucent tint. See
[`superpowers/specs/2026-08-07-filter-lenses-design.md`](superpowers/specs/2026-08-07-filter-lenses-design.md).
Authorship is settled too: the agent writes the whole set at handoff, and a `.livediff` file at the
worktree root carries the user's standing instructions.

Still wanted: decorating lines with short inline breadcrumbs (`? unsure`, `● 2 callers not shown`),
some of which are buttons. Undefined: what a breadcrumb button can do beyond jumping to a location.

Highlights render in the fast renderer only. The classic renderer is `@git-diff-view`'s `DiffView`,
which exposes no per-line styling seam, so drawing them there would mean reaching into a third-party
component's DOM. Filtering works in both. Classic says so on screen rather than quietly omitting the
marks, and the notice goes away with the renderer.

### Lenses that render something other than a diff

A lens can offer a high-level view that abandons the two-column diff — a blast-radius node graph
where the callers _not_ in the change are the point, or an error flow ending in an uncaught path.
Diagrams first; they are the cheapest form and already carry most of the value. This is the
highest-ceiling piece of the whole idea.

### Walkthroughs as ordered collections of lenses

Each step names a lens and a sentence of narration. Two things make it more than a bookmark list:
while a walkthrough is active the lens picker is scoped to its steps (with an escape hatch), and
all of its lenses should be applicable at once for a combined view. A walkthrough can carry its
own high-level visual, the same as a lens. Mechanism for combining lenses is undecided.

### Ask a question on a line and get answered during the review

Hover reveals `+` (comment, deferred to review submit) and `?` (question, answered live).
A pending question shows as answering, then the answer lands in place; a line carrying both
renders as one thread with tabs rather than two panels. The overlay's questions tab is the
tracker — every question, its state, and a jump-to-diff link — which is the actual fix for
questions being unfindable later. The real-time transport is undecided and is the hard part.

### Agent notes

The inverse of a question: the agent flags something unprompted, anchored to a line, no reply
expected. Listed in the overlay with jump-to-diff. Stays a garnish by design — a review must
never depend on the agent having noticed something.

### Lens staleness

A lens is computed against a diff that keeps moving. Undecided whether an applied lens goes stale
and says so, silently regenerates, or behaves differently per lens. Earlier thinking on
walkthroughs leaned toward invalidating on any diff change; that may be too blunt for lenses.

### Blast radius without language tooling

Blocker for the blast-radius lens, worth settling before designing it. livediff runs against
arbitrary repos and can assume nothing but git — no `tsc`, no `oxlint`, no AST, and not
necessarily JS/TS at all. "What calls this and isn't in the diff" therefore has no mechanical
answer, which makes blast radius _more_ agent-dependent than it appears, not less.

---

_Captured 2026-08-07 from review comments on `docs/AI-REVIEW-BRAINSTORM.md`
(`d6366f1a`, `949778c2`, `1ba037eb`, `6c518218`, `1ff0cf9f`, `7e45eace`), and extended the same
day from the Claude Design wireframes._
