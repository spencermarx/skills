# Investigation output format

Read this when writing up the conclusion of an investigation.

Report the investigation so a reader can retrace and challenge your reasoning -
the value is in the traceable chain, not just the answer. Adapt length to the
problem, but keep this spine:

```markdown
## Investigation: [the symptom / question]

### Observed

[Verbatim facts - error text, actual vs. expected, conditions. Evidence only.]

### Reproduction

[How to make it fail on demand, minimally. Or: why it couldn't be reproduced.]

### Hypotheses considered

| #   | Hypothesis | Falsifier (what would disprove it) | Verdict + evidence    |
| --- | ---------- | ---------------------------------- | --------------------- |
| 1   | …          | …                                  | Ruled out - [obs]     |
| 2   | …          | …                                  | **Confirmed** - [obs] |

### Root cause

[The true defect at the origin of the chain - defect → infection → failure - distinguished from the symptoms it produced downstream.]

### Fix & proof

[The change, and how toggling it makes the failure appear/disappear.]

### Still assumed (not verified)

[Anything load-bearing that remains in the ASSUME column, so the reader knows the
edges of what's actually proven.]
```

In **mechanism mode**, keep the same spine but rename two headings so they fit a
"how does it work" answer: **Root cause → Mechanism** (the true model of how the
thing works), and **Fix & proof → How each claim is proven** (the source lines,
traces, or toggles that back each part of the model). "Reproduction" becomes the
trace that confirms the behavior. The point of the format is unchanged: a reader
can retrace and challenge every claim.
