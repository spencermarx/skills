# Report format

Read this when you are about to write a report's page. It governs the page's shape and how to draw
it; the caller owns the subject and the words.

## The scaffold

You write page content only, in `content.html` - no `<!doctype>`, `<html>`, `<head>` or `<body>`.
The `assemble-report.sh` script - `SKILL.md` gives the invocation - takes that file, an output
directory, and an optional `--title`, and emits both targets from it: `report.page.html` (the
publish source - title, the inlined base stylesheet, your content) and `report.html` (a standalone
local document with the same content, plus a mermaid loader for local viewing).

```html
<div class="r-page">
  <header class="r-header">…</header>

  <main class="r-stack">
    <section class="r-section" aria-labelledby="section-slug">
      <h2 class="r-section__head" id="section-slug">…</h2>
      <p class="r-section__lede">…</p>
      <div class="r-stack">
        <article class="r-entry" id="entry-slug">…</article>
        <article class="r-entry" id="another-entry">…</article>
      </div>
    </section>

    <section class="r-closing" aria-labelledby="closing">…</section>
  </main>

  <footer class="r-footer">…</footer>
</div>
```

Give every section heading and every entry an `id` so links resolve, point each section's
`aria-labelledby` at its heading, keep one `<h1>` (the header title) with headings in order below
it, and open with a `.r-toc` when the page has enough sections to be navigated rather than read - `components.md` has the markup and the threshold.

Everything the page needs lives inside the document: the stylesheet is inlined by the script,
diagrams are drawn as inline SVG or mermaid, and a raster image arrives as a `data:` URI. **No
external host - no CDN script, no web font, no remote image, no `fetch`.** A hosted publishing
surface (Claude's artifacts, for one) blocks them all, and a blocked request renders as an empty
frame that says nothing about why.

## Header

Title, one line on what the report covers, the date, and - when the diagrams use one - a compact
legend. Then straight into the content.

```html
<header class="r-header">
  <h1 class="r-header__title">…</h1>
  <p class="r-header__subject">What this covers, in one line.</p>
  <ul class="r-header__meta">
    <li><time datetime="2026-08-17">17 August 2026</time></li>
    <li>3 sections</li>
  </ul>
  <ul class="r-legend">
    <li>
      <span class="r-node" aria-hidden="true"></span> Plain outline: one unit
    </li>
    <li>
      <span class="r-node r-node--strong" aria-hidden="true"></span> Filled box:
      the heavy unit
    </li>
    <li>
      <span class="r-edge r-edge--dashed" aria-hidden="true"></span> Dashed
      line: an indirect link
    </li>
    <li>
      <span class="r-edge r-edge--alert" aria-hidden="true"></span> Alert line:
      the relation at issue
    </li>
  </ul>
</header>
```

The swatches are the schematic parts themselves at sample size, so the legend and the diagrams stay
in step. Name only the weights the page uses, and let the red one name the single relation the
report exists to point at.

## The entry

`.r-entry` is the repeating unit - one per thing the report records. Title, badge row, a few
fields, the diagram, tight points, and the trace back to the record.

```html
<article class="r-entry" id="entry-slug">
  <div class="r-entry__head">
    <h3 class="r-entry__title">Short, names the thing</h3>
    <ul class="r-entry__badges">
      <li><span class="r-badge r-badge--accent">weight</span></li>
      <li><span class="r-tag">category</span></li>
    </ul>
  </div>
  <div class="r-entry__body">
    <div class="r-field">
      <span class="r-field__label">Where</span>
      <span class="r-field__value">one short fact</span>
    </div>
    <ul class="r-files">
      <li>libs/example/src/thing.ts</li>
    </ul>
    <figure class="r-figure">…</figure>
    <ul class="r-points">
      <li>one gain, six words</li>
      <li>one more</li>
    </ul>
    <p class="r-callout r-callout--warn">
      The one line that must not be missed.
    </p>
    <p><a class="r-trace" href="record.md#entry-slug">record</a></p>
  </div>
</article>
```

The diagram carries the weight; prose is sparse. Each point is a bullet, not a sentence with a
bullet in front of it. If a diagram needs a paragraph to be understood, redraw the diagram.

Badge tones name weight, not meaning: `--accent`, `--warn`, `--quiet`. The caller decides what each
weight means in its subject and says so once in the header legend.

For short attributes that genuinely enumerate, `.r-meta` renders a definition list and `.r-table` a
table - wrap either in `.r-scroll-x` when it is wide, so the page body never scrolls sideways. Use
`.r-grid` when a set of equal, small cards belongs side by side.

## Diagram patterns

Pick the pattern the relation actually has, and mix them across the report. A page where every
diagram is the same flowchart reads as generated; variety is how it reads as drawn.

Inline SVG is the default editorial mode - it themes with the page tokens, needs nothing external,
and you place every part yourself. Mermaid is the workhorse when the relation is genuinely
graph-shaped (dependency, call flow, sequence, state) and hand-placing nodes would be a waste.

Inside a diagram, name parts with `.r-label`; `.r-caps` gives the same schematic treatment
elsewhere. Give an SVG a `<title>` that says in words what the drawing says - a diagram is
decorative only when the record already states the same thing. The snippets below show a frame's
interior; wrap each in a `<figure class="r-figure">` with its `.r-figure__caption`.

### Comparison pair - two states of one thing

The centrepiece pattern. Two frames side by side in `.r-pair`, which stacks under ~48rem.

```html
<figure class="r-figure">
  <div class="r-pair">
    <div class="r-figure__frame">
      <p class="r-label">Before</p>
      …
    </div>
    <div class="r-figure__frame">
      <p class="r-label">After</p>
      …
    </div>
  </div>
  <figcaption class="r-figure__caption">What changed, in one line.</figcaption>
</figure>
```

Draw both sides on the same scale, so the difference in the drawing is the difference in the fact.

### Boxes and arrows - named parts pointing at each other

Inline SVG, when you want exact weight and placement.

```html
<div class="r-figure__frame">
  <svg viewBox="0 0 200 78" role="img" aria-labelledby="flow-title">
    <title id="flow-title">Intake calls Router; Router reaches back.</title>
    <defs>
      <marker
        id="flow-tip"
        refX="7"
        refY="4"
        markerWidth="8"
        markerHeight="8"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path d="M0 0 L8 4 L0 8 z" fill="context-stroke" />
      </marker>
    </defs>
    <g class="r-node">
      <rect x="2" y="14" width="72" height="34" rx="3" />
      <rect x="126" y="14" width="72" height="34" rx="3" />
    </g>
    <path class="r-edge" d="M74 26 L122 26" marker-end="url(#flow-tip)" />
    <path
      class="r-edge r-edge--alert"
      d="M162 48 L162 66 L38 66 L38 50"
      marker-end="url(#flow-tip)"
    />
    <text class="r-label" x="38" y="35" text-anchor="middle">Intake</text>
    <text class="r-label" x="162" y="35" text-anchor="middle">Router</text>
  </svg>
</div>
```

Each schematic class paints twice - border and background in HTML, `fill` and `stroke` here - so
`.r-node` on a `<g>` colors every rect inside it and the drawing follows the theme; a token variable
resolves in a presentation attribute too, for the part that has no class. The arrowhead takes its
color from the line it ends, so one marker serves every edge; the page is one document, so give that
marker and the title ids unique to their figure.

Edges carry `--dashed` for an indirect link, `--warn` for caution, and `--alert` for the single
relation the diagram exists to point at; `.r-node--alert` marks a part the same way. Reserve red
for that one relation or part, and let slate, amber, and the accent carry everything else.

### Layered cross-section - how many layers a thing passes through

Horizontal bands in a `.r-stack`, which levels every band to the width of the widest. On one side
the count is the message, so let the quiet bands stay thin; on the other, a single filled
`.r-node--strong` band stands in for all of them, and its weight lands before a label is read.

```html
<div class="r-pair">
  <div class="r-figure__frame">
    <div class="r-stack" style="gap: var(--r-space-2)">
      <p class="r-label">Before</p>
      <span class="r-node r-node--quiet">passes through</span>
      <span class="r-node r-node--quiet">passes through</span>
      <span class="r-node r-node--quiet">passes through</span>
    </div>
  </div>
  <div class="r-figure__frame">
    <div class="r-stack" style="gap: var(--r-space-2)">
      <p class="r-label">After</p>
      <span class="r-node r-node--strong" style="min-height: var(--r-space-7)">
        does the work
      </span>
    </div>
  </div>
</div>
```

### Proportion - relative size is the point

Bars whose explicit heights carry the ratio. Keep both columns on one scale so the eye compares them
directly.

A node is `inline-flex`, so bars that should sit one above another go inside a column - `.r-stack`
with a tightened gap does it without a new class.

```html
<div class="r-figure__frame">
  <div class="r-pair">
    <div class="r-stack" style="gap: var(--r-space-2)">
      <p class="r-label">Before</p>
      <span class="r-node" style="height: 4.5rem">surface</span>
      <span class="r-node r-node--quiet" style="height: 5rem">body</span>
    </div>
    <div class="r-stack" style="gap: var(--r-space-2)">
      <p class="r-label">After</p>
      <span class="r-node" style="height: 1.5rem">surface</span>
      <span class="r-node r-node--quiet" style="height: 8rem">body</span>
    </div>
  </div>
</div>
```

### Collapse - several things become one, and their internals go quiet

Nesting says "these are now inside" more plainly than an arrow does. The filled outer node turns its
own axis to a column so its label sits above what it now contains, and the quiet boxes read as pale
internals held inside that dark fill.

```html
<div class="r-figure__frame">
  <div class="r-stack" style="gap: var(--r-space-2)">
    <p class="r-label">After</p>
    <div
      class="r-node r-node--strong"
      style="flex-direction: column; gap: var(--r-space-2)"
    >
      one unit
      <span class="r-node r-node--quiet">was separate</span>
      <span class="r-node r-node--quiet">was separate</span>
    </div>
  </div>
</div>
```

### Mermaid graph - the relation is a graph

`flowchart` and `graph` for dependency and call flow, `sequenceDiagram` for "six round trips became
one", `stateDiagram-v2` for lifecycles. The `--mermaid` frame modifier is what keeps it legible; see
**Both targets** below.

```html
<figure class="r-figure">
  <div class="r-figure__frame r-figure__frame--mermaid r-scroll-x">
    <pre class="mermaid">
flowchart LR
  A[Intake] --> B[Router]
  B --> C[Store]
  C -.retry.-> B
  classDef marked stroke:#dc2626,stroke-width:2px;
  class C marked
    </pre>
  </div>
  <figcaption class="r-figure__caption">What the graph shows.</figcaption>
</figure>
```

Mermaid draws with its own palette, so style it with `classDef` and literal colors, and take the
light values the frame is locked to: `#dc2626` for the relation the diagram points at, `#b45309` for
caution. Keep it to one emphasized class - that emphasis is the reason the diagram is here.

## The closing section

One larger card. What the reader should take away, and an anchor link to the entry it points at.

```html
<section class="r-closing" aria-labelledby="closing">
  <h2 class="r-section__head" id="closing">What to take away</h2>
  <p>The one thing, stated plainly.</p>
  <p><a class="r-trace" href="#entry-slug">The entry it comes from</a></p>
</section>
```

## Both targets

The script absorbs the difference between the local file and the published page, so write for
neither in particular. One thing leaks through: mermaid frames stay on a light surface in both
themes, because a publishing surface that renders mermaid natively (Claude's artifacts do)
initializes it with a light palette that we do not control. `.r-figure__frame--mermaid` carries that surface - put it on every mermaid frame, and
nowhere else.

The other is the trace link: an anchor into `record.md` resolves locally and not once published.
`components.md` says which to reach for.

## Style and tone

- Editorial, not corporate-dashboard: generous whitespace, prose at `--r-measure` on a 64rem page
  (`--r-page`), serif headings against the sans body, and flat, hairline-bordered cards, so nothing
  competes with the diagrams.
- A warm stone ground under cool slate ink. One accent, emerald, for links and the primary badge;
  amber for caution; slate for the neutral weight; red kept for the one relation or part a diagram
  exists to point at.
- Keep a diagram near 320px (20rem) tall, so a before/after `.r-pair` sits side by side without
  scrolling.
- Schematic labels run at `--r-step--2` (0.75rem, uppercase, tracked): `.r-label` inside diagrams,
  `.r-caps` outside them - engineering drawing, not UI chrome. `--r-step--1` (0.875rem) is
  body-small, the size a monospaced `.r-files` list and a figure caption take.
- `.r-mono` for identifiers, `.r-muted` and `.r-small` for the aside that earns its place, `.r-vh`
  for text that exists only for a screen reader.
- No hedging, no throat-clearing, no "it is worth noting that". If a sentence could be a bullet,
  make it a bullet; if a bullet could be cut, cut it.
- The vocabulary belongs to the caller. Use its words exactly as it gives them, and reach for one of
  its terms before inventing a synonym. This file's own units are the only ones it supplies: report,
  record, page, section, entry, component, diagram.
