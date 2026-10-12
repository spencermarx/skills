# Color palette

> **Status: placeholder.** A neutral slate chosen so assets look composed before
> a brand is set. Replace the hex values with your own, keep the token names, and
> change this line to `Status: defined`.

The single source of truth for every colour value. Anything using a brand colour
names one of these tokens rather than repeating a hex.

## Primary

| Token | Hex | Use |
|---|---|---|
| `brand-primary` | `#2F4858` | The single primary accent. Headlines, hero numbers, primary buttons, key chart elements, the logo. |

## The monochromatic scale

Built from `brand-primary`: one hue, five values. A second hue is a decision to
make once, in this file, not an improvisation inside an asset.

| Token | Hex | Use |
|---|---|---|
| `brand-primary` | `#2F4858` | Primary accent |
| `brand-primary-dark` | `#17242C` | Headings and body text on light grounds, deep contrast |
| `brand-primary-mid` | `#4A6B7C` | Secondary accents, hover states, a second chart series |
| `brand-primary-light` | `#8FA3AD` | Captions, source attributions, metadata, gridlines |
| `brand-primary-tint` | `#E7EDF0` | Backgrounds, callout fills, subtle blocks |

## Neutrals

| Token | Hex | Use |
|---|---|---|
| `neutral-bg-warm` | `#F8F6F2` | Default background for editorial layouts, infographics and slides. Preferred over pure white. |
| `neutral-bg-cool` | `#F5F7FA` | Background for technical or product contexts |
| `neutral-ink` | `#1A1A1A` | Body text when `brand-primary-dark` reads too tinted |
| `neutral-border` | `#C9D0DD` | Card borders, table rules, badge and option outlines |
| `neutral-divider` | `#E0E4EC` | Thin dividers inside a card |
| `pure-white` | `#FFFFFF` | Product UI mockups, and the fill of small badges and option rows |
| `pure-black` | `#000000` | High-contrast logo lockups only |

## Rules

1. **Use only values from this file.** If a chart needs a second series, use
   `brand-primary-mid` or `brand-primary-light`, never a contrasting hue.
2. **The primary appears in every asset.** It is what makes a set look like a
   set.
3. **Never write a hex inline in another skill or template.** Name the token. A
   consumer that needs the value reads this file at the moment of need.
4. **The default background is `neutral-bg-warm`, not pure white.** Pure white
   reads cold in print and on social, and is reserved for product UI.
5. **When you replace a value, replace it here, then grep the retired value
   across the whole repository.** A stale hex hides in a stylesheet, a JSON
   diagram or a note as readily as in prose:

   ```bash
   git grep -n -i -e '#2F4858' -e '#F5F7FA'
   ```

   Substitute the values you retired. `git grep` searches tracked files only, so
   copies in ignored folders and worktrees drop out without an exclude list.
   Grep the repository root, never one folder: templates and stylesheets sit
   outside the folders that hold prose.

   Count files, not hits, and sort them. Two kinds are expected and stay: a
   rendered asset (the logo SVGs) and a stylesheet that materialises the tokens
   as CSS custom properties, because a stylesheet cannot read this file when it
   is used. Everything else is a copy to replace with the token's name.

   Grep the retired value, never a bare `#`: that matches every markdown heading
   and proves nothing.
