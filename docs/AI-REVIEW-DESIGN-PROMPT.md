# Design prompt — AI-assisted code review for LiveDiff

_A brief for Claude Design. Paste this alongside screenshots of the current app._

---

## What you're designing for

**LiveDiff** is a local, browser-based diff viewer for people reviewing code — increasingly, code an AI agent just wrote. It runs on your own machine against a git worktree. There is no pull request, no server, no team, no login. One person, one screen, looking at what changed.

The reviewer leaves inline comments. The agent that wrote the code reads those comments and acts on them, then the diff updates live in the browser while the reviewer watches. The agent participates through a separate, non-visual channel — **you never need to design anything the agent looks at.** Design only for the human.

Screenshots of the current app are attached. Today it is a competent, conventional diff viewer: a file tree on the left, a unified or split diff on the right, inline comments, live updates. That is the floor you're building on, not a constraint you have to preserve.

## Your job, and what isn't your job

**Your job:** define what the best possible version of this looks and feels like. Invent the interface. Decide what the reviewer sees first, what they can reach for, how they move through a large change, and what makes the difference between a review that catches the problem and one that doesn't.

**Not your job — please actively ignore all of it:**

- Whether any of it can be built, or how hard it would be
- Anything about data, storage, state, schemas, or file formats
- Where information comes from or how it gets there
- Performance, scale, or technical constraints of any kind
- Backend behavior, APIs, or how the agent does what it does

If an idea requires magic to work, design it anyway and let us worry about the magic. **We are trying to find out what a unicorn looks like, not whether one can exist.** A wireframe that is 30% infeasible and genuinely great is far more valuable to us than one that is entirely safe.

Assume any information you want to show can be known. If the design needs the interface to know which parts of the change are risky, or what the author was trying to do, or which questions are still unanswered — assume it knows.

---

## The problem

Code review was designed for a world where a human wrote the code, slowly, and another human read it. Both of those have changed, and the interface hasn't.

**The volume broke it.** Teams are producing roughly twice as many changes as before, while reviewers still have about six hours a week to review them. Past roughly 400 lines, review quality collapses — attention degrades after the first screen and the reviewer starts skimming while believing they're reading. AI-authored changes now wait **4.6× longer** just to be _picked up_, because opening a 3,000-line diff is a task you postpone.

**The intent went missing.** When a person writes code, they carry the reasoning and can be asked. When an agent writes it, the reviewer receives a finished diff and is the first person to try to reconstruct _why any of it exists_. Review was never designed to recover missing intent, so reviewers guess — and guessing is slow and often wrong.

**Plausibility is the real danger.** AI-written code reads well. It's well-formatted, consistently named, and confidently structured, which makes review _harder_, not easier. The failure isn't obviously-bad code — it's code that looks exactly as trustworthy as the code beside it while resting on a wrong assumption. Every line looks equally considered. In truth about 5% was guesswork and 95% was mechanical, and the interface gives no hint which is which.

**The scariest part isn't in the diff.** An agent works within a limited window of attention. It changes a shared function correctly for the case in front of it and never looks at the eleven other places that call it. The resulting diff is complete, self-consistent, and wrong — and a diff, by its nature, cannot show you what it doesn't contain.

**Questions get lost.** A reviewer reading a change constantly needs to ask things — "is this supposed to retry?", "was this meant to change?" Today those questions get typed into comments and scattered across a long file, and the reviewer moves on without answers. Not having the answer makes the rest of the review harder, and finding the question again later is its own chore.

## The opportunity nobody else has

Every AI code review tool on the market reviews a **dead artifact**. The change is finished, the author is gone, and the tool must _infer_ intent by reading the diff. Inference is lossy and happens once.

LiveDiff is the only shape of this tool where **the author is still in the room.** The agent is running. It knows what it tried, what it rejected, and which parts it was unsure about. Nothing has to be reconstructed — it can be asked, and it can answer _while the review is happening_. The change can improve under the reviewer's eyes mid-review.

That is the thing to design around. **This is a conversation with a live author, not an autopsy.** Ask yourself constantly: if the person who wrote this were sitting next to you and you could interrupt them at any moment, what would the screen look like? It almost certainly doesn't look like a file tree and a wall of green and red.

---

## The design challenge

We generated ten feature concepts. Reviewing them, we realized they're mostly **one idea wearing ten hats**, and the interesting design work is unifying them rather than building ten things.

The recurring shape is what we've been calling a **lens**: a way of looking at the same change that decides _what you see_, _in what order_, _with what commentary_, and _rendered how_.

Everything below is a different lens. **We do not know what a lens looks like as an interface, and that's the central question we want you to answer.**

### The lenses

**Full diff** — everything, no opinion. The default today, and the fallback.

**A concern** — "show me only what's security-relevant," or error handling, or the public API surface. The rest of the change recedes. A 3,000-line diff is unreviewable in one sitting, but the 140 lines that touch error handling is a twenty-minute job you can do _well_. Four narrow passes beat one heroic one.

**Standing priorities** — the reviewer declares once what they always care about ("I care about error handling and anything touching auth; I don't care about test fixtures"), and every change is presented against that. These priorities can be written by the reviewer, proposed by the agent, or both. Design question we're stuck on: how does the interface _guide_ someone to their priorities without nagging, and how do you show that a priority was checked and found nothing — the absence of a finding being itself informative?

**A guided walkthrough** — the author picks a reading order and narrates it. "Start here, this is the new structure. Now here's who uses it. Now the part I'd argue about." Stops can span several files, and can point at code _outside_ the change for context. The reviewer should be able to comment on a _stop_ — on the idea — not only on a line, since that's where architectural feedback naturally lands.

**Escalating detail** — the change served in layers instead of all at once. First a handful of lines of prose and the four files that actually matter. Then the decisions inside them. Then everything else, including mechanical churn. You descend only where you're uneasy. Approving a layer locks it; a later edit that lands in an approved region re-opens it and says so.

**Against the original request** — the reviewer asked for three things. Show where each one landed, which is complete, which is partial, and which quietly didn't happen. Then the inverse, which matters just as much: code that serves _no_ stated request — where scope creep and unrequested "improvements" hide.

**What the author is unsure about** — the agent marks what it guessed at and why. "Guessed the retry budget, nothing in the repo pins it." This is a _garnish, not a foundation_ — you can't fully trust a self-report, and the design must never let this become the spine of the review. Good for a fast first pass; must not imply the unmarked parts are safe.

**What the author didn't do** — assumptions made, shortcuts taken, work deferred, edges known to be incomplete. Today this kind of thing is buried in a chat message the reviewer already scrolled past. As a lens it becomes countable and dispositionable: acknowledge it, challenge it, or turn it into work. We like this a lot and have **no idea what it looks like** — that's a real ask.

**Blast radius** — for each thing the change touches, what else depends on it, and specifically **what depends on it that is not in this diff**. "This function changed. Fourteen things call it. Two are in this change. Twelve are not — here they are." This is the negative space around the diff, and it's where the worst bugs live. It should feel like reassurance, not homework — the reviewer's reaction should be "good, I can see the edges of this," not "now I have twelve more files to read."

**Risk order** — the same files, sorted by how likely they are to be wrong rather than alphabetically. Probably a property of the other lenses rather than its own thing.

### The thing we're most excited about

**A lens shouldn't just filter — it should change how the change is drawn.**

Reviewing architecture, you might want a diagram of how the pieces now fit, not a diff at all. Reviewing error handling, you might want a flow of what can go wrong and where each failure is caught — with the code as a secondary detail you drop into. Reviewing the public API surface, maybe a before/after of the shape rather than line-by-line text.

The diff is one rendering of a change. It is not obviously the best one for most questions people actually have. **We'd love to see lenses that abandon the two-column diff entirely where something else communicates better.** This is the highest-ceiling idea in the brief and the one we most want pushed.

### Questions, in both directions

Separate from lenses, and possibly the most immediately valuable thing here.

**The reviewer asks the author.** Hovering a line — or selecting a range — offers two actions: leave a comment, or **ask a question**. A question is different from a comment: it's open until answered, it expects a real reply, and the reviewer needs to find their way back to it. Our current thinking is a `+` and a `?` sitting side by side, but that's a first guess, not a decision. The unsolved part is everything after the asking: where do open questions live, how does the reviewer see what's still unanswered, how do answers arrive without yanking them out of position, and how does a review that's waiting on three answers _feel_ different from one that isn't?

**The author asks the reviewer.** Before the reviewer reads anything, the agent poses the two or three decisions only a human can make. "Should this retry or fail fast?" "Is silently dropping a malformed entry acceptable?" This flips the reviewer from auditor to authority, which is both faster and a better use of a person — finding bugs is what machines are now good at; supplying judgment isn't. Three questions answered in ninety seconds can prevent an entire wrong direction.

Both directions produce the same thing: an unanswered question attached to a place in the code, which has to be visible, findable, and closeable. Whether they're one interface or two is yours to decide.

---

## Things the current app can't do that you should design around

These came out of using it. They're not the AI features, but the AI features have to live alongside them, and several are entangled:

- **Mark a file reviewed and have it collapse** until an edit lands in it, then reopen. Essential once a review spans several sittings — and it interacts with the "escalating detail" lens.
- **Expand context** above and below a hunk, to see unchanged lines without leaving the tool.
- **Open a whole file** and comment anywhere in it, not just on changed lines. Some review questions are about the part that _didn't_ change. Needs some navigation model — tabs, a stack, something.
- **Jump to a definition.** Click a symbol, land where it's defined. If it's in the change, move there; if it isn't, open it. This is the natural completion of blast radius — knowing something has callers is half the need, reaching them is the other half.
- **Sort and filter the file list**, including by pattern. Risk order is one sort among several.
- **Render markdown** rather than diffing it as raw text — prose read as prose.
- **Edit a comment** after writing it.

## What we'd like from you

Wireframes we can react to and iterate on. Low fidelity is fine and probably better — we're looking for structure and ideas, not visual polish.

Most useful to us:

1. **The unified frame.** How does one interface hold all of these without becoming a control panel? How does a reviewer know lenses exist, choose one, tell which is active, move between them, and get back to the full diff? This is the question we're most stuck on.
2. **The opening screen.** A reviewer opens a 3,000-line change written overnight by an agent. What's on screen? What are they looking at in the first ten seconds? This is where the 4.6× pickup delay gets won or lost.
3. **Two or three lenses drawn concretely**, including at least one that isn't a diff at all.
4. **The question flow** end to end — asking, waiting, being answered, finding your way back.
5. **A few states we'll actually hit:** a lens that's gone stale because the code changed underneath it; a review waiting on unanswered questions; a change with nothing interesting in it, where the interface should get out of the way.

Feel free to reject any of our framing. If "lens" is the wrong organizing idea, tell us what's better. If two of these concepts should be one, merge them. If the reviewer's real problem is something we haven't named, design for that instead.

We are not looking for a safe evolution of a diff viewer. We are trying to find out what code review should look like now that the author is a machine that's still in the room.
