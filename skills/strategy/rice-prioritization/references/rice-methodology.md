# RICE Methodology Reference

The canonical definitions, scales, formula, worked examples, pitfalls, and
variants behind the `rice-prioritization` skill. Load this when scoring so the
scale values are exact. Encode the numbers here verbatim. Do not improvise a
scale.

RICE was created by Sean McBride on Intercom's growth team to strip gut feeling
out of comparing project ideas against a single goal ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/)).

## The formula

```
RICE score = (Reach x Impact x Confidence) / Effort
```

The result is a dimensionless, comparative number. It means roughly "total
impact per unit of work." Only ever compare scores within the same round, never
across rounds or against an absolute threshold ([Savio](https://www.savio.io/product-roadmap/rice-scoring-model/)).

## The four factors and their exact scales

### Reach

How many people or accounts the initiative affects within ONE fixed time window
chosen once for the whole round (for example, customers per quarter). Use an
absolute count from a defined data source, and record the source next to the
number ([ProductPlan](https://www.productplan.com/glossary/rice-scoring-model), [Rock](https://www.rock.so/blog/rice-scoring)).

Reach can be revenue-weighted or segment-qualified when the segments differ in
value (1,000 enterprise accounts is not 10,000 free users) ([Product Coalition](https://www.productcoalition.com/p/mastering-rice-prioritization-a-no)).
If you do that, apply the same basis to every candidate.

Intercom's own reach example: 500 customers hit a funnel step each month and 30%
choose an option, so quarterly reach = 500 x 30% x 3 = 450 ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/)).

### Impact (exact multipliers)

A discrete multiplier, not a free number. Use these values exactly ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/), [ProductPlan](https://www.productplan.com/glossary/rice-scoring-model)):

| Tier | Multiplier |
|---|---|
| Massive | 3 |
| High | 2 |
| Medium | 1 |
| Low | 0.5 |
| Minimal | 0.25 |

Impact is per affected user, relative to the round's goal. It is subjective, so
anchor it against known shipped features before scoring (see calibration below).
The script rejects any impact value off this scale.

### Confidence (exact percentages)

A percentage that discounts the score for uncertainty in your reach, impact, and
effort estimates ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/)):

| Tier | Confidence |
|---|---|
| High (solid data / proven pattern) | 100% |
| Medium (some data, reasonable assumptions) | 80% |
| Low (educated guess, untested) | 50% |
| Below 50% | "moonshot": flag it, do not silently bury it in the math |

Confidence must map to the evidence tier, not to optimism. Assigning 80-100% to
a gut estimate corrupts the framework; that is the single most common abuse ([SaaS Funnel Lab](https://www.saasfunnellab.com/essay/rice-scoring-prioritization-framework/), [Rock](https://www.rock.so/blog/rice-scoring)).

### Effort

Total person-months across ALL disciplines (product, design, engineering, QA,
and anything else needed), not engineering alone. Whole numbers, or 0.5 for
sub-month work ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/), [SaaS Funnel Lab](https://www.saasfunnellab.com/essay/rice-scoring-prioritization-framework/)).

Worked: 1 week product + 1 week design + 2 weeks engineering = ~1 person-month =
effort 1. Ask the people who will do the work; add a buffer for discovery,
testing, and launch; treat effort as relative within the round, not a delivery
estimate ([SaaS Funnel Lab](https://www.saasfunnellab.com/essay/rice-scoring-prioritization-framework/), [Rock](https://www.rock.so/blog/rice-scoring)).

## Worked examples (script regression anchors)

### Example 1: MRR-weighted reach (Savio)

Reach is monthly recurring revenue touched. Confidence as a percentage.

| Feature | Reach | Impact | Confidence | Effort | Score |
|---|---|---|---|---|---|
| Permissions & Roles | 1,600 | 2 | 100% | 60 | 53.33 |
| Zapier Integration | 4,250 | 0.5 | 80% | 40 | 42.50 |
| Streak CRM Integration | 750 | 1 | 50% | 30 | 12.50 |

Ranking: Permissions & Roles > Zapier > Streak ([Savio](https://www.savio.io/product-roadmap/rice-scoring-model/)).
`rice_score.py` reproduces these exactly.

### Example 2: count-based reach (Whatfix / Avion)

`(1,500 reach x 2 impact x 0.50 confidence) / 2 effort = 750` ([Whatfix](https://www.whatfix.com/blog/rice-scoring-model/)).

Avion's two-feature comparison shows reach dominating confidence: a checkout
improvement (7,000 x 2 x 40% / 4 = 1,400) outranks a referral program
(4,000 x 1 x 60% / 2 = 1,200) despite lower confidence ([Avion](https://www.avion.io/blog/rice-prioritization/)).

## Pitfalls (design the output to resist these)

1. **False precision.** RICE is relative, not exact. Treat scores within ~15% of each other as a tie, not a decision; do not defend 1,300 vs 1,250 ([Rock](https://www.rock.so/blog/rice-scoring), [SaaS Funnel Lab](https://www.saasfunnellab.com/essay/rice-scoring-prioritization-framework/)). The script flags these.
2. **Reach manipulation.** Reach is the easiest number to fudge by picking a favorable analytics view. Lock one time window for the round, source each number from a defined report, write the source down ([Rock](https://www.rock.so/blog/rice-scoring)).
3. **Confidence as optimism.** A 20-point confidence shift can flip the top of a ranking. Tie confidence to evidence, and surface low-confidence items as "validate before committing," not "discard" ([Rock](https://www.rock.so/blog/rice-scoring), [howtoes](https://howtoes.blog/2025/07/01/rice-scoring-complete-guide-to-prioritizing-initiatives-for-strategic-product-development/)).
4. **Effort underestimation.** Counting dev-only, or assuming effort scales linearly with headcount, inflates scores. Count every discipline; buffer ([Rock](https://www.rock.so/blog/rice-scoring), [howtoes](https://howtoes.blog/2025/07/01/rice-scoring-complete-guide-to-prioritizing-initiatives-for-strategic-product-development/)).
5. **Blind adherence.** A high score does not green-light a project that fails the strategy. RICE is an input to the decision, not the decision. Dependencies, table stakes, and strategic bets can override the ranking ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/), [Product Coalition](https://www.productcoalition.com/p/mastering-rice-prioritization-a-no)).
6. **Planning-fallacy red flag.** If most candidates land at high reach, high impact, 80-100% confidence, and low effort, the scoring is inflated. Recalibrate ([howtoes](https://howtoes.blog/2025/07/01/rice-scoring-complete-guide-to-prioritizing-initiatives-for-strategic-product-development/)).

## When RICE is NOT the right tool

- Foundational/technical-debt/market-timing work that always scores low and gets perpetually cut. Carve it out or use a strategic lane ([Rock](https://www.rock.so/blog/rice-scoring)).
- Very early, coarse decisions where Value vs Complexity is enough ([Dovetail](https://www.dovetail.com/product-development/rice-scoring-model/)).
- Satisfaction-driven trade-offs better served by Kano, or hard-deadline triage better served by MoSCoW ([Dovetail](https://www.dovetail.com/product-development/rice-scoring-model/)).
- A single go/no-go (not a ranked list). Use `strategic-brief` for that.

## Variants (know them, default to plain RICE)

| Variant | Formula / change | Prefer when |
|---|---|---|
| ICE | Impact x Confidence x Ease (no reach) | Fast growth experiments where user count does not vary much ([Kaizenko](https://www.kaizenko.com/scoring-frameworks-ice-rice-and-weighted-scoring-for-product-prioritization/)) |
| WSJF | Cost of Delay / Job Size | Enterprise/SAFe contexts emphasizing urgency and economic value ([Product Blueprint](https://product-blueprint.com/rice-vs-wsjf/)) |
| Kano | Categorize features by satisfaction (basic / performance / delighter) | Satisfaction trade-offs, not effort ranking ([Dovetail](https://www.dovetail.com/product-development/rice-scoring-model/)) |
| Weighted RICE | Add exponents/weights to a factor (e.g. Impact^2) | Only with clear evidence one dimension matters more. Start unweighted ([Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/)) |
| DRICE | Two-stage: rough RICE to shortlist, then detailed `$X annualized revenue` on the top 3-5 | High-stakes top candidates worth a 30-minute estimate. See `drice-deep-dive.md` ([Lenny](https://www.lennysnewsletter.com/p/introducing-drice-a-modern-prioritization)) |

## Agent boundaries (autonomous mode)

What an agent may draft vs what a human must own ([ideaplan](https://www.ideaplan.io/blog/using-ai-to-score-rice-prioritization)):

- **Reach.** Agent may estimate from analytics/funnel data; must cite the source and never invent a number when no data exists.
- **Confidence.** Agent may structure the evidence tier (strong/moderate/weak), but flag it as a classification, not a guarantee.
- **Impact (strategic).** Gate to a human. Strategic impact depends on goals an LLM does not hold.
- **Effort.** Gate to a human. Depends on the codebase, debt, and team an LLM cannot see.
- **Final commitment.** Always human. RICE gives better numbers to argue about; it does not remove the argument.
