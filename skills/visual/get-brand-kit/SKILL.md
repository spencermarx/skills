---
name: get-brand-kit
description: >-
  Look up a brand value BEFORE making anything that must look or sound on-brand: a slide,
  an image prompt, an infographic, a social asset, a landing page, an email graphic. The
  repository's single source of truth for colours, typography, logos, the visual design
  system and voice; other skills load it by name. Ships a placeholder brand to replace with
  your own. Do NOT use to review copy (use `seven-copy-critics`), to audit a finished asset
  (use `brand-review`), or to redesign a product interface (use `design-expert`, which
  loads this for its values).
license: MIT
---

# get-brand-kit

The one place a repository's brand values live. Every skill, prompt and template
that needs a colour, a typeface, a logo, a layout rule or the voice reads it from
here at the moment of need, rather than holding its own copy.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Why it exists

Brand values change. When they do, one file should change and every consumer
should pick up the new value. The failure this prevents is concrete: a retired
hex survives a rebrand because it was copied into image prompts, guidelines and
templates "for convenience". Each copy looks correct in isolation, and finding
them all takes longer than the rebrand did.

## Where the brand kit lives

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
default below and suggest the user run the `setup-aclarify-skills` skill.

1. **A configured brand folder wins.** If `docs/agents/workspace.md` has a
   `**Brand kit:**` line naming a folder (for example `brand/` inside the
   conventions folder), read the brand from there and ignore this skill's own
   reference files. The folder uses the same file names as `references/` below,
   and its `logos.md` gives logo paths relative to that folder.
2. **Otherwise, this skill's own files** are the brand kit: `references/` and
   `assets/`. A user makes them theirs by forking or editing them in place.

A configured folder is taken whole. If it lacks a dimension (say, no
`voice-and-tone.md`), that dimension is not yet defined: never fill it from this
skill's placeholder files.

## The placeholder brand

As shipped, every reference file opens with **`Status: placeholder`**. The values
are a neutral slate and the logos are a generic wordmark reading "YOUR BRAND", so
a deck or card made before anyone sets a brand looks deliberate rather than
broken, and never carries someone else's identity.

When a file you read is still a placeholder, use its values, and tell the user
in your reply that the asset uses placeholder brand values, not theirs. Never
present placeholder values as the user's brand.

## How to use it

1. Find where the kit lives (above).
2. Identify the dimension you need and read only that file.
3. Use the values exactly. Do not paraphrase, derive, or interpolate a value.
4. If a value is not documented, stop and ask the user. Do not guess. Once they
   give it, add it to the kit first, then use it.

| File | Read it when you need |
|---|---|
| [references/color-palette.md](references/color-palette.md) | any colour: backgrounds, text, accents, borders, data marks |
| [references/typography.md](references/typography.md) | a typeface, weight, type scale or web-font source |
| [references/logos.md](references/logos.md) | a logo file, or the choice between light and dark variants |
| [references/visual-design-system.md](references/visual-design-system.md) | to compose an asset: background, cards, badges, hierarchy, data marks, spacing |
| [references/voice-and-tone.md](references/voice-and-tone.md) | to write or align copy to the brand voice |

## Replacing the placeholder with your brand

Pick where your kit will live:

- **Edit this skill in place**, when it is installed as files you own (a fork, or
  a copy in the repository). Simplest, and nothing else needs configuring.
- **Keep it in a repository folder**, when this skill is installed somewhere an
  update would overwrite (a plugin or a shared install), or when the brand should
  sit with the repository's other conventions. Copy `references/` and `assets/`
  into the folder, then add one line to `docs/agents/workspace.md`:
  `- **Brand kit:** \`docs/standards/brand/\`` (your path).

Then, in whichever copy is the kit:

1. **Colours.** Replace the hex values in `color-palette.md`. Keep the token
   names: consumers reference tokens, not hexes.
2. **Typography.** Name your faces, weights, scale and where the web fonts load
   from in `typography.md`.
3. **Logos.** Replace the two SVGs and keep their file names, so nothing that
   points at them changes. Add a variant only as a new file listed in `logos.md`.
4. **Visual design system.** Rewrite `visual-design-system.md` to describe how
   your assets are composed. Name tokens from the palette, never hexes.
5. **Voice.** Fill `voice-and-tone.md` from your real brand voice, with example
   sentences.
6. **Flip each file's status** from `Status: placeholder` to `Status: defined` as
   you finish it, so consumers stop warning about it.
7. **Grep for the values you retired** across the whole repository (see the last
   rule in `color-palette.md`) and update every copy you find.

## Rules for every consumer

1. **Never hardcode a brand value in another skill, template or note.** Name the
   token and read this kit when you need it.
2. **Never invent one.** If it is not documented, the answer is "not yet
   defined". Raise it rather than fabricating.
3. **Change the kit, not a local copy.** When the brand evolves, it evolves here.
4. **Renaming or removing a value is a brand-level change.** Update every
   consumer in the same change.
