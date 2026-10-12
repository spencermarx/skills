---
name: seven-copy-critics
description: >-
  Adversarial copy review that stress-tests marketing copy through seven hostile reader
  personas plus a byline-voice check, each at three failure layers. Catches weak hooks,
  generic phrasing, unsubstantiated claims, and abstraction. Produces a failure report and
  a tightened rebuild. Use before sending cold email, publishing a page, or scheduling a
  post. Reviews drafts only: never use it to write copy. Drafting an essay or post is
  `draft-argued-piece`, a cold email or landing page `draft-conversion-copy`; reviewing
  either is here. `humanize` strips AI tells first. Do NOT use to review a whole campaign
  brief (use `campaign-brief`) or visual creative (use `brand-review`).
license: MIT
argument-hint: '[the draft, or a path to it]'
---

# Seven Copy Critics

An adversarial pre-publication review that runs marketing copy through seven
hostile reader personas, plus an eighth critic that checks whether a person's
voice survived, each attacking the draft at three failure layers: 24 checks. The
author of a piece of copy is the worst person to review it: they know the
context, they are already bought in, and they cannot see what a cold reader
sees. This skill simulates seven cold readers having seven bad days, and one who
has read too many ghost-written posts.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`): house rules. Default:
  none. If one is configured and holds a voice, tone, brand-voice or
  writing-standards document, read it before the rebuild and obey it; where it
  is stricter or more specific than this skill, it wins. With none, the rebuild
  follows the [House style constraints](#house-style-constraints) below and adds
  no house style of its own.

## When to use

- Before sending any cold outbound email or sequence
- Before publishing a landing page, ad, or newsletter
- Before scheduling any organic social post that matters (especially a personal
  post under someone's name)
- Before publishing a blog post
- When copy "feels right" but is not converting
- After `humanize` has cleared the AI tells from a draft, on the rewritten copy.
  A draft that still reads templated goes there first: that skill owns the
  tells, this one owns whether the copy converts

## When not to use

- To draft the piece: a piece carrying an argument is built by
  `draft-argued-piece`, and conversion copy by `draft-conversion-copy`, then
  reviewed here
- To inventory AI tells: `humanize` owns the tell taxonomy and measures it, and
  runs before this skill
- On copy that is already converting: do not fix what is not broken
- For pre-launch strategic review of an entire campaign brief: use
  `campaign-brief` instead
- For visual or design review of marketing assets: use `brand-review` instead
- For one-off internal messages with no audience consequence

Where a skill named here is not installed, say so and carry on without it.

---

## Procedure

### Step 1: gather context

Before running the critics, collect:

1. **The draft copy** (full text, exactly as it would be sent)
2. **The target audience** (specific persona, role, situation, not "marketers"
   or "operators")
3. **The channel and format** (cold email, social post, landing page hero, blog
   intro, etc.)
4. **The desired action** (reply, click, book a call, share, subscribe)

If any of these are missing, ask the user for them before proceeding, using your
structured-question tool if you have one; otherwise list the missing points
numbered in plain text and stop until they reply. A review without audience
context produces generic feedback.

---

### Step 2: run all eight critics across all three failure layers

The full matrix is in [references/critic-matrix.md](references/critic-matrix.md).
Load it now and work through it: eight critics, each applied at the hook, the
body, and the close.

Run every check. A critic that finds nothing is a finding in itself, and
skipping one because the copy "obviously passes" is how the failure this
skill exists to catch survives review.

### Step 3: compile the failure report

Categorize every failure surfaced in Step 2 by severity. Use this exact format:

```markdown
## FAILURE REPORT

### CRITICAL: [n] failures
(blocks the desired action; copy cannot ship as-is)
- [Critic #] [Layer]: [one-line description]
- ...

### HIGH PRIORITY: [n] failures
(meaningfully weakens the copy; should be fixed before publishing)
- ...

### LOW: [n] failures
(minor polish; address if cheap, otherwise note and move on)
- ...
```

**Severity rules:**
- **CRITICAL:** Any First Impression failure on Critic 1 (Time-Crushed) or
  Critic 4 (AI-Allergic). Any Action layer failure on the dominant target
  persona. Any Trust failure on Critic 3 (Burned Skeptic) when the copy makes
  a quantitative claim.
- **HIGH PRIORITY:** Any failure on a layer that directly opposes the desired
  action (e.g., Visual Reader failures on a story-driven post).
- **LOW:** Cosmetic patterns, minor word choice, second-order trust dings.

---

### Step 4: rebuild

Rewrite the draft addressing every CRITICAL and HIGH PRIORITY failure. The
rebuild standard is **tighter, not bigger. Sharper, not different.**

If the rebuild reads like a different person wrote it, the review failed.
The rebuild must:

1. Preserve the author's voice and core message
2. Fix root causes, not just symptoms
3. Not introduce new failures across other critics (re-check mentally)
4. Be the same length or shorter than the original
5. Comply with the [House style constraints](#house-style-constraints) below and
   with the conventions folder's house rules, where one is configured
6. Invent nothing: no number, name, result or quotation the draft or the user
   did not supply. Where a fix needs a specific the draft lacks, mark the gap
   and ask the user for it

Output the full rebuilt copy in a fenced block, ready to copy-paste.

---

### Step 5: validation pass

Before declaring done, mentally walk all eight critics through the rebuilt
version one more time. For each critic, write a single line:

```markdown
## VALIDATION PASS
1. Time-Crushed: PASS / FAIL: [one-line reason]
2. Self-Conscious: PASS / FAIL: [one-line reason]
3. Burned Skeptic: PASS / FAIL: [one-line reason]
4. AI-Allergic: PASS / FAIL: [one-line reason]
5. Lurker: PASS / FAIL: [one-line reason]
6. Visual Reader: PASS / FAIL: [one-line reason]
7. Inspiration Seeker: PASS / FAIL: [one-line reason]
8. Operator-Voice Detector: PASS / FAIL: [one-line reason]
```

If any critic still fails, return to Step 4 and rebuild again. **Do not ship
copy with any remaining CRITICAL failure.** A maximum of 2 rebuild rounds: if
the third pass still fails, the underlying message itself is wrong and the copy
needs to be rethought from the audience or offer angle, not rewritten.

---

### Step 6: changelog

End the review with a "What Changed" section explaining each meaningful edit
and which critic's failure it addressed:

```markdown
## WHAT CHANGED
- [Original phrase] → [new phrase]: fixes Critic [#] [Layer]
- ...
```

This is non-negotiable. The author needs to see the fixes mapped to root causes
so the same patterns do not reappear in the next draft.

---

## Output template

In [references/output-template.md](references/output-template.md). Load it
before writing the report.

## House style constraints

The rebuilt copy obeys the conventions folder's house rules where one is
configured (see [Configuration](#configuration)). On top of them, this review
adds constraints of its own:

- **No recapping the recipient's own business** in follow-up emails. Reference
  shared ideas or next steps instead.
- **No parroting call notes.** Focus on what is next, not what was said.
- **Dream outcome leads, mechanism explains.** Lead with what the customer
  gets (more bookings, less churn), not how the product works.
- **Literal-first imagery.** If the copy references visuals, they must depict
  specific moments from the post content, not abstract metaphors.
- **Author conviction required.** If the draft goes out under a person's own
  name, the rebuilt copy must contain at least one sentence expressing a belief,
  opinion, or conviction that person holds. Take it from the draft or ask them
  for it; never supply one. Information-only posts that never take a position
  fail the validation pass regardless of how the other critics score it.

A rebuild that violates any of these is an automatic FAIL on the validation
pass, regardless of how the critics score it.

---

## Key principle

> If the rebuilt version reads like a different person wrote it, the review
> failed. Tighter, not bigger. Sharper, not different.

The goal is not a "better" version of the copy in the abstract. The goal is
the same author's same message, stripped of the failure modes a cold reader
would catch. Voice preservation is a hard constraint, not a nice-to-have.
