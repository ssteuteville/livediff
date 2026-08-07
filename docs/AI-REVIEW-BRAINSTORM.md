# AI-assisted review — 10 concepts

Brainstorm for review. Nothing here is decided, nothing is built. Leave comments inline and I'll work through them.

---

## The opening this product has

Every AI review tool on the market reviews a **dead artifact**. A PR lands, the agent that wrote it is gone, and the reviewer is the first person to try to reconstruct why any of it exists. The research is blunt about the cost: agent PRs wait **4.6× longer** before a reviewer even picks them up, and reviewers are handed "a completed diff without the same implementation journey or decision trail."

LiveDiff is the only shape of this tool where **the author is still in the room.** The agent is running, its session is warm, it knows what it tried and rejected, and it can be asked. Nothing has to be reconstructed because it can be _volunteered_.

That's the whole thesis. Every concept below is an application of it.

The second opening is the product's existing bet: **the CLI is the interface, and the agent drives.** Competing tools bolt an AI onto a review UI a human operates. Here the agent can author review structure the same way it authors code — as a first-class artifact it maintains while it works. So all ten concepts are specified CLI-first.

### What the research says the pain actually is

| Pain                                                      | Evidence                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Missing intent — reviewers reconstruct "why" from scratch | Reviewers get a diff with no decision trail; review "wasn't built to recover missing intent" |
| Plausibility — AI code passes a casual read               | Makes review _harder_, not easier                                                            |
| Volume vs. capacity                                       | PR volume up ~98%; reviewers have ~6.4 hrs/week                                              |
| Size collapse                                             | Past ~400 lines, review quality degrades sharply                                             |
| Defect profile                                            | Logic +75%, readability 3×, security up to 2.74×, error handling ~2× vs. human code          |
| Pickup latency                                            | AI PRs wait 4.6× longer to be picked up, 2.47× longer overall                                |
| Reviewer burnout                                          | Descriptions that don't match the code; authors who can't answer a basic question            |

### What's already out there

- **CodeRabbit "Change Stack"** — reorders a flat file list into dependency-ordered "cohorts," layer by layer. The closest thing to a guided walkthrough that ships today. It infers structure _after the fact_ from the diff.
- **Greptile** — whole-codebase context, highest bug-detection rates.
- **Graphite** — stacked diffs; review structure comes from splitting PRs, not from the review UI.
- **Cursor Bugbot** — high selectivity, few comments, IDE-bound.
- **"Session provenance"** (emerging idea, not really shipped) — store task intent, tool calls, and checkpoint outcomes with the PR.

**Where we can beat all of it:** they all _infer_ structure and intent from the artifact. We can have the agent _declare_ it while the work is happening, and keep it live as the code changes. Inference is lossy and one-shot. Declaration is accurate and updatable.

---

## The ten

Grouped by what they do to the review, not by size.

### Group A — The reviewer says what matters

#### 1. Review Contract

**Pitch:** You declare what you care about once. Every diff is answerable against it.

You write down your standing review priorities — "I care about error handling, the public API surface, and anything touching auth; I don't care about test fixtures or generated files" — and they persist per-repo. The agent must then _answer the contract_ before asking for review: for each clause, what in this diff touches it, and what it did about it.

The browser puts the contract at the top as a scorecard. Clauses with hits are expanded by default; the rest of the diff collapses beneath. Front-and-center becomes a structural property, not a thing you scroll to find.

The important part is the inversion. Today the reviewer reads everything and hopes to notice what matters. Here the agent is accountable for routing the diff through your priorities, and the ones it can't satisfy are visible as gaps rather than silence.

```bash
livediff emphasis add "error handling" --paths 'server/**' --why "retries are load-bearing"
livediff emphasis add "public API surface" --paths 'shared/types.ts'
livediff emphasis mute 'test/fixtures/**'
livediff emphasis list
livediff emphasis answer "error handling" --hunks server/git.ts:120-160 \
  --note "added a bounded retry; unbounded before"
livediff emphasis gaps          # clauses this diff never addressed — the agent must justify
```

**Beats:** nothing on the market lets the reviewer pre-declare taste and hold the AI to it. Every tool decides for you what's worth flagging.

---

#### 2. Review Lenses

**Pitch:** Saved, reusable review passes. Same diff, one concern at a time.

A lens is a named filter with a point of view: `security`, `public-api`, `error-handling`, `perf`, `naming`. Running one hides everything the lens doesn't care about and annotates what's left with lens-specific commentary from the agent.

This is the direct answer to the ~400-line collapse. A 3,000-line diff is unreviewable as one object, but "the 140 lines this touches that are security-relevant" is a twenty-minute job you can actually do well. Four lenses over four sittings beats one heroic pass that degrades after the first screen.

Lenses are shareable and repo-local, so a team accumulates its own review vocabulary over time.

```bash
livediff lens create security --prompt "auth, secrets, input validation, injection, ACL"
livediff lens run security              # agent annotates; browser filters to the lens
livediff lens list
livediff lens status                    # which lenses have been run on this diff, and when
livediff lens stale                     # lenses invalidated by edits since they last ran
```

**Beats:** CodeRabbit and Greptile give you one omniscient pass. Lenses give you _your_ passes, repeatable, with explicit staleness when the code moves under them.

---

### Group B — The agent declares what it knows

#### 3. Confidence Map

**Pitch:** The agent marks the code it guessed at. Your attention goes there first.

Every other tool points AI at human code to find bugs. This points the AI at _its own_ code to find doubt. As the agent writes, it flags hunks it is unsure about, with the reason: "guessed at the retry semantics — no test covered this," "copied the pattern from `comments.ts` without checking whether it applies," "this is the part I'd review first if I were you."

The browser renders it as a heat overlay on the file tree and a gutter mark in the diff. Sorting the tree by confidence puts the scary code at the top.

This is my favourite concept in the list, because it attacks the pain point nothing else does. The research finding is that AI code is dangerous precisely because it's _plausible_ — it reads fine. Uniform-looking code hides which 5% is load-bearing guesswork. The agent knows which parts those are at the moment it writes them, and that knowledge is currently thrown away.

```bash
livediff flag server/git.ts:140-155 --confidence low \
  --why "guessed the retry budget; nothing in the repo pins it"
livediff flag src/App.tsx:88 --confidence high --why "mechanical rename"
livediff confidence               # ranked list, lowest first
livediff confidence --min low     # just the scary parts
```

**Beats:** everything. No shipping tool asks the author to self-report uncertainty, because on every other platform the author is a human with an incentive to look competent. An agent has no ego to protect.

---

#### 4. Why-Trail

**Pitch:** Select any hunk, see the instruction that caused it.

Each hunk carries a link back to the request that produced it — your words, the decision the agent made, and what it rejected. Click a line, get "this exists because you said _'the caret should be an x'_; I put it in `CommentThread` rather than `Composer` because the composer unmounts on submit."

This is the single most-cited pain in the research: reviewers receive a finished diff and have to reconstruct intent from the ticket and the code alone. The reconstruction is expensive and often wrong. The agent has this information for free while it works — it's just never asked to write it down in a place bound to the code.

The inverse view matters as much: **which of my instructions produced no code?** That's where silently-dropped requirements hide.

```bash
livediff trace src/components/CommentThread.tsx:212
livediff why --intent "make the caret an x"     # every hunk serving this instruction
livediff intents                                 # instructions → hunks, including the empty ones
livediff record --intent "caret should be an x" --hunks src/components/CommentThread.tsx:200-220 \
  --rejected "putting it in Composer — unmounts on submit"
```

**Beats:** "session provenance" is being discussed as a thing to attach to a PR as a blob. Binding it per-hunk and making it queryable in both directions is a different and much more useful object.

---

#### 5. Assumptions & Omissions Ledger

**Pitch:** What the agent didn't do, as a first-class review object.

Shortcuts, assumptions, deferred work, and known-incomplete edges get filed as structured entries, not buried in a chat message you've already scrolled past. The browser shows a standing count — "4 assumptions · 2 shortcuts · 1 deferred" — that you can't miss and that must be dispositioned before the review is done.

Each entry is acknowledgeable, challengeable, or convertible into work. An unacknowledged assumption keeps the review open.

This addresses the "descriptions that do not match the code" burnout complaint directly. The gap between what an agent says it did and what it did is where trust dies. Making omissions structured and countable closes it.

```bash
livediff assume "the hub is always loopback-only" --confidence high
livediff shortcut src/file-tree.ts:60 "no cycle detection — inputs come from git, always a tree"
livediff defer "collapse state should persist per worktree" --why "not in scope"
livediff ledger                    # everything undispositioned
livediff ack <id> | livediff challenge <id> "what if a symlink loops?"
```

**Beats:** every tool summarizes what changed. None of them structure what _didn't_.

---

### Group C — The review has a shape

#### 6. Guided Walkthrough (Tour)

**Pitch:** The agent authors an ordered tour with narration. You press `n`.

Rather than a file tree in alphabetical order, the agent composes a reading order with a stop at each meaningful point: "start here, this is the new data structure — now here, this is who calls it — now the part I'd argue about." Stops carry narration, can span multiple files, and can point at code _outside_ the diff for context.

Two things make ours different from CodeRabbit's Change Stack. First, theirs is inferred from the finished diff; ours is authored by the thing that wrote the code, so the order reflects actual construction rather than reverse-engineered dependency. Second — and this is the real one — **ours is live.** When you comment at stop 4 and the agent fixes it, the tour updates. A static walkthrough is stale the moment review begins; that's the whole reason review UIs don't have them.

You can comment on a _stop_, not just a line — which is where architectural feedback naturally lands and where line-anchored comments have always been awkward.

```bash
livediff tour create --title "New comment threading"
livediff tour stop add --files src/file-tree.ts --note "the data structure everything else assumes"
livediff tour stop add --files src/components/FileTree.tsx:40-80 --note "recursion + collapse state"
livediff tour stop add --context server/comments.ts:200 --note "not in the diff, but this is why"
livediff tour reorder 3 1
livediff tour show | livediff tour next | livediff tour goto 4
```

**Beats:** CodeRabbit ships the closest thing. We win on authored-not-inferred, live-not-static, and commentable stops.

---

#### 7. Progressive Passes

**Pitch:** A 3,000-line diff served in escalating layers instead of all at once.

Pass 1 is architecture: ten lines of prose, the four files that actually matter, and nothing else on screen. Pass 2 is logic: the decisions inside those files. Pass 3 is detail: everything remaining, including the mechanical churn. You descend only where you have concerns, and you can approve a pass to lock it — later edits that touch approved regions re-open them and say so.

This is the most direct possible attack on the >400-line finding. The problem isn't that big diffs contain too much; it's that the interface presents 3,000 lines of uniform importance and human attention degrades after the first screen. Give it a hierarchy and the same content becomes reviewable.

Sequencing also fixes the pickup-latency problem. "Review this 3,000-line PR" is a task you postpone for two days. "Spend four minutes on pass 1" is one you do now.

```bash
livediff pass define --layers architecture,logic,detail
livediff pass show architecture
livediff pass approve architecture --note "structure is right, go on"
livediff pass reopen                     # edits landed in an approved layer
livediff pass status
```

**Beats:** Graphite solves this by making authors split PRs — real work, and it doesn't help once the diff exists. This gets the benefit without restructuring the change.

---

#### 8. Acceptance Map

**Pitch:** Your original request as checkboxes, each mapped to the code that satisfies it.

You asked for three things. The map shows where each landed, which is fully done, which is partial, and which quietly didn't happen. Coverage runs both directions: requirements with no code, and code with no requirement — the second being where scope creep lives, and where an agent's unrequested "improvements" hide.

Reviewing against intent rather than against the diff is a different and much better activity. It's also the natural place for "you asked for X, I also had to change Y to make it work" to be stated rather than discovered.

```bash
livediff accept add "file tree in the sidebar"
livediff accept add "pinned file header"
livediff accept map "pinned file header" --hunks src/components/FastDiff.tsx:480-520 --status done
livediff accept map "file tree in the sidebar" --status partial --why "no per-worktree collapse memory"
livediff accept status              # done / partial / missing
livediff accept unmapped            # code serving no stated requirement
```

**Beats:** PR descriptions claim completeness in prose nobody verifies. This makes the claim checkable and the gaps loud.

---

### Group D — The review is a conversation

#### 9. Questions First

**Pitch:** Before you read anything, the agent asks the three things only you can answer.

Not "review my code" — "I need three decisions: should this retry or fail fast? Is silently dropping a malformed comment acceptable? I assumed loopback-only, correct?" Answers are captured as durable decisions that feed back into the code and into the Review Contract.

This flips the reviewer's job from _auditor_ to _authority_, which is both faster and a better use of a human. Finding bugs is what the machines are now good at; supplying intent and judgment is not. Three questions answered in ninety seconds can prevent an entire class of wrong-direction work that would otherwise be caught late or never.

It's also the correct response to the volume problem. When reviewers have ~6.4 hours a week and volume has doubled, the leverage isn't reading faster — it's being asked better questions.

```bash
livediff ask "retry or fail fast on a corrupt registry?" --options retry,fail-fast \
  --default fail-fast --blocks server/registry.ts:88
livediff ask "is dropping a malformed comment acceptable?" --context server/comments.ts:140
livediff questions                  # unanswered, blocking first
livediff answer <id> retry --why "the hub is long-lived; a transient FS error shouldn't kill it"
livediff decisions                  # answers as durable record, promotable to the contract
```

**Beats:** every tool is built to _give_ the reviewer information. None are built to _get_ information from them, despite that being the scarce resource.

---

#### 10. Blast Radius

**Pitch:** What this change touches that isn't in the diff.

For each changed symbol: who calls it, which callers are in the diff, and — the important part — which are **not**. "`parsePatch` changed signature. 14 callers. 2 are in this diff. 12 are not. Here they are."

This is the specific failure mode of AI-written code. An agent works within its context window, changes a shared thing correctly for the case it's looking at, and doesn't check the eleven other callers because they were never in view. The diff looks complete and self-consistent. The bug is entirely in what's absent — and a diff, by construction, cannot show you what isn't in it.

The hard part is that there is nothing mechanical to lean on. livediff runs against arbitrary repos and can assume nothing but git — no `tsc`, no `oxlint`, no AST, and not necessarily JS/TS at all. So the callers have to come from the agent, which makes this idea _more_ agent-dependent than it looks, not less.

```bash
livediff radius                          # every changed symbol, callers in/out of the diff
livediff radius --symbol parsePatch
livediff radius --uncovered              # dependents outside the diff with no test touching them
livediff radius --explain src/diff-model.ts:455
```

**Beats:** Greptile's whole-codebase context is the nearest thing, and it's used to find bugs _in_ the diff. Using it to render the negative space around the diff is a different feature.

---

## Runners-up

Cut for now, worth arguing about:

- **Diff Replay** — scrub the agent's edit sequence rather than the final state. Seeing it write something wrong twice then fix it tells you where it struggled. Great demo; unclear whether anyone would use it twice.
- **Challenge Mode** — the agent argues against its own change and you adjudicate. Fun, possibly theatre.
- **Attention Learning** — infer emphasis from where you actually dwell and comment, rather than asking. Powerful, slightly creepy, and needs data you don't have yet.
- **Risk-Ranked Tree** — order files by probability of being wrong rather than alphabetically. Probably a _property_ of #3 rather than its own feature.

---

## How these fit together

They're not ten independent features. There's a spine:

**#4 (Why-Trail) and #3 (Confidence) are the substrate** — per-hunk metadata the agent emits while working. Almost everything else is a view over them. #6 (Tour), #7 (Passes), and #12-ish risk ordering are all _orderings_; #1 (Contract) and #2 (Lenses) are _filters_; #8 (Acceptance) and #5 (Ledger) are _completeness checks_; #9 (Questions) and #10 (Radius) are the two that stand alone.

If only one thing gets built, **#3 Confidence Map** is my pick — smallest surface, most differentiated, and it makes the others better. If two, add **#9 Questions First**, because it's the cheapest and it changes what the human is _for_.

The thing to be careful about: every concept here asks the agent to emit more structure while it works. That's a token and discipline cost paid on every task, and if the agent is sloppy about it the metadata is worse than nothing — a confidence map you can't trust is actively harmful. Whatever ships first should be the one where the agent's incentive to be honest is strongest and the failure mode is quietest.

---

## Questions for you

Answer inline in livediff and I'll pick these up:

1. **Which three or four are worth going deeper on?** I'd rather spec two properly than sketch ten.
2. **Who leaves the emphasis — you, or the agent?** #1 and #2 assume you declare priorities up front. That's a real cost on every repo. Is that a thing you'd actually do, or should the agent propose a contract and you edit it?
3. **Is the tour authored per-diff or per-task?** A live diff spans many tasks. A tour that survives across them is more useful and much harder.
4. **How much do you trust agent self-reporting?** #3 and #5 live or die on this. If an agent under-reports uncertainty to look competent, the feature is worse than absent. Do we need a verification story, or is this fine because the agent has no ego?
5. **Should any of this survive the worktree?** Confidence, decisions, and contracts are arguably durable repo knowledge, not per-diff state. That's a much bigger storage question and it changes the design.
6. **Where's the line with the existing comment system?** Several of these create new comment-adjacent objects (stops, questions, ledger entries). Are those all comments with a type field, or genuinely separate things?

---

_Sources: [Codacy — AI Is Breaking Code Review](https://blog.codacy.com/ai-breaking-code-review-how-engineering-teams-survive-pr-bottleneck) · [CodeRabbit — AI vs Human Code Generation Report](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report) · [CodeRabbit — AI is burning out the people who keep open source alive](https://www.coderabbit.ai/blog/ai-is-burning-out-the-people-who-keep-open-source-alive) · [CodeRabbit — Change Stack](https://www.coderabbit.ai/blog/introducing-atlas-the-first-ai-native-code-review-interface) · [CodeRabbit — Semantic Diff](https://www.coderabbit.ai/blog/introducing-semantic-diff) · [Greptile — Best AI Code Review Tools 2026](https://www.greptile.com/content-library/best-ai-code-review-tools) · [Propel — AI Code Review Needs Session Provenance](https://www.propelcode.ai/blog/ai-code-review-agent-session-provenance) · [Addy Osmani — Agentic Code Review](https://addyosmani.com/blog/agentic-code-review/) · [arXiv — Rethinking Code Review in the Age of AI](https://arxiv.org/pdf/2605.17548) · [Signadot — AI Coding Agents and the Code Validation Bottleneck](https://www.signadot.com/blog/ai-generated-code-crisis/)_
