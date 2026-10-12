# The coverage model

Seven tiers. Each catches a class of failure the one below structurally cannot,
which is the only reason to have more than one. Adopt in order; skipping a tier
means the one above it is measuring on top of an unmeasured foundation.

Two are built. The rest are named so a proposal to measure something new can say
which tier it belongs to rather than inventing a category.

| Tier | Question | Built | Catches | Blind to |
|---|---|---|---|---|
| 0 Static | is the artifact well formed | partly | what no model run should be spent on | whether anything fires |
| 1 Routing | does the right thing fire | yes, in Claude Code | the recognition gap | whether the skill was any good |
| 2 Adherence | was the convention obeyed | no | silent drift | multi-step failure |
| 3 A/B lift | does this earn its context budget | no | artifacts that pay for nothing | emergent interactions |
| 4 End-to-end | did the task actually get done | no | emergent multi-artifact failure | interference from edits |
| 5 Regression | what broke when I edited | no | interference | novel attack surface |
| 6 Safety | can this be turned against us | no | injection, excessive agency | |

## Tier 0, static

`check_descriptions.py` and `check_globs.py`, and the bar for a third is high.

The temptation is to lint everything: description length, body size, frontmatter
shape, dead links. Resist it on evidence. The repository this engine comes from
ran that experiment once, and the audit found 45 of 47 finding codes never fired
on a fresh clone, while one of the two that did flagged the repository's own
skills 21 times. A second attempt produced four false positives against one real
finding, because it did not partition on `disable-model-invocation`.

A static check earns its place by catching something real that no other tier
sees. Glob over-reach qualifies: a Claude Code rule globbing `**/*.md` claims
every markdown file in vendored trees nobody here authors, paying a rule load on
every read of them, and nothing else reports a file that too many globs reach.

The description cap qualifies too, and shows where "resist description length"
actually bites. A check asking whether a description is a *good* dispatch surface
flags every human-invoked skill as too short, and is the false-positive shape to
avoid. A check enforcing a *maximum* is the opposite: a hard ceiling nothing else
catches. `census.py` prints the lengths but exits 0 whatever it finds, which is
how a description drifts past a cap unnoticed, and a maximum cannot mistake a
terse human-invoked description for a defect, so it needs no partition to draw.

Static checks are the harness-neutral tier: they read files, so they hold for
any harness that reads `SKILL.md`, except `check_globs.py`, which checks a
Claude Code feature.

## Tier 1, routing

Built, and the highest value per dollar in the model. It measures Claude Code.

Balanced positive and near-miss cases, asserted with `skill-used` and
`not-skill-used`. Two distinct failures live here, and only measuring both
separates them: a skill that fails to fire when it should, and a skill that fires
when a sibling should have. Function-calling benchmarks treat irrelevance
detection as its own category for this reason.

## Tier 2, adherence

Not built. The cheapest starting point in the rest of the model, because part of
it needs no judge at all.

Mechanical clauses of a convention (no em dashes, no emojis, a required
frontmatter key) are greps. Measure them by zone: in the source repository the
authored notes were 92 percent clean and the vendored trees 15 to 18 percent,
which is a working rule with an over-reaching glob, not a failing rule, and only
splitting the corpus by zone shows it.

For clauses that need judgement, decompose each convention into atomic yes/no
questions and score the ratio satisfied, rather than asking one judge for an
overall verdict. Grade each dimension with its own judge, and give the judge an
explicit way to answer "unknown".

## Tier 3, A/B lift

Not built. Worth running once as an audit rather than continuously.

Paired trials with and without the artifact, same prompts, same everything else.
This is the only tier that answers whether an artifact earns the context it
costs. A factorial study of 1,650 Claude Code sessions found no detectable
adherence effect from instruction-file size, position, architecture, or
cross-file contradiction, while a separate study found machine-generated context
files hurt and human-written ones helped. Expect some artifacts to fail this
test.

## Tier 4, end-to-end

Not built. Expensive; scope to the handful of workflows that matter.

Grade the final state, not the transcript and not the tool-call sequence. For
most repositories the final state is the git working tree. Sequence matching is
too rigid: agents find valid paths a case author did not anticipate, and a test
that fails them is measuring the author's imagination.

## Tier 5, regression

Not built, and nearly free once Tier 1 has cases worth freezing.

Freeze a passing suite, re-run it after an edit, report the paired delta. This is
the tier that answers "what breaks when I change a skill". Prompt improvements
are non-monotonic across tasks: a change that improves one behaviour can degrade
another, and nothing surfaces that except re-running the old cases.

## Tier 6, safety

Not built, and usually the most exposed gap.

An agent that reads markdown from merged branches, client folders or fetched
pages faces indirect prompt injection by construction. The lethal trifecta is
private data, untrusted content, and a way to communicate externally: check
whether a library's skills put all three in one session. A hook that rewrites
shell commands deserves a test of its own.

Score utility and attack success together. A defence that breaks the agent is not
a defence.
