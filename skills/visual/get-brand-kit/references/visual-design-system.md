# Visual design system

> **Status: placeholder.** A quiet editorial default (one accent, cards on a
> lightly textured ground, generous space) so assets look composed before a
> brand is set. Rewrite it to describe how your own assets are composed, and
> change this line to `Status: defined`.

How the building blocks are composed into an asset: infographics, slide decks,
landing pages, email graphics, marketing cards, hero images. Colours come from
`color-palette.md`, faces from `typography.md`, marks from `logos.md`; this file
names their tokens and never repeats a value.

## Direction

| Question | Placeholder answer |
|---|---|
| What should an asset feel like? | An editorial publication: calm, precise, roomy. |
| Which design systems does it borrow from? | None named yet. Name two to four, and what each lends (card treatment, layout, polish). |
| What is it not? | A flat marketing poster: centred text on a solid colour, several bright hues, clip art. |

## Composition rules

### 1. Background

- **Ground:** `neutral-bg-warm`.
- **Texture:** a very subtle dot grid of `brand-primary` dots, evenly spaced, at
  no more than 5% opacity.
- **Vignette:** the centre of the canvas a touch brighter than the edges, to
  focus the eye on the central card.

### 2. Cards

Content sits in a card on the textured ground:

- **Border:** 1px `neutral-border`.
- **Corner radius:** 16px.
- **Shadow:** soft and layered, never hard, never pure black.
- **Fill:** `neutral-bg-warm`, or `pure-white` where the card must lift off a
  tinted ground.
- **Padding:** at least 8% of the card's width on every side.

### 3. Badges

Each card can carry a small pill badge, top left, naming what the card is:

- Pill shape, 1px `neutral-border`, `pure-white` fill.
- Tiny uppercase mono text in `brand-primary`, after a small filled
  `brand-primary` dot.
- Examples: `● RESULT`, `● DATA`, `● INSIGHT`.

### 4. Type hierarchy

Every composition uses at least three distinct type treatments, taken from the
hierarchy in `typography.md`: a display element, a headline, body, and mono
captions. One weight throughout is the poster look this system avoids.

### 5. Dividers

Thin 1px `neutral-divider` rules separate regions inside a card: hero from
headline, headline from list, body from caption. Never bold or thick.

### 6. Data marks

A numeric or comparative card earns a small, line-based mark in `brand-primary`:
a sparkline for a trend, a mini bar chart for a comparison, a ring for a
percentage, an outline icon (1.5 to 2px stroke) for a concept. Never filled,
multicoloured or 3D chart art.

### 7. Option rows

For polls and lists of choices: identical rounded rectangles (8px radius), 1px
`neutral-border`, subtle shadow, `pure-white` fill, a small `brand-primary` dot
on the left, the label in `brand-primary-dark`, a thin chevron on the right.

### 8. Spacing and grid

- At least 8% padding inside cards and 6% margin between card and canvas edge.
- Asymmetric layouts (text left, visual right) over centred slabs.
- A steady vertical rhythm: hero, divider, headline, divider, body, caption.
- Nothing touches a card's border.

## What to avoid

- Centred text on a flat colour with no card or texture.
- A single type weight throughout.
- Accent colours beyond the palette.
- Hard or black drop shadows.
- Filled, rainbow or 3D charts.
- Decorative illustration, clip art, stock icon sets.
- Missing captions or metadata where a source or date belongs.

## Reference assets

None pinned yet. Link the first asset made to this spec, and each one after it: a
visual anchor is what makes new work look like the same family rather than the
spec read twice.
