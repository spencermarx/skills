# Reading a result

The arithmetic that decides what a number here is allowed to claim.

## Report a delta, not a score

Absolute pass rates at this scale are close to unreadable. At 100 cases and an 80
percent pass rate, the 95 percent confidence interval runs from roughly 72 to 88.
At the twenty or so cases a cluster suite actually holds, it is far wider than
that.

A paired comparison, the same cases run against two versions, cancels the noise
both versions share and detects a much smaller real difference than either
absolute number could. So the reportable claim is "this description moved the
cluster from 11/20 to 16/20 over three runs", never "this skill scores 80
percent".

Fifteen cases is a hard floor. Below it, nothing but an enormous difference is
distinguishable from chance.

## Run more than once

A single run of a non-deterministic system is an anecdote. Three is the working
minimum, and the spread across runs is itself a finding: a case that passes twice
and fails once is telling you something a mean hides.

Report mean and standard deviation together. A cluster at 70 percent plus or
minus 4 and one at 70 percent plus or minus 22 are different situations, and only
the second one is urgent.

## Consistency is a different question from capability

Two statistics, and they answer different questions.

**pass@k** asks whether at least one of k attempts succeeded. Right when a person
is in the loop and can retry.

**pass^k** asks whether all k attempts succeeded. Right when the behaviour has to
hold every time without supervision.

They diverge fast. A skill that fires 75 percent of the time has a pass^3 of
about 42 percent. For a skill that should fire whenever its trigger appears,
pass^k is the honest number.

## What a trigger rate does not measure

It measures a description against a set of queries somebody chose. It says
nothing about whether the skill does good work once it fires, and it is not a
quality score.

It is also not a measure of the model alone. The thing under test is the harness
and the model working together, so a number that changes when neither the skill
nor the cases changed is a signal about the environment (a Claude Code or SDK
update, a model change), not a mystery to explain away.

## Report two numbers, never the blend

A single pass rate over a cluster blends two independent things, and the blend is
dominated by the one a description cannot move. Report them apart:

- **Dispatch rate**: did *any* skill fire. This is mostly a property of the model
  and harness, and a description barely moves it. On a positive case it counts
  the asserted skill firing *or* the wrong sibling firing: any `Skill` call at
  all. A bare `not-skill-used` pass does **not** count toward it, because that
  assertion passes identically when nothing dispatched.
- **Routing accuracy given dispatch**: of the runs where a skill fired, did the
  *asserted* skill fire. This is the description signal, and the number a
  description change is judged on.

The blend hides both. In the first real sweep in the repository this engine comes
from, dispatch floored near 40 percent on ambiguous prompts while routing given
dispatch ran around 90 percent (95 on one cluster, 88 on another), and the
headline read 45 percent. A description that genuinely improves routing is
invisible underneath that floor, and a regression hides there just as well.

Splitting the two needs the recorded skill calls, not just pass or fail: "the
wrong sibling fired" and "nothing fired" both fail `skill-used`. Write the run
with `--output` and compute the split from it ([engine.md](engine.md#reading-the-raw-results)).

## Which failure you are looking at

Published measurement puts baseline skill activation near half, and finds that
when a model does activate a skill it reliably picks the right one. Recognition
is the bottleneck, not selection.

That pair of claims is the reason this tier exists and the reason to rewrite
triggers before bodies. Nobody has traced the exact figure to a specific study,
so treat it as a working prior rather than a measured fact. The first real sweep
that tested it agreed: dispatch floored near 40 percent, and a read of the
provider source plus a by-hand `claude --print` check established the floor as a
property of the model and harness rather than an eval artifact. The eval runs
the same `claude` binary and `claude_code` system prompt a live session does,
and surfaces *fewer* skills (project settings only), so its dispatch rate is
conservative, never inflated. Still believe a later sweep that overturns it.

So read a low number in that order. If the intended skill did not fire at all,
the description failed to be recognised, and the triggers are what to rewrite. If
the wrong sibling fired, the two descriptions overlap and the fix is negative
routing in both. If the right skill fired but the work was poor, routing is fine
and this tier has nothing more to say.

## Saturation

A suite at 100 percent has stopped measuring. Either the cases got easier than
reality or the near-misses are too far from the real triggers. Add harder cases
rather than reporting a perfect score, and note in the case file what was
changed, so a later comparison against the frozen suite compares like with like.

## Read the transcripts

The aggregate is a summary of what you read, not a substitute for reading it.
Eval numbers are not taken at face value until somebody has opened the
trajectories and seen what actually happened, because a case can pass for the
wrong reason and a suite of those reads exactly like a healthy one.
