# The core loop

The hypothesis-test cycle of the first-principles investigation, and the rules
for fanning out to subagents.

## The phases

Work these phases in order, but loop back freely - new evidence reshapes earlier
phases. Keep a running audit trail (a scratch list of every step, input, and
result); memory lies, and the trail exposes patterns you can't see in the moment.

**0 - Frame the observation precisely.** Write down exactly what happened,
verbatim: the real error text, the actual behavior vs. the expected behavior, the
exact conditions. Strip your interpretation out of this step - just the raw
facts. A fuzzy problem statement ("it's slow sometimes") produces a fuzzy
investigation; sharpen it until it's specific and checkable.

**1 - Build the ASSUME / KNOW ledger.** This is the heart of the method. Make two
columns and sort every belief about the system into them:

- **KNOW** - you observed it firsthand this session (you ran it and saw the
  output; you read the line of source; the log shows it).
- **ASSUME** - everything else: the docs say so, someone reported it, it
  "usually" works that way, it's the obvious reading, the user stated it as
  fact.

Bugs hide in the ASSUME column, in items everyone has been silently treating
as KNOW. Your job is to promote the load-bearing assumptions to KNOW with a
cheap check - or delete them. **Never act on an item in the ASSUME column.**

The ledger is a thinking discipline, not a mandatory artifact. On a big or
murky investigation, keep it as a literal two-column list. On a small,
self-contained one, you can carry it in your head and let it surface in the
report as the "Observed" (your KNOWs) and "Still assumed" (your surviving
ASSUMEs) sections. What's non-negotiable is the _sorting_, not the table.

**2 - Check the plug, then reproduce.** Before anything clever, verify the boring
prerequisites: right branch/build/version, actually running, actually connected,
config pointing where you think. Then make it fail _on demand_ - a reliable,
minimal reproduction is the axiom the rest of the investigation stands on. If you
can't reproduce it, you can't confidently confirm any fix. Shrink the repro to the
smallest case that still triggers it; each thing you remove that _doesn't_ stop
the failure is a variable eliminated.

**3 - Read the actual source or spec for the path involved.** Trace, in the real
code, how the observed failure could be produced. This is where analogy-based
guesses go to die: the code often does something other than what you (or the
docs) remember.

**4 - Enumerate hypotheses broadly - breadth before depth.** Resist locking onto
the first idea. Sweep the space of possible causes across categories so you don't
fixate: **Code, Config, Data, Dependencies, Environment, Deploy/Infra,
Human/Process.** Hold **at least two** live hypotheses; a single-hypothesis
investigation is just confirmation bias with extra steps. (See `references/method.md`
for the full "cause categories" checklist.)

**5 - Test the cheapest discriminating experiment first.** For each hypothesis,
name its falsifier (stance #3 in SKILL.md), then rank by _likelihood ×
cost-to-check_ and run the observation that would best split the surviving hypotheses apart.
**Change one thing at a time** - simultaneous changes destroy your ability to
attribute the result. Record input and outcome in the audit trail; move items
between ledger columns as evidence lands. Sanity-check each surviving hypothesis
against hard constraints (a Fermi check: _if this were the cause, we'd expect ~N
occurrences / this latency / this many rows - do we actually see that?_). A
hypothesis that violates a physical or logical bound is dead on arrival.

**6 - Converge, distinguishing correlation from causation.** Iterate phase 5
until **exactly one** hypothesis survives _and it predicts new observations you
then confirm_ - not merely fits the ones you started with. Co-occurrence (a deploy
and an error spike at the same time) is evidence, not proof; confirm causation by
toggling the suspected cause and watching the effect follow.

**7 - Trace to the true root, then prove the fix.** Follow the causal chain
backward - _defect → infection → propagation → failure_ - past the first bad value
to the origin that actually started it. Apply the fix, then prove it: cycle the
system between broken and fixed to show the failure appears and disappears
_because of_ your change.

**8 - Self-audit before you conclude.** Run the anti-pattern checklist (the
self-audit in SKILL.md, in full in `references/anti-patterns.md`). The most
common way a careful investigation still goes wrong is stopping one level too shallow because the story already feels good.

## When to fan out to subagents (adaptive swarm)

Subagents are optional. If you can dispatch subagents, run independent
hypotheses in parallel as described here; otherwise test them one after another
yourself, with the same discipline.

Default to a **single, serial investigation** - one disciplined chain keeps all
the evidence in one working memory, and most bugs are a single trail. Fan out only
when the shape of the problem genuinely rewards it:

**Fan out when** you have **two or more _independent_ hypotheses**, each needing
non-trivial digging (reading a different subsystem, running a different repro),
with no shared serializer between them. Then spawn one investigator per
hypothesis - they explore in parallel and hand back _evidence_, and you converge.

**Stay serial when** the leads are sequential (each step's result decides the
next), when they share state, or when the whole thing is one linear trail - a swarm
there just fragments context and is slower.

**How to run the swarm:** give each subagent **exactly one hypothesis and its
falsifier**, and require it to return _observations, not a verdict you must
trust_. Use the bundled prompt at **`references/hypothesis-tester.md`** (a
read-only subagent for source and log tracing, one that can run commands when
it must reproduce something). Then **you re-judge the returned evidence
yourself** - a subagent that "confirms" its own hypothesis is exactly the confirmation-bias trap
the method exists to defeat. For a high-stakes root cause, spawn an _adversarial_
subagent whose only job is to **refute** the leading cause; accept the cause only
if it survives.
