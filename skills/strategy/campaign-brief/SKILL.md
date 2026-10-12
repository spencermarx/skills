---
name: campaign-brief
description: >-
  Adversarial pre-launch review of a marketing campaign brief: challenges it on six
  dimensions (audience specificity, dream outcome, demand evidence, differentiation,
  measurability, message-audience fit), rewrites the brief, and issues a GO, NO-GO or
  CONDITIONAL GO. Use before an outbound sequence, a paid ad test, a content push or a
  co-marketing deal ships, or whenever someone asks is this campaign ready. Do NOT use to
  write the copy (use `draft-conversion-copy`), to review drafted copy line by line (use
  `seven-copy-critics`), to audit finished creative (use `brand-review`), or to judge a
  plan that is not a campaign (use `ceo-review` or `strategic-brief`).
license: MIT
argument-hint: '[the campaign brief, or where it lives]'
---

# Campaign Brief

An adversarial review that challenges a campaign brief before any execution
begins.

**Core insight:** the default failure in marketing is a campaign that is
technically complete but strategically weak: a vague audience, mechanism-first
messaging, no success threshold. This review catches those before launch, not
after.

## When to use

- Before finalizing an outbound email or social sequence.
- Before launching a paid ad experiment.
- Before a content push: a post series, a social campaign, a newsletter run.
- Before committing to a partnership or co-marketing arrangement.

## When not to use

- A single post or one-off asset: review its copy with `seven-copy-critics` and
  its design with `brand-review`.
- Strategy upstream of any campaign: `strategic-brief` or `ceo-review`.
- After launch. This is a pre-commitment tool, not a post-mortem.

## Where the company context comes from

Audience, positioning and proof are judged against what the company knows about
its buyers, so the review needs that context and must not invent it.

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Context source.** In order: a positioning, ideal-customer or strategy
  document the user names; one in the conventions folder named in
  `docs/agents/workspace.md` (default: none); what the user pasted into the
  conversation.
- **With none of these,** ask the user for the minimum: who the campaign is for,
  what that person gets from it, and any evidence the message has landed before.
  Ask the user, using your structured-question tool if you have one; otherwise
  list the questions numbered in plain text and stop until they reply. If they
  would rather you proceed, run on the brief alone and say which dimensions you
  could not check against real buyer knowledge.

## Step 1: read the brief

Obtain the brief, or write out the one implied by the request. A minimal brief
has:

- Target audience.
- Core message or value proposition.
- Channel and format.
- Timeline and budget, where they apply.
- Success metric.

Where a field is missing, fill it with an explicit assumption, labelled as one,
before you continue.

## Step 2: challenge it on six dimensions

For each dimension write:

> **Claim:** what the brief says or implies. **Challenge:** why it is weak.
> **Required fix:** what would close the gap.

Write PASS only when the dimension is genuinely strong. No false credit.

1. **Audience specificity.** Is the audience a named segment with a real person
   behind it?
   - Weak: "HR managers at mid-market software companies."
   - Strong: "Head of revenue operations at a 50 to 150 person B2B software
     company, running a team of three and judged on pipeline quality, not
     volume."

   A generic segment produces generic copy. Every word must be written to one
   specific person.
2. **Dream outcome clarity.** Does the primary promise lead with the outcome
   (more bookings, more revenue, less churn, less manual work) or with the
   mechanism (AI-powered, automated, real-time)?
   - Weak hook: "[Product] gives your team real-time AI insights."
   - Strong hook: "[Product] helped [Company] book 40% more meetings without
     adding headcount."

   The mechanism is the explanation, never the hook.
3. **Demand evidence.** Is there evidence this message lands with this
   audience? Acceptable: quotes from real conversations, past open and reply
   data, customer interviews, research showing the framing works in an adjacent
   market. Not acceptable: "we believe", "we think", "it makes sense that".
   With no evidence the campaign is a hypothesis: label it a test, not a launch.
4. **Differentiation.** What sets this apart from the ten other messages in the
   reader's inbox this week? Swap in a competitor's logo: if the message still
   reads the same, it fails. Name the one thing only this company can say; that
   is the hook.
5. **Measurability.** The specific metric and threshold.
   - Weak: "improve engagement."
   - Strong: "at least 15% opens and 3% replies in the first two weeks; if
     neither, pause and rework."

   Both the result that means it worked and the one that means it failed are
   stated before launch.
6. **Message-audience fit.** Does the framing match this audience's primary
   motivation? The same product wins differently for different roles:
   - An operations lead cares about efficiency, reliability and a team that
     scales.
   - A founder cares about growth rate, cash and competitive position.
   - A sales manager cares about rep performance, conversion and quota.

   A founder-lens pitch sent to an operations audience underperforms. Check the
   framing against the reader's actual day-to-day stakes.

## Step 3: rewrite the brief

Produce the revised brief, carrying every required fix:

1. **Audience definition**, if it was too generic.
2. **Primary message or hook**, if the outcome was not leading.
3. **Evidence note**, labelling what is validated and what is hypothesized.
4. **Differentiator**: the one thing only this company can say.
5. **Success metric and threshold**, with numbers and a timeline.
6. **Copy edits**: one to three specific headline or subject-line rewrites,
   where they apply.

## Step 4: go or no-go

```markdown
## Go/no-go recommendation

**Verdict:** GO / NO-GO / CONDITIONAL GO

**Conditions (if any):**
- [What must be resolved before launch]

**Strongest dimension:** [one of the six]
**Weakest dimension:** [one of the six]
```

- **GO:** all six pass or nearly pass, and the revised brief is ready to execute.
- **NO-GO:** demand evidence is missing, or audience specificity is fatally weak.
- **CONDITIONAL GO:** proceed on the revised brief as a test with tight feedback
  loops; hold back full budget until early signals confirm.

## Step 5: hand off the execution checks

This review settles the strategy of the campaign, not the finished pieces. Once
the revised brief is accepted, name the two reviews still owed before launch:

- **Copy.** Load the `seven-copy-critics` skill (through your skill tool,
  `/seven-copy-critics`, or by reading its SKILL.md) and run it on the drafted
  copy, passing the revised brief's audience and hook as the reader it is
  written for. If no copy is drafted yet, `draft-conversion-copy` writes it
  from the revised brief when that skill is installed.
- **Creative.** Load the `brand-review` skill (same routes, `/brand-review`)
  and run it on each finished visual asset.

Run whichever the user asks for now; list the others as outstanding. If a skill
is not installed, say so and name what it would have checked.

## Key principle: audience-specific personal wins

The same product delivers a different personal win to each role. The brief must
say not only what the product does but what winning looks like for this person
in their job, and that framing must appear explicitly in the copy.
