---
name: ceo-review
description: >-
  Executive review of a drafted plan, proposal or roadmap item: commits to one stance
  (EXPAND, CHERRY-PICK, HOLD or CUT), judges the plan on eight business dimensions, and
  returns stance-specific scope changes plus at most five ranked open questions. Use when
  a plan is on the table and needs a hard leadership read: quarterly roadmap priorities,
  a significant new bet, a pivot, or a large resourcing call. Do NOT use to test whether
  demand exists before anything is drafted (use `strategic-brief`), to rank several
  initiatives against each other (use `rice-prioritization`), to review a marketing
  campaign (use `campaign-brief`), or to audit finished creative (use `brand-review`).
license: MIT
argument-hint: '[the plan to review] [EXPAND | CHERRY-PICK | HOLD | CUT]'
---

# CEO Review

A structured, leadership-level review of one plan, proposal or roadmap item.

**Core principle:** choose a stance before reading the plan in detail. A review
that tries to expand, hold and cut at once produces confused output. The stance
governs every dimension that follows, so it is declared first and never mixed
within one review.

## When to use

- Setting or revisiting roadmap priorities for a quarter.
- Reviewing a significant new bet, a pivot, or an investment proposal.
- A resourcing call large enough that getting it wrong costs weeks, not hours.
- A plan has been presented and needs a rigorous, structured response.

## When not to use

- Tactical execution feedback: comment on the work directly.
- Demand is still unproven and nothing is drafted: `strategic-brief` first, then
  this review.
- Several candidates need ordering: `rice-prioritization`.
- A marketing campaign: `campaign-brief`. Finished creative: `brand-review`.

## Where the company context comes from

Strategic Fit and Competitive Moat are judged against what the company is
betting on, so the review needs that context and must not invent it.

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Strategy source.** In order: a strategy, positioning or roadmap document the
  user names; one in the conventions folder named in `docs/agents/workspace.md`
  (default: none); what the user pasted into the conversation.
- **With none of these,** ask the user for the minimum: the two or three core
  bets the company is making now, and its current stage or constraint. Ask the
  user, using your structured-question tool if you have one; otherwise list the
  questions numbered in plain text and stop until they reply. If they would
  rather you proceed, run on the plan alone and mark Strategic Fit and
  Competitive Moat as **not checked against stated strategy**.
- **Issue tracker** (`docs/agents/issue-tracker.md`): where the summary is posted
  when the plan lives in an issue. Default: none configured.

## Step 1: select the stance

| Stance | Strategic context | What it asks |
|---|---|---|
| **EXPAND** | Growth mode | What is the 10x version? What would we add with 3x the resources? |
| **CHERRY-PICK** | Constrained resources | Which 20% of this delivers 80% of the value? |
| **HOLD** | Execution rigour | Add nothing; pressure-test everything already in scope. |
| **CUT** | Over-committed | What do we kill without losing the core bet? |

The stance is a strategic choice, so it belongs to the user. If they named one,
use it. If not, propose the one the context points to, with a one-line reason,
and ask them to confirm or pick another before you continue.

Declare it at the top of the review:

> Stance: HOLD. We are executing the current roadmap without additions. This
> review pressure-tests execution quality, not scope.

## Step 2: review across eight dimensions

Write two to five sentences per dimension. Be direct: what is strong, what is
weak, what is missing. Where a judgment rests on context you could not check,
say so in that dimension.

1. **Strategic fit.** Does this advance the core bets, or is it adjacent or a
   distraction? Is it agreed as a priority, or driven by recency or a single
   voice?
2. **Market timing.** Why now? What happens if it ships six months later? What
   is the window, and is there evidence it is real (competitor moves, customer
   pressure, regulatory change)?
3. **Resource requirement.** The realistic cost in people's time, cash and
   attention. Is the estimate anchored to comparable past work, or optimistic?
   What are the hidden costs: maintenance, iteration, dependencies?
4. **Competitive moat.** Does this create a durable advantage, or is it easily
   copied? If a well-funded competitor launched the same thing next quarter,
   what would we have that they would not?
5. **Reversibility.** A two-way door can be undone cheaply; a one-way door
   (architecture, public commitments, vendor lock-in) cannot. One-way doors
   demand more rigour up front.
6. **Measurability.** The specific metric and threshold at 30 and 90 days. With
   no metric the initiative cannot be evaluated, and that is a blocking concern.
7. **Dependencies.** Everything else that must be true: other teams, third-party
   tools, data, a change in customer behaviour. Which is most likely to slip,
   and what happens to the initiative if it does?
8. **Risk concentration.** The single most likely failure mode. Not a list:
   name the one thing the post-mortem would blame.

## Step 3: stance-specific output

**EXPAND**
- The top three additions that would multiply the initiative's value.
- The resources each needs.
- Which fit the current timeline and which belong to a later phase.

**CHERRY-PICK**
- The highest-return 20% of scope, named as specific deliverables, not
  categories.
- What to defer to a second version, and why.
- The effort this saves against the full scope.

**HOLD**
- The three highest-risk execution assumptions in the current scope.
- The pressure-test questions the team must answer before proceeding.
- Leading indicators to watch in the first two weeks.

**CUT**
- What to eliminate, named as specific features or workstreams.
- The initiative restated at its minimal scope.
- Confirmation that the core bet survives the cuts.

## Step 4: prioritized open questions

Close with at most five questions that must be resolved before proceeding,
ranked by urgency. Each names who must answer and by when.

```markdown
## Open questions (prioritized)

1. [Question] - Owner: [name or role] - Needed by: [date or milestone]
2. [Question] - Owner: [name or role] - Needed by: [date or milestone]
```

## Step 5: deliver the review

Write the full review where the plan lives, or where the user asks: beside the
planning document, or as a file in the scratch folder (`docs/agents/workspace.md`;
default `.scratchpad/`, git-ignored) if they want it kept out of tracked files.

If the plan lives in an issue in the configured tracker, also post a short
summary there: the stance, the top concern from each dimension, and the first
open question. With no tracker configured, give the user that summary to send
to whoever needs it.
