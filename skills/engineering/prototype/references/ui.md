# UI prototype

Generate **several radically different UI variations**, switchable from a floating
bottom bar. The user flips between variants in the browser, picks one (or steals
bits from each), and the rest are archived.

If the question is about logic or state rather than what something looks like,
take the logic branch (`references/logic.md`) instead.

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague
  mockups in their head.

## The fidelity ladder: prefer real over contrived

A UI prototype is only honest when it's **butting up against the rest of the
app**: real header, real sidebar, real data, real density. A throwaway route on
its own is a vacuum where every variant looks fine. Climb down this ladder only as
far as fidelity costs more than it teaches.

### Rung 1: on an existing page of the running app (preferred)

The route already exists. Variants render **on the same route**, gated by a
`?variant=` URL search param. The existing data fetching, params, and auth all
stay; only the rendering swaps.

If the prototype is for something that doesn't yet have a page but _would
naturally live inside one_ (a new section of the dashboard, a new card on the
settings screen, a new step in an existing flow), it still belongs here. Mount
the variants inside the host page.

### Rung 2: a new throwaway route, or real primitives in the workshop

Use this only when nothing existing can host it:

- **A new top-level surface**, or a flow that can't be embedded anywhere
  sensible: create a **throwaway route** in the app, following the routing
  convention the project already uses, named so it's obviously a prototype
  (`prototype` in the path or filename). Same `?variant=` pattern.
- **A component or composition itself**: if the project has a component workshop
  (Storybook, Ladle, Histoire, or the like), build a prototype story there that
  composes the project's **real** primitives and tokens. The workshop is dev-only
  by nature, so it needs no production gate.

Before settling on rung 2, check again that no existing page could host it. An
empty route hides design problems that a populated one would expose.

### Rung 3: a contrived story or raw HTML (last resort)

A story with faked-up context, or a single raw-HTML file in the scratch folder.
Fastest and lowest fidelity: use it only when standing the prototype against real
components would cost far more than the answer is worth, and **say so at the top**
of the prototype.

## Process

### 1. State the question, pick the rung, pick N

Default to **3 variants**, capped at 5: past that they stop being radically
different and start being noise.

Write the plan in one line, in the prototype's location or a top-of-file comment,
with any assumption you made in picking the branch or the rung:

> "Three variants of the settings page, switchable via `?variant=`, on the
> existing `/settings` route (rung 1)."

This works whether the user is here to push back or not.

### 2. Generate radically different variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The project's component library or styling system (Tailwind, shadcn, MUI,
  plain CSS, whatever it uses).
- A clear exported component name, e.g. `VariantA`, `VariantB`, `VariantC`.

Variants must be **structurally different**: different layout, different
information hierarchy, different primary affordance. Colour alone is not a
variant; three slightly-tweaked card grids is wallpaper, not a UI prototype. If
two drafts come out too similar, redo one with a layout other than a card grid.

Keep variants **read-only**: point them at stubbed or real _read_ data, never real
mutations.

### 3. Wire them together

Create a single switcher on the route that reads the variant key (`?variant=`, or
a story arg or control in the workshop) and defaults to the first:

```tsx
// pseudo-code, adapt to the project's framework
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A','B','C']} current={variant} />
  </>
);
```

On rung 1, keep all the existing data fetching above the switcher; only the
rendered subtree changes per variant. On a rung 2 route, the throwaway route
mounts the same switcher.

### 4. Build the floating switcher

A small fixed-position bar at the bottom-centre of the screen with three pieces:

- **Left arrow**: cycles to the previous variant (wraps around).
- **Variant label**: shows the current variant key **and** what the variant is,
  e.g. `B (sidebar layout)`.
- **Right arrow**: cycles forward (wraps around).

Behaviour:

- Clicking an arrow updates the URL search param through the framework's router
  (`router.replace` on Next, `navigate` on React Router, and so on) so the variant
  is shareable and reload-stable.
- The `←` and `→` keys also cycle, except while an `<input>`, `<textarea>`, or
  `[contenteditable]` has focus (typing would jump variants). On rung 1, don't let
  a global key listener fight the real app's own shortcuts.
- Visually distinct from the page (a high-contrast pill, a subtle shadow) so it's
  obviously not part of the design being evaluated.
- **Kept out of production.** The primary safety net is that the prototype lives
  on a `proto/<slug>` branch that is never merged (SKILL.md, rule 1). Where the
  project has a cheap production check (`process.env.NODE_ENV !== 'production'`
  or its equivalent) that doesn't fight its own rules, gate the bar on it too.
  Either way, keep `prototype` in the route segment or filename, so a reviewer or
  a search catches a stray switcher before it can merge.

Put the switcher in a single shared component, wherever shared UI lives in the
project, so a rung 1 page and a rung 2 route reuse it. Use one switcher pattern
per environment: an app route, a workshop toolbar and a raw-HTML file won't share
a component.

### 5. Hand it over

Give the user the URL (or the story) and the variant keys. They'll flip through
whenever they get to it. The interesting feedback is usually **"I want the header
from B with the sidebar from C"**: that composite is the design they want.

### 6. Capture the answer and clean up

Once a variant has won, record the answer (which variant and why), then keep the
prototype the way SKILL.md (Capture) describes. Rebuild the winner in the real
code as a rewrite, and leave the rest on the `proto/<slug>` branch:

- **Rung 1**: rebuild the winner into the existing page; none of the variants or
  the switcher reach the default branch.
- **Rung 2 route**: rebuild the winning variant as a real route; the throwaway
  route and the switcher stay on the `proto/` branch.
- **Rung 2 workshop story**: rebuild the winning composition as real components
  with their own stories and tests.

The full set of variants is the primary source, so it lands on the `proto/`
branch rather than the bin. Variant components and a switcher left in the default
branch rot fast and confuse the next reader.

## Holding the shape

- **Make variants disagree about structure.** A difference in colour or copy is a
  tweak, not a prototype.
- **Share only leaf components between variants.** A shared `<Header>` is fine; a
  shared `<Layout>` defeats the point, because each variant must be free to throw
  out the layout.
- **Keep variants read-only.** If one needs to mutate, point it at a stub: the
  question is "what should this look like", not "does the backend work".
- **Rewrite the winner properly when folding it in.** The variant code was written
  under prototype constraints (no tests, minimal error handling), so it is a
  reference for production, not production.
