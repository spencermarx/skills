# DRICE deep dive

The second stage of a two-stage prioritization, Lenny Rachitsky's DRICE
(Detailed RICE): turn a 30-second estimate into a 30-minute one. Plain RICE
ranks the whole backlog with rough relative scores. DRICE takes only the top
three to five that survived and replaces the rough numbers with detailed
estimates worth defending: an expected outcome in the goal's absolute units
(usually annualized revenue), an explicit hypothesis per item, and a refined
effort breakdown. Teams applying it reported moving their key metric roughly
twice as much as with standard RICE alone
([Lenny Rachitsky](https://www.lennysnewsletter.com/p/introducing-drice-a-modern-prioritization)).

Run it only on a shortlist. The detailed estimate is expensive, so spend it only
where the ranking is close or the stakes are high. With no shortlist yet, run
the main RICE procedure first.

## When to use

- The main procedure produced a top three to five and the order matters enough
  to model deeper.
- Two or more top candidates are a near-tie and the cheap scores cannot separate
  them.
- A high-stakes bet needs a number someone can defend, not a relative score.

## Step 1: take the shortlist

Start from the RICE output: the top three to five items and their rough scores.
Confirm the round's goal and time window carry over unchanged, so the detailed
numbers stay comparable to the first pass.

## Step 2: replace Reach x Impact with an absolute outcome

For each item, move from relative scoring to an absolute expected outcome in the
goal's units, usually expected annualized revenue or the round's metric:

- State the **hypothesis** explicitly: "we believe X will change Y by Z
  because ...".
- Build the number bottom-up: reach in the window x expected per-user effect x
  value. Show the arithmetic.
- Keep the same basis (segment, weighting) across every shortlisted item.

This collapses the rough Reach and Impact tiers into one modelled expected value
per item. Confidence still discounts it; Effort still divides it.

## Step 3: refine Confidence and Effort with the owners

- **Confidence:** re-derive it from the strength of the hypothesis and the
  evidence behind the expected value, not from the first-pass tier. Tie it to
  specific evidence.
- **Effort:** get a refined breakdown from the people who will build it, across
  all disciplines, with the known unknowns named. This stays `NEEDS-HUMAN` in
  autonomous use; do not assign it yourself.

## Step 4: recompute and compare with the rough pass

Write the refined numbers to `shortlist.json` in the round's output folder and
run them through the same calculator (DRICE keeps the RICE arithmetic; only the
inputs got more detailed):

```bash
python3 <skill dir>/scripts/rice_score.py <output folder>/shortlist.json
```

Carry the expected outcome in absolute units as a passthrough field beside the
score. Then compare the detailed ranking with the rough one: if the order
changed, say why. That change is the value of running DRICE.

## Step 5: write the artifact

Write `01-drice-deep-dive.md` in the same output folder as the RICE summary.
Include per item: the hypothesis, the bottom-up expected outcome with its
arithmetic, the refined Confidence (with evidence) and Effort (with breakdown),
the recomputed score, and how the detailed ranking differs from the rough pass.
End with a **Decision required** block: the detailed recommendation and the
decision owed. Apply the same house rules as the summary.
