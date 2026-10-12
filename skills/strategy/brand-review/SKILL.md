---
name: brand-review
description: >-
  Design audit of finished marketing creative against the brand: landing pages, social
  graphics, email templates, ad creatives. Scores each asset 0 to 10 on seven dimensions,
  separates mechanical fixes from design judgment calls, and returns a scorecard plus a
  prioritized fix list. Use before publishing any visual asset, or on is this on-brand,
  audit this creative, or review this design before it goes out. Do NOT use for copy
  quality (use `seven-copy-critics`), for the campaign's strategy (use `campaign-brief`),
  to look up brand values while making an asset (use `get-brand-kit`), or to design or
  fix a product interface (use `design-expert`).
license: MIT
argument-hint: '[the asset, or where it lives]'
---

# Brand Review

A structured design audit that rates a finished marketing asset and turns the
ratings into a prioritized fix list before it is published.

**Core insight:** design review fails when "this button is the wrong colour"
(a mechanical fix) is mixed with "I am not sure about the overall aesthetic" (a
judgment call). Conflated, they produce feedback nobody can act on. This review
keeps them apart: mechanical fixes are non-negotiable, judgment calls need
discussion.

## When to use

- Before publishing a social graphic, ad creative or campaign visual.
- Before launching or updating a landing page.
- Reviewing an email template design.
- Evaluating a new brand direction or asset set.

## When not to use

- Copy and messaging: `seven-copy-critics` for the words, `campaign-brief` for
  the campaign behind them.
- A strategic decision about brand direction: `ceo-review`.
- A product interface: `design-expert`.
- A rough draft not yet ready for critique: say it is a draft and review it when
  it is ready.

## Where the brand comes from

Brand consistency is judged against stated brand values, never against your
sense of what looks right.

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`); if it is missing, suggest
the user run the `setup-aclarify-skills` skill. In order:

1. **The `Brand kit` folder named in `docs/agents/workspace.md`, when one is
   set.** With the setting at `none`, the default, skip this step. When the
   `get-brand-kit` skill is installed, load it (through your skill tool,
   `/get-brand-kit`, or by reading its SKILL.md) and it reads the folder;
   otherwise read the folder directly, using the file names `get-brand-kit`
   documents. Read the parts covering colour, typography, logos, layout and
   voice: `color-palette.md`, `typography.md`, `logos.md` (logo paths are
   relative to the folder), `visual-design-system.md` and `voice-and-tone.md`;
   a file the folder lacks is a dimension not yet defined. Use the values
   exactly.
2. **Otherwise, a brand guide the user names**, or one in the conventions folder
   named in `docs/agents/workspace.md` (default: none).
3. **Otherwise, `get-brand-kit`'s placeholder kit**, when that skill is
   installed: load it as above and, with no folder set, it serves its own kit.
   It is the last source before asking, and never outranks a brand guide the
   user names.
4. **With none of these,** ask the user for the brand guide or its core values:
   palette, typefaces, logo rules. Ask the user, using your structured-question
   tool if you have one; otherwise list the questions numbered in plain text
   and stop until they reply. If they would rather you proceed, score the other
   six dimensions and mark Brand Consistency **not checked: no brand source**.

If a brand file you read says `Status: placeholder`, tell the user that brand
consistency was checked against a placeholder, not their brand.

## Step 1: identify the asset

Look at the asset itself. Open an image file directly; render a page or
template if you can, at both desktop and mobile widths. If you cannot see it,
ask the user for a screenshot rather than reviewing from a description.

Then state:

- The asset type: social graphic, landing page, email, ad.
- Its destination platform.
- Its intended audience.
- The campaign or context it belongs to.

For a set (a three-post carousel, say), score each asset on its own, then add a
note on the set's coherence.

## Step 2: score seven dimensions, 0 to 10

Give each a score and a two to four sentence rationale. A 7 is not a gift and a
4 is not a punishment; the score reflects the actual quality.

| Score | Meaning |
|---|---|
| 9–10 | Exceptional: a reference example. |
| 7–8 | Strong: minor polish needed. |
| 5–6 | Acceptable: clear room to improve, specific fixes needed. |
| 3–4 | Weak: issues that will hurt performance. |
| 1–2 | Broken: fundamental problems to resolve before any use. |

1. **Visual hierarchy.** Is the eye drawn in the right order: headline, then the
   supporting point, then the call to action?
   - What does the eye land on first? Should it?
   - Is the headline dominant, or competing with the imagery?
   - Does the layout lead to the call to action, or must the viewer hunt?
2. **Brand consistency.** Do font, colour, imagery and voice match the brand
   source above?
   - Are the brand typefaces used?
   - Are the colours inside the palette, or are there off-brand additions?
   - Does the imagery match the established style?
   - Would someone who knows the brand recognize it at once?
3. **Message clarity.** Can the core value proposition be pulled out in under
   five seconds?
   - Cover the logo: can you still tell what it is for?
   - What does a first-time viewer take away in five seconds?
   - Is the benefit stated, or left to inference?
4. **Emotional resonance.** Does the design evoke the feeling the context calls
   for: professional, trustworthy, bold, warm?
   - What does the design communicate before any text is read?
   - Is that right for this audience and message?
   - Does the visual tone match the copy's tone?
5. **Call to action.** Is it specific, visible and compelling?
   - Is there one? With none, the score is 1 or 2.
   - Is it specific ("Book a 20-minute call", not "Learn more")?
   - Can a viewer find it without searching?
   - Does it match the asset's goal: awareness, conversion or nurture?
6. **Platform fit.** Do format, ratio and length suit where it will be seen?
   - Is the aspect ratio right for the placement (square or landscape feed,
     9:16 story)? Check the platform's current specification when unsure.
   - Is text legible at the size it renders, on mobile as well as desktop?
   - For email: does it hold up in clients that block images by default?
   - Would it show uncropped in a native feed?
7. **Distinctiveness.** Does it stand out, or could any competitor's logo
   replace this one?
   - What single element makes it unmistakably this brand's?
   - Swap in a competitor's logo: does it still feel like this brand?
   - Is there a choice here a competitor would not make? Should there be?

## Step 3: separate mechanical fixes from judgment calls

**Mechanical fixes** are objectively wrong and must be fixed before publishing.
No discussion needed. For example:

- A colour outside the brand palette (`#FF0000` where the palette says
  `#CC2200`).
- An off-brand typeface on the headline.
- Text illegible at mobile size, or failing a contrast check.
- The wrong aspect ratio for the platform.
- A missing call to action, or one hidden below the fold.

**Judgment calls** are choices that may be right depending on the strategy.
Discuss before changing. For example:

- The layout feels dense rather than airy: is that intended?
- The image choice is bold: does that match this campaign's tone?
- The headline is unconventional: a calculated risk, or an oversight?

List each category separately, with specific items.

## Step 4: scorecard and fix list

```markdown
## Brand review scorecard

| Dimension | Score | Notes |
|---|---|---|
| Visual hierarchy | X/10 | [one line] |
| Brand consistency | X/10 | [one line, or "not checked: no brand source"] |
| Message clarity | X/10 | [one line] |
| Emotional resonance | X/10 | [one line] |
| Call to action | X/10 | [one line] |
| Platform fit | X/10 | [one line] |
| Distinctiveness | X/10 | [one line] |
| **Overall** | X/10 | |

## Mechanical fixes (resolve before publishing)
1. [Fix]

## Design judgment calls (discuss before changing)
1. [Observation and question]

## Priority fix list (the three highest-impact changes)
1. [Fix, with expected impact]
2. [Fix, with expected impact]
3. [Fix, with expected impact]
```

The overall score is the mean of the dimensions scored; an unchecked dimension
is left out of it, and the scorecard says so.

- **7 or above:** publishable once the mechanical fixes are resolved.
- **5 to 6:** needs at least the three priority fixes before publishing.
- **Below 5:** back to production for significant rework.
