# AI review UX — the shape we landed on

Where the ten concepts in [`AI-REVIEW-BRAINSTORM.md`](AI-REVIEW-BRAINSTORM.md) ended up after
wireframing. This is the UX model, not a technical design. Nothing here is scheduled; the
individual pieces are tracked in [`BACKLOG.md`](BACKLOG.md).

Source wireframes: [`design/livediff-ai-wireframes.dc.html`](design/livediff-ai-wireframes.dc.html)
(saved from Claude Design — see the README in that directory).

---

## The one-line version

Four surfaces, one entry point. A **lens selector in the header** opens a full-screen overlay
holding **lenses**, **walkthroughs**, **questions**, and **notes**. The diff itself gains inline
annotations from the applied lens, and a per-file activity panel that now covers three kinds of
thing instead of one.

## Entry point

A control in the app header, not a floating action button. The wireframe explored a FAB and it
lost — the header already carries the diff's other global controls (base selector, split/unified,
comment filter), and a lens is the same kind of thing.

The control reads out the applied lens (`lens: Full diff` when none is applied) and inverts when a
lens is active, so the reviewer can never be looking at a filtered diff without knowing it.
Clicking it opens the overlay.

An earlier variant put every lens in the top bar as a row of pills. Rejected: it doesn't survive
more than three or four lenses, and it puts the _catalog_ in the chrome when what the chrome needs
to show is the _current state_.

## The overlay

Full screen, four tabs, and a way back to the diff.

| Tab          | Holds                                                         |
| ------------ | ------------------------------------------------------------- |
| lenses       | the lens catalog, searchable, as cards                        |
| walkthroughs | ordered collections of lenses, with narration per step        |
| questions    | reviewer→agent questions, with pending count in the tab label |
| agent notes  | agent→reviewer notes, unprompted, with count in the tab label |

Full screen rather than a drawer because choosing a lens is a mode switch, not a peek — you are
deciding how to read the change, and a diagram or a walkthrough overview wants the whole canvas.

## Lenses

> **Shipped so far:** filtering, plus new-side line-range highlights, the header control, and
> `livediff lens` — designed in
> [`superpowers/specs/2026-08-07-filter-lenses-design.md`](superpowers/specs/2026-08-07-filter-lenses-design.md).
> Annotations, rendering, and walkthroughs are not built. The header control opens a dropdown
> rather than the full-screen overlay described below, which waits on there being four tabs' worth
> of things to put in it.

A lens does three things. Any given lens might do one, two, or all three.

**1. It filters.** The lens narrows both the file list and the diff body to the set of places it
cares about. This is what makes a 3,000-line change into four twenty-minute passes.

**2. It annotates.** Applied to the diff, a lens decorates lines with small inline breadcrumbs.
Some are pure text (`? unsure`, `→ retried ×3 then throws`, `unrequested: hardcoded budget`).
Some are buttons that do something — the blast-radius lens's `● 2 callers not shown` is the
obvious first one, and clicking it should take you to those callers.

> **Open:** the vocabulary of what an annotation button can _do_ is undefined. Jump-to-location is
> the clear first case. Whether annotations can open a diagram, expand context, or start a
> sub-review is unanswered.

**3. It renders.** A lens can offer a "view high level" mode that abandons the two-column diff for
something that communicates better. This is the highest-ceiling part of the idea and the reason
the lens concept beat the alternatives.

Two rendering modes are drawn in the wireframes:

- **Blast radius** — a node graph. The changed symbol in the middle, callers around it, callers
  _not in the diff_ drawn dashed and in warning color. The point of the drawing is the negative
  space, which a diff structurally cannot show.
- **Error flow** — a left-to-right flow of what goes wrong and where it's caught, terminating in
  a dashed "still fails — uncaught" node.

Diagrams are the cheapest form of this and the place to start. Richer generative rendering is a
later question.

### Lenses drawn so far

| Lens                                  | Filters | Annotates | Renders |
| ------------------------------------- | ------- | --------- | ------- |
| Full diff                             | —       | —         | —       |
| Unsure — what the agent guessed       | ✓       | ✓         |         |
| vs Request — what landed, what didn't | ✓       | ✓         |         |
| Blast radius                          | ✓       | ✓         | ✓ graph |
| Error flow                            | ✓       | ✓         | ✓ flow  |

The catalog is searchable, which is the tell that it's expected to grow past what fits on a
screen.

## Walkthroughs

A walkthrough is **a collection of lenses**, ordered, with narration attached to each step.

Each step names a lens and a sentence of prose: _"Stop 1 — start with who else calls this
(Blast radius)."_ Selecting a step applies that step's lens and returns you to the diff.

Two behaviors distinguish a walkthrough from a bookmark list:

- **It scopes the lens picker.** While a walkthrough is active, the lenses tab shows only that
  walkthrough's steps, plus an explicit escape hatch back to the full catalog. The reviewer is
  being led, and the interface stops offering side roads until they say otherwise.
- **Its lenses can be used together.** All the lenses in a walkthrough should be applicable at
  once, giving a combined view of everything the author thought mattered. Mechanism undecided.

Walkthroughs can have their own high-level visual, the same way a lens can — an overview of the
whole tour rather than of one step.

The header control reads out the walkthrough and step when one is active.

## Questions

Reviewer→agent, answered in real time during the review. This is the piece with no equivalent in
any competing tool, because every competing tool reviews a change whose author has already left.

Hovering a diff line reveals two buttons: `+` to comment and `?` to ask. They are deliberately
different things:

- A **comment** is deferred. The agent reads it when the review is submitted.
- A **question** is live. It shows `agent is answering…`, then the answer arrives in place.

A line that has both renders as one thread with tabs to flip between them, so a line never sprouts
two competing panels.

The questions tab in the overlay is the tracker — every question, its state, and a jump-to-diff
link. This directly answers the pain that started the idea: _asked questions become impossible to
find again, and reviewing without the answer makes the rest of the review harder._

The real-time mechanism is **to be determined**.

The wireframes also keep the reverse direction from the first round — the agent posing two or
three decisions only a human can make, before the reviewer reads anything. Not committed to.

## Notes

The agent flags something unprompted, anchored to a line: _"Guessed the retry budget of 3 —
nothing in the repo pins it, flagging so it's a choice, not an accident."_ Or _"Renamed 4 exports
that weren't requested — checked callers, all updated, but wanted you to know."_

Notes are the inverse of questions: agent→reviewer, no reply expected, jump-to-diff from the
tracker.

Because a note is the agent's self-report, it stays a garnish. A review must never depend on the
agent having noticed something.

## File activity

Today each file header carries a **comments** button. It becomes a **message icon with a badge**
counting comments + questions + notes on that file, and disappears entirely when the count is
zero — a clean file should look clean.

The panel that button opens gets three tabs — comments, questions, notes — each with its own empty
state.

## The view-file surface

The wireframes sketch this as an extension of the same model rather than a separate mode: open a
file's **entire contents**, not just its changed hunks, and have lens annotations, comments,
questions, and notes all still work on it. Many review questions are about the part that _didn't_
change, and that's exactly where the answer lives.

This is the natural home for jump-to-definition, which is what makes a blast-radius annotation
actionable rather than merely informative.

---

## Open questions

- What can an annotation button do, beyond jumping to a location?
- How do multiple lenses combine — inside a walkthrough, and in general?
- ~~What is a lens's lifetime?~~ **Settled:** per handoff. The agent writes the whole set when it
  stops working, and the next handoff replaces it. Nothing keeps a lens current in between, which
  is also why highlights need no drift anchor — a lens does not outlive the edits that would move
  it. Staleness detection stays deferred rather than solved.
- ~~Who authors a lens?~~ **Settled:** the agent, at handoff, in one `livediff lens set`. A
  `.livediff` file at the worktree root holds the user's standing instructions in prose — livediff
  never parses it, which is the whole reason it cannot break.
- How does a question actually reach a running agent and get answered live?
- What does "not in this diff" mean without language tooling? livediff runs against arbitrary
  repos and can assume nothing but git — no `tsc`, no `oxlint`, no AST. Blast radius is therefore
  _more_ agent-dependent than it looks.
