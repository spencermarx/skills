# RICE Facilitation Guide

How to run a RICE scoring session with humans. Load this in Facilitated and
Hybrid modes. The core skill (`SKILL.md`) handles the math and the artifact;
this guide handles the human conversation: calibration, the per-factor question
bank, and disagreement handling.

A scoring session is typically 30-45 minutes for 5-10 candidates with 2-5
participants plus a facilitator ([Learning Loop](https://learningloop.io/plays/workshop-exercise/rice-scoring), [SessionLab](https://www.sessionlab.com/methods/rice-scoring-model)).

## The flow

1. **Define the candidates (5 min).** List 5-10 initiatives with a one-line description each. Fewer than 5 and you do not need the framework; more than ~25 and the session exhausts people ([Product Coalition](https://www.productcoalition.com/p/mastering-rice-prioritization-a-no)).
2. **Set the round's constants.** Agree the single goal/metric and the one reach time window before any scoring. Everyone scores against the same target and window.
3. **Introduce and calibrate (5 min).** Walk the scales. Anchor against ~3 already-shipped features whose real reach/impact everyone remembers. Shared reference points are what stop scale drift between people and over time ([Rock](https://www.rock.so/blog/rice-scoring)).
4. **Score individually (10 min).** Each participant scores all candidates on all four factors alone, no discussion. This prevents the loudest voice from anchoring the room ([Learning Loop](https://learningloop.io/plays/workshop-exercise/rice-scoring)).
5. **Reveal, discuss, calibrate (20 min).** Show the spread. Wherever scores diverge widely, ask the people at the extremes to explain. Converge on a shared number.
6. **Compute and rank.** Feed agreed scores to `rice_score.py`. Read out the ranking, the near-ties, and the sensitivity flags.
7. **Decide next steps (5 min).** Top items are candidates, not commitments. Name dependencies, strategic overrides, and what to validate before building.

## Calibration anchoring (do this before scoring, every time)

Pick three shipped features the team knows well. For each, agree where it sits on
the Impact tiers (3/2/1/0.5/0.25) and what Confidence it would have had at the
time. Those become the reference marks. New scores get phrased relative to them:
"is this more or less impactful than [anchor feature]?" This is the highest-
leverage move for honest scoring ([Rock](https://www.rock.so/blog/rice-scoring), [howtoes](https://howtoes.blog/2025/07/01/rice-scoring-complete-guide-to-prioritizing-initiatives-for-strategic-product-development/)).

## Per-factor question bank

Ask about the specific factor, not for a general opinion.

### Reach
- How many people or accounts does this touch in our one time window?
- What is the data source for that number, and are we all looking at the same view?
- Are these users equal in value, or should we weight by segment/revenue?
- Are we counting people affected, or people who actively use it?

### Impact
- Relative to [anchor feature], is this more or less impactful per user?
- What is the baseline we are moving, and by roughly how much?
- Is this a 3 (massive, transformative) or are we rounding up a 1?
- Does it move the round's goal, or an adjacent metric we are not scoring?

### Confidence
- What evidence backs reach and impact: hard data, some data, or a hunch?
- Why 80% and not 50%? Point to the evidence behind the number.
- What is the biggest unknown that could make this wrong?
- If confidence is below 50%, what cheap test would raise it before we commit?

### Effort
- Which disciplines are in this estimate: product, design, eng, QA, anything else?
- What hidden work are we missing: migration, docs, review, launch?
- Who gave the estimate, and have they built something comparable?
- Are we treating this as relative effort, or accidentally as a delivery date?

## Handling disagreement

Wide variance is signal, not noise. It usually means the team does not share an
understanding of the candidate's scope or risk, not that you should average the
numbers ([SessionLab](https://www.sessionlab.com/methods/rice-scoring-model)).

- Ask the extremes to explain their reasoning; the surfaced assumption is the real
  output of the session ([Learning Loop](https://learningloop.io/plays/workshop-exercise/rice-scoring)).
- If a gap persists, the item likely needs research before it can be scored. Park it.
- Visible scores self-police: when the whole room sees an outlier, unreasonable
  estimates get questioned ([Rock](https://www.rock.so/blog/rice-scoring)).
- Do not force false consensus on a near-tie. The script will flag it; let it ride
  as a tie and break it on strategy, dependency, or confidence.

## Hybrid mode note

In Hybrid, the agent pre-fills a draft (autonomous estimates with evidence flags,
Effort and strategic Impact marked NEEDS-HUMAN), then walks the human through the
question bank to confirm or adjust each number. The calibration step still happens
first: confirm the anchors before reviewing the draft, so the human is not anchored
to the agent's guesses.
