---
name: strategic-brief
description: >-
  Demand validation before committing to an idea that is not yet drafted: a product
  feature, a strategic initiative, or a significant marketing investment. Runs a
  six-question demand diagnostic, writes an initiative brief, challenges it adversarially
  on demand evidence, scope creep, feasibility and success criteria, then issues a GO,
  NO-GO or CONDITIONAL GO. Use before committing more than about two days of work, when a
  request arrives without demand evidence or success criteria, or on is this worth doing,
  should we build this, or write the brief. Do NOT use to review a plan already drafted
  (use `ceo-review`), to rank several candidates (use `rice-prioritization`), to review a
  drafted campaign brief before launch (use `campaign-brief`), or to audit finished
  creative (use `brand-review`).
license: MIT
argument-hint: '[the idea or request to validate]'
---

# Strategic Brief

A pre-commitment ritual that forces demand validation before resources are
committed.

**Core insight:** an adversarial review before commitment closes the gap between
"this sounds like a good idea" and "this has real demand evidence". The default
instinct is to execute on the first plausible idea. This skill forces the
questions: what is missing, what is the strongest counterargument, and which
assumption is most likely wrong?

Paths below are relative to this skill's directory; resolve them to absolute
paths before reading anything.

## When to use

- Before opening any tracked work item expected to take more than two days.
- Before green-lighting a new product feature, a strategic initiative, or a
  significant marketing investment.
- When a request arrives without clear demand evidence or success criteria.
- When the scope feels fuzzy, or the problem definition shifts from one
  conversation to the next.

## When not to use

- Tactical execution with a clear specification: work the issue directly.
- Work whose scope the owner has already locked.
- Tasks under about two days, where the overhead is not warranted.
- A plan already drafted that needs a leadership read: `ceo-review`. Several
  candidates to order: `rice-prioritization`. A campaign about to ship:
  `campaign-brief`.

## Where the company context comes from

Demand evidence, the segment and "why now" are judged against what the company
is betting on and who it sells to, so the brief needs that context and must not
invent it.

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Context source.** In order: a strategy, positioning, ideal-customer or
  roadmap document the user names; one in the conventions folder named in
  `docs/agents/workspace.md` (default: none); what the user pasted into the
  conversation.
- **With none of these,** ask the user for the minimum: the two or three core
  bets the company is making now, and who it sells to. Ask the user, using your
  structured-question tool if you have one; otherwise list the questions
  numbered in plain text and stop until they reply. If they would rather you
  proceed, run on the request alone and mark Q1 and Q6 **not checked against
  stated strategy**.
- **Issue tracker** (`docs/agents/issue-tracker.md`): where the brief and verdict
  are posted when the initiative lives in an issue. Default: none configured.
- **Scratch folder** (`docs/agents/workspace.md`): where the brief is saved when
  it has no other home. Default: `.scratchpad/`, git-ignored.

## Step 1: the demand diagnostic

Ask the person who brought the idea these six questions in order, or reason
through them yourself from the context you have. Do not move on until the
current one has a specific answer. Generic answers ("our users", "improve
engagement") are not acceptable: push for a named segment, concrete evidence and
a measurable definition.

1. **Who specifically has this problem?** Not "users" or "customers". Name the
   segment: a job title, a company type and a situation. For example: "head of
   revenue operations at a 50 to 150 person B2B software company, managing a
   team of three."
2. **What is the evidence of demand?** Direct customer conversations (quote
   them), observed workarounds, support tickets, prior campaign data, a
   competitive gap analysis. "We think" and "it seems" are not evidence.
3. **What does success look like in 90 days?** Measurable and specific. Not
   "improve retention", but "reduce 30-day churn from 8% to 5% in that segment."
4. **What is the minimal viable version?** What would you cut with half the
   time? The answer names the true core bet and exposes scope creep in the
   original description.
5. **What are you explicitly not building?** Force a scope boundary. If nothing
   is excluded, the scope is undefined.
6. **Why now?** Why is this the right thing to work on today rather than the next
   best alternative? What does delay cost, and what does doing this instead of
   that alternative cost?

## Step 2: write the initiative brief

Synthesize the answers into a brief:

```markdown
# Initiative brief: [initiative name]

**Date:** [YYYY-MM-DD]
**Initiated by:** [person or role]
**Estimated scope:** [days of work]

## Problem
[Who has the problem, in specific terms. Two or three sentences.]

## Demand evidence
[Concrete evidence: quotes, data, observed behaviour. No speculation.]

## Success criteria (90 days)
[One measurable outcome, in one sentence.]

## Minimal viable scope
[What is being built, as a bulleted list.]

## Explicit non-scope
[What is not being built, as a bulleted list.]

## Why now
[The opportunity-cost reasoning, in two or three sentences.]
```

## Step 3: adversarial review, up to two rounds

Challenge the brief on four dimensions using the prompt in
[references/adversary.md](references/adversary.md). If you can dispatch
subagents, give that prompt and the brief to one fresh subagent: a reader who
did not sit through the diagnostic has not already been persuaded by it.
Otherwise work the prompt yourself, reading the brief as a sceptic who has not
seen the conversation behind it.

Revise the brief against every challenge. If the revision answers them all, skip
the second round. If challenges remain unresolved after two rounds, stop and put
them to whoever owns the decision; do not proceed without resolution.

## Step 4: go or no-go

```markdown
## Go/no-go recommendation

**Verdict:** GO / NO-GO / CONDITIONAL GO

**Conditions (if any):**
- [A specific condition that must be resolved before proceeding]

**The one or two concerns that most need resolution:**
1. [The highest-risk open question]
2. [The second, if there is one]
```

- **GO:** the demand evidence is strong, the scope is clear, and the success
  criteria are measurable.
- **NO-GO:** the demand evidence is weak or missing. Do not proceed until it is
  gathered.
- **CONDITIONAL GO:** proceed only once the listed conditions are resolved.

## Step 5: publish and link

- **The initiative lives in an issue** in the configured tracker: attach the
  brief to it the way `docs/agents/issue-tracker.md` describes, and post the
  verdict and conditions as a comment.
- **A new initiative is being opened:** the brief goes in first, before any
  implementation sub-issues are created.
- **No tracker configured:** write the brief beside the planning document it
  belongs to, or where the user asks; if they want it kept out of tracked files,
  save it as a file in the scratch folder. Give the user the verdict and
  conditions to pass on to whoever needs them.

## Key principle: specificity over generality

Named customers, specific examples, concrete data points, always. "Three
customers in our target segment told us they spend four hours a week on this by
hand" beats "customers find this valuable". The brief should be quotable to the
people who fund the work.
