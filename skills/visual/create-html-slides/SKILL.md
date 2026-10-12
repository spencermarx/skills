---
name: create-html-slides
description: >-
  Build a branded slide deck as one self-contained HTML file: 16:9, editorial, animated by
  default, with an optional PDF export. Use for a sales or demo deck, an internal
  presentation, a pitch, a workshop or conference talk, or to improve an existing HTML deck.
  Do NOT use for a report or visual write-up read on screen (use `create-report`), a
  product interface (use `design-expert`), a throwaway UI mock (use `prototype`), or a
  deck others must edit natively in a slides app.
license: MIT
compatibility: "Writes plain HTML, CSS and JavaScript; no build step. The deck loads web fonts from a CDN and falls back to system fonts offline. PDF export needs Node.js 18+ and npm, and installs Playwright with Chromium (about 150 MB) after asking."
---

# Create HTML slides

Generate a branded slide deck as a single self-contained HTML file. You write the
complete HTML, CSS and JavaScript: no build tools, no frameworks, no dependencies
beyond the web fonts the brand names.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

- `references/viewport-base.css`: the responsive CSS foundation, inlined into every deck.
- `references/html-template.md`: document structure, the JS controller, the footer.
- `references/slide-types.md`: twelve slide types, each with a density limit.
- `references/animation-patterns.md`: the reveal animations, on by default.
- `scripts/export-pdf.sh`: the PDF export (with `scripts/capture.mjs`).

## When not to use it

- A text-only outline: write markdown.
- An interactive web application: use a real framework.
- A print document: use a document template.
- A single image, infographic or social card: build it with an image generator,
  if you have one, from the brand kit's visual design system.

## Phase 0: pick the mode

- The user gives a path to an existing `.html` deck: **enhance mode**. Read the
  file, propose improvements, and edit it in place.
- Otherwise, **new deck mode**: go on to phase 1.

## Phase 1: content discovery

Gather these. If the user has already given enough (a detailed outline, a
document), confirm your reading in one message rather than interrogating them.

| Question | Why |
|---|---|
| Who is the audience? | Sets tone, density and jargon |
| What is the one-sentence takeaway? | Anchors every slide's hierarchy |
| How many slides? (suggest 3 to 12) | Scopes the deck |
| What content exists already? | Bullets, a document, or nothing yet |
| Any specific slide types? | Maps to `references/slide-types.md` |
| Will it be shown offline? | Decides whether images and fonts are embedded |
| Where should the file be saved? | See phase 2, step 4 |

Ask the user, using your structured-question tool if you have one; otherwise list
numbered questions in plain text and stop until they reply.

## Phase 2: generate the deck

### Step 1: load the brand

Load the `get-brand-kit` skill (through your skill tool, `/get-brand-kit`, or by
reading its SKILL.md). It says where this repository's brand kit lives. Read
these parts of it and use the values exactly:

| Brand kit file | What you take from it |
|---|---|
| color palette | every colour token, for the `:root` block |
| typography | the display, body and mono faces, their weights and fallbacks, the web-font URL |
| visual design system | background, card, badge, divider, data-mark and spacing rules |
| logos | the path of each logo variant |

If any file it serves is still marked `Status: placeholder`, build with it, and
tell the user in your delivery message that the deck uses placeholder brand
values, not theirs.

**If `get-brand-kit` is not installed,** ask the user for their brand: the
palette, the typefaces, and a logo file. If they have none to give, build with
the fallback tokens already in `references/viewport-base.css`, use the deck title
as plain text where the logo would go, and say in your delivery message that the
deck uses a neutral placeholder brand.

Never write a brand value from memory or from an earlier deck.

### Step 2: load the references

| Reference | What to do with it |
|---|---|
| `references/viewport-base.css` | Inline it into the `<style>` block, with its `:root` tokens filled from the brand kit. Change nothing else in it. |
| `references/html-template.md` | Follow it for the document structure, the JS controller and the footer. |
| `references/slide-types.md` | Choose a type for each slide and hold to its density limit. |
| `references/animation-patterns.md` | Include the animations, unless the user asked for a static deck. |

### Step 3: embed the logo

Read the logo SVG from the path the brand kit's logos file gives, and inline its
markup into every slide's footer: the light-ground variant on light slides, the
dark-ground variant on dark ones. Read it fresh for each deck; never paste a logo
remembered from another file.

### Step 4: write the file

Produce one self-contained HTML file following `references/html-template.md`.

**Where it goes.** Use the location the user named. If they named none, propose
one: `<deck-name>/index.html` under the folder this repository already keeps
presentations in, or, for a throwaway draft, the scratch folder
(`docs/agents/workspace.md` names it; default `.scratchpad/`, git-ignored).
Ask before writing when neither is clear.

**Density.** Each slide type has hard limits in `references/slide-types.md`. When
content exceeds a slide's capacity, split it across slides. Never cram:
`overflow: hidden` clips whatever does not fit, and clipped content is worse than
an extra slide.

## Phase 3: deliver and refine

1. Open the file in the default browser: `open <path>` on macOS, `xdg-open
   <path>` on Linux, `start <path>` on Windows. If you cannot open it, give the
   user the absolute path.
2. Ask for feedback, and iterate by editing the HTML file directly.
3. If the user wants a PDF, export it (below).

### PDF export

The export screenshots each slide at 1920 by 1080 (16:9, the size slide apps
import at 10 by 5.625 inches) and assembles a multi-page PDF. It needs Playwright
and a Chromium build, which the script installs into a per-user cache folder,
never into the repository, and never on its own.

1. **Check the runtime:**

   ```bash
   bash scripts/export-pdf.sh check
   ```

   - **Exit 0** (`ready: <folder>`): go to step 3.
   - **Exit 3** (not installed): it prints the exact commands an install would
     run. Show them to the user, and tell them it downloads the Playwright
     package and Chromium, about 150 MB. Ask before installing, using your
     structured-question tool if you have one; otherwise ask in plain text and
     stop until they reply.
   - **Exit 1**: a precondition failed, usually Node.js missing or older than
     18. Relay the message; installing Node.js is the user's call.

2. **Install, only after the user agrees:**

   ```bash
   bash scripts/export-pdf.sh install
   ```

   If it fails, it prints the commands; give them to the user to run themselves.
   If the user declines, stop: the HTML deck is the deliverable, and the browser's
   own print-to-PDF works from its print styles.

3. **Export:**

   ```bash
   bash scripts/export-pdf.sh --input <deck.html> --output <deck.pdf>
   ```

   `--output` defaults to the deck's path with `.pdf`; `--width` and `--height`
   default to 1920 and 1080. The export never installs anything: with no runtime
   it exits 3 and prints the same commands as `check`.

## Related skills

| Skill | Relationship |
|---|---|
| `get-brand-kit` | The source of every brand value in the deck. Read it, never hardcode. |
| `seven-copy-critics` | Run the deck's copy through it before a high-stakes presentation, when installed. |
| `brand-review` | Audit the finished deck against the brand, when installed. |
