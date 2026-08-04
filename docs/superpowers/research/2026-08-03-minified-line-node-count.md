# One minified line defeats virtualization

**Found:** 2026-08-03, by the first e2e run against the `minified-single-line` fixture.
**Status:** open. Pinned by a `test.fail()` in `e2e/navigation.spec.ts`.

## What happens

A repo whose diff is a single 20,000-character line renders **40,058 DOM nodes** and takes ~11s to
become interactive. The whole 20,000-*line* fixture renders 1,203 nodes in ~0.4s.

| Fixture | Lines | DOM nodes | Load |
| --- | --- | --- | --- |
| `tracked20k` | 20,000 | 1,203 | 0.4s |
| `lockfile` | 20,000 | 1,203 | 0.3s |
| `minified-single-line` | 1 | **40,058** | **11.3s** |

## Why

Virtualization bounds the number of **rows** in the DOM. Nothing bounds the number of **tokens
inside a row**. `src/syntax.js` tokenizes each visible line and `LineText` renders one `<span>` per
token, so a line with ~20,000 tokens produces ~20,000 spans — twice over in split mode, since the
same line appears on both sides.

The row model is not at fault, and this is worth stating clearly because it was the thing under
suspicion: the analytic height math handles the shape correctly. `scrollHeight` exceeds
`clientHeight`, meaning the 20,000-character line is correctly wrapped to many lines' worth of
height rather than measured as one. That half is covered by a passing test.

## Why it was never caught

The fixture existed — `bench/gen.mjs minified-single-line` has been there since the performance
research — but every measurement was taken against `tracked20k`. It was logged as a known gap at the
end of the renderer work and never closed, because closing it by hand meant another manual
Playwright session.

## The fix, when someone takes it

A per-line length cutoff on highlighting: above some threshold, render the line as one plain text
node instead of tokenizing. Nobody reads syntax colour on a minified bundle, and the same cutoff
would also cheapen lockfiles. The threshold belongs in `server/constants.js` next to the other
render budgets.

Worth checking at the same time whether search over such a line is also pathological — `matchRange`
and `splitAtMatch` run per token.

## Resolved (2026-08-03)

`MAX_HIGHLIGHT_LINE_CHARS = 2000` in `shared/constants.ts`; `tokenize` in `src/syntax.js` returns
null above it, which is the existing "grammar not ready" path, so the caller already renders one
plain text node.

| | before | after |
| --- | --- | --- |
| DOM nodes | 40,058 | under budget |
| Load | 11.3 s | **0.28 s** |

A 40× improvement on load, from a three-line change. The `test.fail()` guards in
`e2e/navigation.spec.ts` are now ordinary passing tests.

Not done: search over such a line still runs `matchRange` per token. It is no longer pathological
because there is only one token, but that is a consequence rather than a decision.
