# Subagent prompt: hypothesis-tester

Use this when the investigation warrants a swarm (`references/the-loop.md`,
"When to fan out"): you have two or more _independent_ hypotheses, each needing non-trivial digging in
a separate part of the system. Spawn **one subagent per hypothesis** so they run
in parallel, then converge their evidence yourself.

## How to dispatch

If you can dispatch subagents, give each one a capability that fits what its
hypothesis needs:

- **Read-only** - tracing: reading source, following a value's origin, scanning
  logs and config. Fastest and safest; it returns findings, not edits.
- **Able to run commands** - when the subagent must _run_ something (execute a
  repro, run a query, invoke a target) to get the evidence.

Fill the template below into each subagent's instructions, one hypothesis per
subagent, and start them together so they run concurrently. If you cannot
dispatch subagents, work through the template yourself for each hypothesis in
turn, keeping each one's evidence separate until you converge.

## The prompt template

```
You are testing ONE hypothesis in a larger first-principles investigation. Your
job is to gather EVIDENCE, not to reach a verdict I have to trust - I will judge
the evidence myself. Do not try to make your hypothesis true; the most useful
thing you can return is the observation that KILLS it.

## The overall symptom
<the observed failure, verbatim - error text, actual vs. expected, conditions>

## Your hypothesis (test only this one)
<the single hypothesis this agent owns>

## The falsifier
This hypothesis is FALSE if you observe: <the specific observation that would
disprove it>. Actively try to observe that. If you can't, that's meaningful too.

## Ground rules
- Trust only what you observe firsthand in THIS system - the actual source, the
  real logs, a real reproduction. Not docs, not memory, not analogy.
- Separate evidence (raw observation) from inference (your conclusion) in what you
  report. Label them.
- Change one thing at a time; note every input and result.
- Do not fix anything. Do not touch code paths outside what this hypothesis needs.
- If you find strong evidence for a DIFFERENT cause while looking, report it as a
  side finding - don't chase it.

## Return exactly this
1. **Verdict:** ruled out | supported | inconclusive - and the single observation
   that drove it.
2. **Evidence:** the raw observations (commands run, outputs, source lines with
   file:line, log excerpts). Enough that I can retrace it.
3. **Inferences:** what you concluded from the evidence, kept separate from it.
4. **Confidence & gaps:** what would make you more sure; what you couldn't check.
5. **Side findings:** anything else notable (a different candidate cause, a broken
   assumption), clearly marked as not-your-hypothesis.
```

## Converging the results

When the subagents return:

- **Re-judge every verdict against its evidence yourself.** A subagent reporting
  "supported" is a lead, not a conclusion - the whole point of the method is that
  self-confirmation is the failure mode. Weigh the raw observations, not the
  label.
- **Look for a hypothesis that uniquely survives** - one supported _and_ whose
  competitors were genuinely ruled out (not merely "inconclusive"). If two survive,
  you haven't converged; design the discriminating observation that splits them.
- **Fold side findings into your hypothesis set.** A subagent chasing hypothesis
  A that stumbles on evidence for cause C has just widened the space - add C and,
  if it's plausible, test it.
- **For a high-stakes root cause, spawn an adversarial pass:** one more subagent
  whose _only_ job is to refute the leading cause, given the evidence so far.
  Accept the cause only if it survives a genuine attempt to break it.
