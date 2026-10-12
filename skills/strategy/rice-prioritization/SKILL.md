---
name: rice-prioritization
description: >-
  Score and rank a list of candidate features or initiatives with the RICE model (Reach x
  Impact x Confidence / Effort), using a deterministic calculator, then pressure-test the
  scores and write a ranked, sensitivity-checked analysis ending in a decision block for
  the user. Use whenever a backlog or shortlist needs ordering against one goal, a roadmap
  ordering debate needs numbers, or someone asks to compare initiatives on impact per
  effort or to RICE-score something. Do NOT use for a go/no-go on one undrafted idea (use
  `strategic-brief`), for a leadership review of one drafted plan (use `ceo-review`), for
  a marketing campaign (use `campaign-brief`), or to make the final call, which stays
  with the user.
license: MIT
argument-hint: '[the candidates to rank, or where they live] [the goal they are scored against]'
---

# RICE Prioritization

Scores and ranks a candidate list with RICE: `(Reach x Impact x Confidence) /
Effort`. The output is a relative ranking plus a sensitivity read and a decision
block for the people who own the roadmap, never a committed roadmap.

**The governing principle: RICE produces better numbers to argue about; it does
not remove the argument.** The skill surfaces a defensible ranking, and the
user decides. A high score never green-lights a project that fails the strategy.

**The agent boundary.** You may draft Reach from real data and structure a
Confidence evidence tier. You must not invent Reach when no data exists, and you
must not assign Effort or strategic Impact yourself: those depend on the
codebase, the team and the goals you cannot see. Mark them `NEEDS-HUMAN` and
continue with a clearly flagged draft. The full boundary is in
`references/rice-methodology.md`.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## When to use

- A backlog or shortlist of features or initiatives needs ranking against one
  goal.
- A roadmap-ordering debate where impact per effort is the right lens.
- Candidates differ in how many people they reach (RICE's edge over ICE).

## When not to use

- One initiative and no list to rank: `strategic-brief` for an undrafted idea,
  `ceo-review` for a drafted plan.
- Someone's personal weekly priorities: there is no shared goal or reach window
  to score a personal week against. Handle it as a planning conversation.
- Foundational, technical-debt or market-timing work that always scores low:
  carve out a strategic lane instead (see "When RICE is NOT the right tool" in
  the methodology).
- The final build commitment: that is always the user's call.

## Where things live

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Strategy source.** Impact is scored against the round's goal, and the
  decision block names where the ranking and the strategy diverge, so the
  ranking needs to know what the company is betting on. In order: a strategy or
  roadmap document the user names; one in the conventions folder named in
  `docs/agents/workspace.md` (default: none); what the user pasted into the
  conversation. With none, ask for the minimum alongside the round constants in
  Step 1: the two or three core bets the company is making now. If the user
  would rather you proceed, mark "Where RICE and strategy diverge" **not checked
  against stated strategy**.
- **Output.** A path the user names, else the scratch folder
  (`docs/agents/workspace.md`; default `.scratchpad/`, git-ignored), in
  `<scratch folder>/rice/<YYYY-MM-DD>-<subject-slug>/`.
- **House rules** for the written analysis come from the conventions folder, if
  one is configured. Otherwise: no emojis, ranges over false precision, sources
  cited inline.

## Step 1: frame the round

Establish, and write down, four constants before any scoring:

- **Goal or metric.** The single goal candidates are scored against (activation,
  retention, revenue).
- **Candidate list.** The items to rank. If the user has not supplied one, ask.
  Do not invent candidates.
- **Reach time window.** One window for the entire round (per quarter, say),
  locked here and used for every item.
- **Subject.** A short name for the round, used for the output folder.

Ask for whichever the request did not settle. Ask the user, using your
structured-question tool if you have one; otherwise list the questions numbered
in plain text and stop until they reply.

Then pick the **mode**:

| Mode | Use when | What you do |
|---|---|---|
| **Autonomous** | A fast draft is wanted, some data exists, and a person will review later | Draft all four factors with an evidence flag per number; mark Effort and strategic Impact `NEEDS-HUMAN`; never invent Reach |
| **Facilitated** | A person or group is scoring live | Run the session from `references/facilitation-guide.md`; elicit and record their scores |
| **Hybrid** | A person is available but wants a head start | Pre-fill an autonomous draft, then walk them through confirming or adjusting each factor |

Default to Hybrid when the user is in the loop, and to Autonomous when asked to
produce a draft alone.

## Step 2: calibrate the scales

Before scoring, anchor Impact and Confidence against about three
already-shipped features the team knows. This is the single highest-leverage
move against scale drift.

- **Facilitated or Hybrid:** do this with the user, using the calibration
  section of `references/facilitation-guide.md`.
- **Autonomous:** state the anchors explicitly in the output ("I am treating
  [known feature] as Impact 2, Confidence 80%") so the user can correct the
  frame.

## Step 3: score each candidate

Score every candidate on all four factors, sourced rather than guessed, using
the exact scales in `references/rice-methodology.md`: Impact `3/2/1/0.5/0.25`;
Confidence `100/80/50%`; Effort in person-months across ALL disciplines; Reach
an absolute count in the locked window.

- **Autonomous:** draft each number with an evidence flag (`data`, `some-data`
  or `assumption`). Mark Effort and strategic Impact `NEEDS-HUMAN`. Attach a
  `reach_source` note to every Reach number. If no data supports a Reach figure,
  say so; do not fabricate one.
- **Facilitated:** elicit scores through the per-factor question bank in the
  facilitation guide, and record who supplied each.
- **Hybrid:** present the draft, then confirm or adjust each factor with the
  user through the question bank.

Carry the provenance (evidence flag, reach source, `NEEDS-HUMAN` markers, notes)
alongside each candidate; the calculator passes it through untouched.

## Step 4: compute

Write the scored candidates as a JSON list to `candidates.json` in the output
folder, and run the calculator in the shell. Do not compute scores or ranks by
hand.

```bash
python3 <skill dir>/scripts/rice_score.py <output folder>/candidates.json
# add --format table for a quick read
```

It needs Python 3 and nothing else. If `python3 --version` fails, tell the user
the calculator needs Python 3 and stop rather than computing the scores
yourself.

The input shape and output fields are in `scripts/README.md`. The script returns
each candidate's `rice_score` and `rank`, the near-tie groups (`tie_group`,
default within 15%), and `sensitivity` for adjacent pairs (the confidence that
would flip the order). It exits non-zero on a bad scale value and names the
candidate and field; fix the input rather than working around it.

## Step 5: adversarial challenge pass

Before presenting, pressure-test the scores against the three known gaming
vectors, using the critic prompts in
[references/challenge-critics.md](references/challenge-critics.md):

- **Reach Inflator:** challenges Reach numbers.
- **Confidence Optimist:** challenges Confidence.
- **Effort Underestimator:** challenges Effort.

If you can dispatch subagents, run the three in parallel, one critic each;
otherwise work them one after another yourself. For a small or low-stakes list,
a single self-challenge against all three vectors is enough: scale the rigour
to the stakes.

Each critic returns the rows it disputes and why. Record what was challenged and
what changed. If any score moves, re-run Step 4. Keep the challenge record for
the artifact; never bury unresolved dissent.

## Step 6: present and write the artifact

Fill `templates/rice-analysis.md` and write it as `00-summary.md` in the output
folder, beside `candidates.json`. Ask for the subject rather than guessing it.

The artifact carries: the round's constants, the mode and calibration anchors,
the ranked scoring table (with the evidence and source for each Reach), near-ties
and sensitivity, quick wins grouped by effort, the adversarial challenge record,
the assumptions and open-questions log, and a **Decision required** block that
surfaces the ranking and a recommendation but does not decide.

Report the absolute path of the artifact, the top of the ranking, any near-ties,
and every `NEEDS-HUMAN` number still waiting on the user.

## Going deeper on the top candidates

When the top three to five are high-stakes enough to warrant a 30-minute
estimate over a 30-second one, or a near-tie the rough scores cannot separate,
run the DRICE deep dive in
[references/drice-deep-dive.md](references/drice-deep-dive.md): detailed
expected-outcome estimates on the shortlist, recomputed with the same script.

## Composition

- Feeds `strategic-brief` for a deep go/no-go on the top-ranked item.
- The ranking can be an input to `ceo-review` when one initiative needs fuller
  scrutiny.
