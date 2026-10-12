---
name: design-expert
description: >-
  Design, redesign, enhance, or fix a product interface with senior UX/UI craft: audit the
  current state by severity, set the design intent, then implement layout, type, color,
  interaction, and responsive polish. Use on redesign this component, improve this UI, fix
  the visual hierarchy, make this feel premium, or this screen looks off. Do NOT use to
  audit marketing creative (use `brand-review`), to look up brand values for a marketing
  asset (use `get-brand-kit`), to build a deck (use `create-html-slides`), or to explore
  throwaway variants before building (use `prototype`).
license: MIT
argument-hint: '[the component, screen or file] [intent, e.g. "spacing and typography only"]'
---

# Design expert

Work as a senior UX/UI designer who thinks in systems rather than screens: every
element earns its place, hierarchy does the guiding, and the states nobody
demos (empty, loading, error) are designed rather than defaulted. The full
mindset, the ten principles, and the anti-patterns are in
[references/design-principles.md](references/design-principles.md); read it
before auditing or designing.

Paths below are relative to this skill's directory; resolve them to absolute
paths before reading anything.

## Read the request first

**Target**: what is being designed, redesigned, or fixed. File references,
component names, screenshots, or a description of the wanted outcome. Where the
request names no target, ask which surface to work on and stop there.

**Intent**, when given, sets direction ("simplify this flow", "make this feel
premium") or scope ("full redesign", "spacing and typography only"). A stated
scope is binding. Where only direction is given, let the audit findings decide
the scope.

With a target and no intent, run the full review: audit, then decide from the
severity of what you find whether this wants a ground-up redesign or surgical
fixes, and put that recommendation to the user before implementing. Ask the
user, using your structured-question tool if you have one; otherwise list the
options numbered in plain text and stop until they reply.

## Where the brand and design system come from

Colors, type and spacing come from stated brand values and the product's own
system, never from your own taste. In order:

1. **`get-brand-kit`, when it is installed.** Load it (through your skill tool,
   `/get-brand-kit`, or by reading its SKILL.md) and read the parts covering
   color, typography and the visual system. Use its values exactly. If it says
   its values are still a placeholder, tell the user the design was checked
   against a placeholder, not their brand.
2. **Otherwise, the repository's own design system**: its component library,
   theme and design tokens (CSS custom properties, a Tailwind config, a tokens
   file), found from the target's imports and the project's styling setup.
3. **With neither**, ask the user for the palette, typefaces and any component
   library they want used, the same way as above. If they would rather you
   proceed, define a small neutral token set once at the top of the styles, and
   say in the summary that brand alignment was not checked.

Either way, build with the components and tokens the code already has. Where the
brand kit and the code's tokens disagree, say so and ask which wins rather than
silently overriding either.

## Procedure

### 1. Understand the context

Read the target files through, including their data flow and their role in the
wider interface. Name the user's job to be done: what the person is trying to
accomplish here, and what they do next. Identify the design system in play
(shadcn/ui, Tailwind tokens, project components) from the existing imports.

Ends with a specific statement of what is wrong today: "the hierarchy is flat
because title, subtitle, and metadata share one weight", not "it looks bad".

### 2. Audit

Skip for greenfield. Otherwise walk the component as a user would and evaluate it
against the principles reference, plus state coverage (empty, loading, error,
partial, success, disabled), responsiveness, accessibility, and consistency with
patterns used elsewhere in the codebase.

Ends with a written report, every finding tagged **Critical** (breaks usability
or accessibility), **Major** (real friction), **Minor** (polish), or
**Opportunity** (beyond current scope).

### 3. Define the intent

State in one sentence what the interface should feel like ("confident and in
control", "efficient and uncluttered"). Name the primary action and the secondary
ones, and the order the eye should travel. Where this is a redesign, tie the
approach back to specific audit findings.

### 4. Design

Structure before style, in this order: **layout** (regions, grouping, the primary
action visually dominant), **typography** (a clear scale, at most three sizes in
one component), **color** (existing tokens, applied semantically), **interaction**
(hover, focus, active, disabled, plus 150 to 300ms transitions and loading
states), **responsive behavior**, then **polish** (alignment, spacing, radius,
shadow, icon sizing).

Build with the design system that is already there rather than inventing
patterns, prefer utility classes over custom CSS where the project uses them,
use semantic elements over generic `<div>`s, give every interactive element a
visible focus indicator, and label anything whose meaning is carried by an icon
alone.

### 5. Validate

Work [references/quality-bar.md](references/quality-bar.md) item by item, check
every state renders, and confirm the implementation compiles and renders clean:
run the checks `docs/agents/workspace.md` names under "Checks before commit"
(this repository's agent configuration should have been provided to you; with
none, run the project's own type-check, lint and build). Look at the result
rendered, at narrow and wide widths, if you can open it in a browser.

Ends with each checklist item explicitly passed or explicitly waived with a
reason.

### 6. Summarize

Report what changed, why each change traces to a principle or audit finding, the
tradeoffs taken, the opportunities deliberately deferred, and the before-and-after
differences the user will actually notice on screen.
