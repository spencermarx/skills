---
name: first-principles-investigation
description: >-
  Evidence-first root-cause investigation: competing hypotheses, each tested against the
  actual system, until exactly one survives and the fix is proven. Use whenever something
  behaves in a way nobody can explain, a fix did not hold, the obvious cause is already
  ruled out, or the question is how a system really works: "why is CI flaky", "get to the
  bottom of this 500", "why does the deploy drift from main", "root-cause this failure",
  "debug this properly", "this makes no sense, figure out what's going on", "trace where
  this value comes from", even when the user only describes a confusing behavior. Prefer
  it over a domain skill while the cause is still unknown. Do NOT use when the cause is
  known and only the fix is in question, to stress-test a plan (use `grill-me`), to review
  a diff, or for a one-line lookup you can answer directly.
license: MIT
argument-hint: '[optional: the symptom, failing target, error text, or question to investigate]'
metadata:
  ideas: "The open-source First Principles Thinking skill (https://github.com/awesome-skills/first-principles-skill), its framing re-scoped from design evaluation to empirical investigation and not vendored. Method grounded in Andreas Zeller's Why Programs Fail (scientific debugging, TRAFFIC) and David J. Agans' Debugging: The 9 Indispensable Rules; full sourcing in references/method.md."
---

# First-Principles Investigation

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

Most "debugging" is reasoning by analogy: _this looks like that bug last week, so
it's probably the same cause._ That's fast and often right - until it's wrong,
and then it sends you fixing a symptom while the real defect sits untouched. This
skill is the discipline for the times that matters: you trust **only what you
have observed in _this_ system**, you rebuild your understanding from the ground
up, and you refuse to act on a cause until the evidence forces it.

The whole method rests on one idea from Feynman: _the first principle is that you
must not fool yourself - and you are the easiest person to fool._ Everything below
is machinery for not fooling yourself.

## The stance

These four commitments are what separate a real investigation from "debug
carefully." Hold them the whole way through.

1. **Ground truth is the running system and its source - not docs, not memory,
   not analogy, not what anyone asserted (including the user).** Docs drift; the
   code and the logs don't. The function you're _sure_ you understand is the one
   that bites you. When a claim matters, go read the actual source or reproduce
   the behavior yourself.
2. **Separate evidence from inference, always.** "The request returned 401" is
   evidence. "Auth is broken" is an inference drawn from it. Confusing the two is
   how a plausible story hardens into false certainty. Label them differently in
   your own notes and in your report.
3. **Every hypothesis carries the observation that would kill it.** A cause you
   can't imagine disproving is worthless - every test will seem to "confirm" it
   and you'll learn nothing. Before you go looking, state: _what would I have to
   see for this to be false?_ Then go try to see that.
4. **Don't stop at the first plausible cause. Trace to the true root, and prove
   the fix.** The first wrong value you find is usually an _infection_ partway
   down the chain, not the _defect_ that started it. And a fix you can't toggle
   on and off to make the failure appear and disappear is not a proven fix - it's
   a hope. If you didn't verify it, it isn't fixed.

## Two modes, one method

The same discipline serves two kinds of investigation, and the vocabulary below
leans toward the first - but they're the same method:

- **Diagnose a failure** - "why is this 500ing", "why did the deploy desync". The
  goal is a _defect_, proven by making the failure appear and disappear.
- **Understand a mechanism** - "how does `dotenv` actually pick a value",
  "how does the auth hook resolve claims". There's no bug; the goal is the _true
  model_ of how something works, proven by tracing the real code and confirming
  each claim.

When you're in mechanism mode, read the failure-oriented words as their
mechanism-mode twins: _reproduce_ → **trace and confirm the behavior**, _root
cause_ → **the mechanism / model**, _fix & proof_ → **how each claim in the model
is proven**. Everything else - the ledger, hypotheses-with-falsifiers, evidence vs.
inference, breadth-before-depth, reading the source over the docs - applies
unchanged, and matters just as much: a "how does it work" answer paraphrased from
the docs is exactly the failure this method exists to prevent.

## The core loop

Read `references/the-loop.md` before the first hypothesis, not after. It holds
the nine phases (frame, ledger, reproduce, read the source, enumerate, test,
converge, trace to root, self-audit) and the rules for when to fan out to
subagents.

## Output format

Read `references/output-format.md` before writing the conclusion, not before
starting the investigation.

## Before you conclude - self-audit

Fast pass against the ways a first-principles investigation still fails. Any "yes"
sends you back into the loop. Full catalog with guards in
`references/anti-patterns.md`.

- **Analogy** - am I acting on "it's like that other bug" rather than evidence
  from _this_ system?
- **Confirmation bias** - did I only run tests that would confirm my favored
  cause, and skip the one that could falsify it?
- **Anchoring** - am I under-weighting evidence that contradicts my first guess?
- **Symptom, not root** - is my "cause" actually an infected value partway down
  the chain, with an earlier defect still upstream?
- **ASSUME as fact** - is any step resting on an unverified item I never promoted
  to KNOW?
- **Authority over evidence** - am I trusting an assertion (the user's, a
  senior's, the docs') that I could have checked but didn't?
- **Unproven fix** - can I actually toggle the failure on and off with my change,
  or am I hoping?

## Going deeper

- **`references/method.md`** - the canonical grounding: Zeller's scientific-
  debugging loop and TRAFFIC workflow, Agans' 9 indispensable debugging rules, and
  the full technique toolbox (the cause-category checklist, falsifiability and
  cheapest-discriminating-observation, Fermi/constraint checks, correlation vs.
  causation, Socratic questioning). Read when you want the depth behind a phase.
- **`references/anti-patterns.md`** - the failure-mode catalog with concrete
  guards. Read at phase 8, or any time the investigation feels stuck or too easy.
- **`references/hypothesis-tester.md`** - the subagent prompt for swarm mode.
