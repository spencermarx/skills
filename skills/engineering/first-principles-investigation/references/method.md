# The Method - canonical grounding

The loop in `references/the-loop.md` is a synthesis. This file is the depth behind it: the two
authoritative systematizations of debugging-as-science, and the toolbox of
techniques each phase draws on. Read the section you need; you rarely need all of
it at once.

## Contents

- [Why first principles, precisely](#why-first-principles-precisely)
- [Zeller: scientific debugging + TRAFFIC](#zeller-scientific-debugging--traffic)
- [Agans: the 9 indispensable rules](#agans-the-9-indispensable-rules)
- [The technique toolbox](#the-technique-toolbox)
  - [The ASSUME / KNOW ledger](#the-assume--know-ledger)
  - [Evidence vs. inference](#evidence-vs-inference)
  - [Falsifiability and the cheapest discriminating observation](#falsifiability-and-the-cheapest-discriminating-observation)
  - [Cause-category checklist (Fishbone for software)](#cause-category-checklist-fishbone-for-software)
  - [Fermi / constraint checks](#fermi--constraint-checks)
  - [Correlation vs. causation](#correlation-vs-causation)
  - [Socratic questioning](#socratic-questioning)
  - [The 5 Whys - and why it fails alone](#the-5-whys---and-why-it-fails-alone)

---

## Why first principles, precisely

First-principles reasoning is two operations, done in order:

1. **Decompose** the problem to the foundational truths that cannot themselves be
   deduced from anything more basic - separating _what is verifiably true here_
   from _what we inherited or assumed_.
2. **Reconstruct** upward from only the verified truths, which lets you reach a
   conclusion that breaks from precedent when the precedent doesn't actually hold.

The contrast is with **reasoning by analogy** - "do X because it worked before /
elsewhere." Analogy is borrowed knowledge; it operates _inside_ an inherited
frame and fails silently when the frame doesn't fit the case in front of you.
First principles is derived knowledge; it rebuilds the frame and surfaces exactly
where the borrowed assumption breaks. Analogy is the right default for routine
problems (it's cheap and usually adequate) - reach for first principles precisely
when the routine answer is wrong, expensive to get wrong, or unknown.

The lineage, if you want to cite it: Aristotle's _archē_ (a first principle is the
terminating node of a "why" chain - you know something only when you've grasped
its primary causes); Descartes' method of doubt (systematically doubt everything
doubtable until only bedrock remains, then rebuild on it); Feynman (break a thing
to its basic parts, explain it plainly, and _watch for where the explanation
breaks_ - the break is where your "understanding" was actually assumption).

---

## Zeller: scientific debugging + TRAFFIC

From Andreas Zeller, _Why Programs Fail: A Guide to Systematic Debugging_ - the
authoritative treatment of debugging as the scientific method.

### The causal chain

Zeller's key model. A failure is the _end_ of a chain, not its start:

> **defect → infection → propagation → failure**

- **defect** - the actual flaw in the code (the thing to fix).
- **infection** - an incorrect program state the defect produces.
- **propagation** - that bad state spreading to further states.
- **failure** - the externally visible wrong behavior you first noticed.

The whole discipline of "don't stop at the first plausible cause" is this model:
the first wrong value you find is almost always an _infection_ midway down the
chain. Trace backward from it to the **defect** at the origin. Fixing an infection
masks the symptom while leaving the defect live.

### The scientific-debugging loop

1. **Observe** a failure.
2. **Hypothesize** a cause consistent with _all_ the observations.
3. **Predict** something the hypothesis implies but you haven't yet checked.
4. **Experiment** / observe to test the prediction.
5. **Refine or reject**, and repeat 3–4 until the hypothesis can no longer be
   refined - it fully explains the failure _and_ correctly predicts new
   observations.

The stopping condition matters: you're done not when a hypothesis _fits_ the
evidence you have, but when it _predicts_ evidence you didn't have and that
evidence checks out. Fitting is cheap; predicting is proof.

### TRAFFIC - the workflow that wraps the loop

- **T**rack the problem (record it; a reproducible report).
- **R**eproduce the failure reliably.
- **A**utomate and simplify the reproduction to a minimal test case.
- **F**ind possible infection origins (follow dependencies backward from the
  failure).
- **F**ocus on the most likely origins.
- **I**solate the infection chain - scientific loop to pin where the state first
  goes wrong.
- **C**orrect the defect _and verify_ the correction removes the failure.

---

## Agans: the 9 indispensable rules

From David J. Agans, _Debugging: The 9 Indispensable Rules for Finding Even the
Most Elusive Software and Hardware Problems._ These are first-principles reasoning
as field practice - each maps onto a phase of the loop.

1. **Understand the system.** Read the manual, the spec, and the _actual source_.
   "The function you assume you understand is the one that bites you."
2. **Make it fail.** Reproduce reliably and on demand; find the exact conditions.
   _Stimulate the failure, don't simulate it_ - reproduce the real thing, not an
   approximation of it. You cannot confirm a fix for a bug you can't trigger.
3. **Quit thinking and look.** Get data _before_ theorizing. "It is a capital
   mistake to theorize before one has data." Instrument and observe the actual
   mechanism; use a guess only to decide _where to look_, never as a substitute
   for looking. This is the anti-speculation rule.
4. **Divide and conquer.** Binary-search the problem space - split into
   working/broken halves and narrow. Find _where_ before _why_.
5. **Change one thing at a time.** Isolate variables; multiple simultaneous
   changes destroy attribution. Revert anything that didn't help.
6. **Keep an audit trail.** Record every step, input, and result - memory lies,
   and the log reveals patterns invisible in real time. (For an agent: this is
   your running scratch list.)
7. **Check the plug.** Verify the obvious prerequisites first - is it even
   running, connected, the right version, the right build, the right branch?
8. **Get a fresh view.** Seek an outside perspective; explain it aloud
   (rubber-ducking). Report _symptoms, not your pet theory_, so you don't bias the
   helper. (For an agent: this is a clean-context subagent - see the swarm
   section of `references/the-loop.md`.)
9. **If you didn't fix it, it ain't fixed.** Verify empirically - cycle the system
   between broken and fixed to _prove_ your change is what fixed it. An apparent
   fix you can't toggle on and off is unproven.

---

## The technique toolbox

### The ASSUME / KNOW ledger

The single highest-leverage habit. Maintain two explicit columns:

- **KNOW** = directly observed this session (ran it and saw X; read the line that
  says Y; log shows Z).
- **ASSUME** = inherited, plausible, or reported-but-unverified (the doc says…,
  someone said…, it "usually"…, the obvious reading is…, the user stated…).

Every item in ASSUME is a candidate to **promote to KNOW via a cheap check, or
delete.** The bug is very often an item everyone treated as KNOW that was actually
ASSUME. Concretely: when you catch yourself about to act, ask "which column is the
belief I'm acting on in?" If ASSUME, verify it first. The check is usually far
cheaper than the wasted work of acting on a false assumption.

### Evidence vs. inference

Tag every statement in your notes as one or the other:

- **Observation (evidence)** - a raw fact from a tool, log, or repro. "The query
  returned 0 rows." "The 401 has header `WWW-Authenticate: Bearer error=…`."
- **Inference** - a conclusion drawn _from_ observations. "The token is expired."
  "The RLS policy is filtering it out."

Inferences are hypotheses wearing a fact's clothing. Keeping the label visible
stops a chain of plausible inferences from silently becoming "what we know."

### Falsifiability and the cheapest discriminating observation

A hypothesis you can't imagine disproving explains nothing - every outcome seems
to confirm it. So for each hypothesis, write its **falsifier**: the specific
observation that would force you to abandon it.

Then choose your next experiment by _information_, not convenience. Rank the live
hypotheses and pick the observation that best **splits** them - the one whose
result rules out the most hypotheses per unit of effort (_likelihood ×
cost-to-check_). One well-chosen discriminating test beats ten confirmatory ones.
(This is the debugging-mind-set framing: enumerate falsifiable hypotheses, rank by
likelihood and cost, make the cheapest discriminating observation first.)

### Cause-category checklist (Fishbone for software)

Breadth before depth. Before drilling, sweep candidate causes across categories so
you don't fixate on the first idea (the classic Ishikawa move, adapted for
software):

- **Code** - logic error, off-by-one, wrong branch, race, unhandled case.
- **Config** - wrong value, missing var, precedence, stale/overridden setting.
- **Data** - unexpected shape, null, encoding, volume, a poison record.
- **Dependencies** - version skew, breaking change, transitive pull, lockfile.
- **Environment** - OS/runtime differences, timezone, locale, resource limits, filesystem.
- **Deploy / Infra** - wrong build shipped, cache, DNS, networking, migration
  ordering, environment drift (staging ≠ prod ≠ local).
- **Human / Process** - wrong branch, uncommitted change, a manual step skipped,
  a stale local stack.

You don't investigate all seven - you _glance_ across all seven to make sure your
two-or-three live hypotheses aren't all clustered in one category out of habit.

### Fermi / constraint checks

Before investing in a hypothesis, sanity-check its _magnitude_ against a hard
bound. "If the cause were an N+1 query, we'd expect ~1 query per row → thousands
of queries → seconds of latency. We see 40ms. Dead." A hypothesis that implies a
count, latency, size, or rate that contradicts a physical or logical constraint is
eliminated for free, without any deeper digging. Always close with: _does this
magnitude even make sense?_

### Correlation vs. causation

Two things happening together (a deploy and an error spike; a flag flip and a
latency change) is **evidence**, not proof. The confirmation is _intervention_:
toggle the suspected cause and check the effect follows - appears when you turn it
on, disappears when you turn it off. If you can't intervene, look for a natural
experiment (an instance where the cause was present without the effect, or vice
versa) that would break the causal claim.

### Socratic questioning

The disciplined "why" loop, useful when you're challenging your own reasoning
rather than the system:

1. **Clarify** - what exactly am I claiming, and where did this idea come from?
2. **Challenge assumptions** - what am I taking for granted? What if the opposite
   were true?
3. **Seek evidence** - what actually supports this? Is the source firsthand?
4. **Alternative views** - what would someone who disagrees say?
5. **Consequences** - if this is true, what else must follow? Does it?
6. **Question the question** - was I even asking the right thing?

### The 5 Whys - and why it fails alone

Asking "why" repeatedly to drill from symptom toward root is genuinely useful, but
the naive form has well-documented failure modes an investigator must guard
against:

- **Single-cause / linearity trap.** It assumes one straight-line cause. Real
  failures are usually _several contributing factors combining._ Let the "why"
  **branch**, not just descend.
- **Confirmation bias.** You steer the questions toward the cause you already
  suspect. Demand evidence at each step, and actively seek a disconfirming
  observation.
- **No stopping signal.** Nothing tells you when you've hit an _actionable_ root
  vs. a mere contributing factor. Stop when you reach something you can fix that,
  fixed, would prevent the failure - and verify that claim.
- **Authority skew.** The chain bends toward the senior/loudest hunch. Evidence
  outranks authority.

The corrective: brainstorm causes broadly _first_ (the cause-category checklist
above), _then_ use "why" to drill the most likely - not "why" alone from the
symptom.

---

## Sources

- Andreas Zeller, _Why Programs Fail: A Guide to Systematic Debugging_ - scientific
  debugging, TRAFFIC, the defect→infection→propagation→failure model.
- David J. Agans, _Debugging: The 9 Indispensable Rules_ - the field-practice rules.
- Devon H. O'Dell, "The Debugging Mind-Set," _Communications of the ACM_ -
  hypotheses ranked by likelihood × cost-to-check; cheapest discriminating
  observation first.
- Farnam Street, "First Principles: The Building Blocks of True Knowledge"
  (fs.blog) - the Socratic six-step, the analogy contrast.
- Aristotle, _Physics_ / _Metaphysics_ (archē); Descartes, _Meditations_ (method of
  doubt); Feynman, "Cargo Cult Science" ("you must not fool yourself").
- Ishikawa (fishbone) and root-cause-analysis literature - breadth-before-depth,
  the documented 5-Whys pitfalls.
- Fermi problems - order-of-magnitude / constraint sanity-checking.
- The framing borrows from the open-source "First Principles Thinking" skill
  (github.com/awesome-skills/first-principles-skill), re-scoped from design
  evaluation to empirical investigation. Not vendored verbatim.
