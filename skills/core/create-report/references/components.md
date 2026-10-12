# Standard components

Read this while writing `content.html`, to copy the markup for a component instead of inferring it
from the stylesheet. Every class here is styled by `assets/report-base.css`; the snippets carry
placeholder content, so swap the words and keep the structure.

## Page shell - `.r-page`

The outer wrapper for the whole page. Write page content only: the assemble script supplies the
document around it, so the file starts at `.r-page`.

```html
<div class="r-page">
  <header class="r-header">…</header>
  <nav aria-label="Sections">
    <ol class="r-toc">
      …
    </ol>
  </nav>
  <main class="r-stack">
    <section class="r-section" aria-labelledby="sec-one">…</section>
    <section class="r-section" aria-labelledby="sec-two">…</section>
  </main>
  <footer class="r-footer">…</footer>
</div>
```

`.r-stack` gives its children the page's vertical rhythm; reach for it anywhere a column of blocks
needs even spacing.

## Header - `.r-header`

Opens the page: what the report is, what it covers, when it was made, and the legend for the marks
used in its diagrams. The page carries exactly one `<h1>`.

```html
<header class="r-header">
  <h1 class="r-header__title">Report title</h1>
  <p class="r-header__subject">What this report covers, in one line.</p>
  <ul class="r-header__meta">
    <li><time datetime="0000-00-00">0 Month 0000</time></li>
    <li>4 sections</li>
    <li>9 entries</li>
  </ul>
  <ul class="r-legend">
    <li>
      <span class="r-node" aria-hidden="true"></span> Plain outline: a part
    </li>
    <li>
      <span class="r-node r-node--strong" aria-hidden="true"></span> Filled box:
      the part the entry is about
    </li>
    <li>
      <span class="r-edge r-edge--dashed" aria-hidden="true"></span> Dashed
      line: an indirect relation
    </li>
    <li>
      <span class="r-edge r-edge--warn" aria-hidden="true"></span> Caution line:
      a relation to weigh
    </li>
    <li>
      <span class="r-edge r-edge--alert" aria-hidden="true"></span> Alert line:
      the relation the diagram exists to point at
    </li>
  </ul>
</header>
```

The legend swatches are `aria-hidden` because the text beside each one already says what the mark
means.

## Table of contents - `.r-toc`

Worth adding once the page runs past two sections, or whenever a reader is likely to arrive
looking for one entry rather than reading start to finish. Each link targets a section heading
`id`; entries are reached from the section they sit in.

```html
<nav aria-label="Sections">
  <ol class="r-toc">
    <li><a href="#sec-one">Section one</a></li>
    <li><a href="#sec-two">Section two</a></li>
    <li><a href="#closing">Closing</a></li>
  </ol>
</nav>
```

The class sits on the list rather than the `<nav>`, because the stylesheet rules the rows as its
direct children.

## Section - `.r-section`

One top-level division of the page. Give the heading an `id` and point the section's
`aria-labelledby` at it, so both the table of contents and any `.r-trace` link resolve.

```html
<section class="r-section" aria-labelledby="sec-one">
  <h2 class="r-section__head" id="sec-one">Section one</h2>
  <p class="r-section__lede">
    One or two sentences on what this section establishes.
  </p>
  <div class="r-stack">
    <article class="r-entry" id="entry-alpha">…</article>
    <article class="r-entry" id="entry-beta">…</article>
  </div>
</section>
```

## Entry - `.r-entry`

The repeating unit: one record, one entry. Head carries the title and its marks; body carries the
fields, the points, and the trace link back to the record.

```html
<article class="r-entry" id="entry-alpha">
  <div class="r-entry__head">
    <h3 class="r-entry__title">Entry alpha</h3>
    <ul class="r-entry__badges">
      <li><span class="r-badge r-badge--accent">Primary</span></li>
      <li><span class="r-tag">tag-one</span></li>
      <li><span class="r-tag">tag-two</span></li>
    </ul>
  </div>
  <div class="r-entry__body">
    <div class="r-field">
      <span class="r-field__label">Position</span>
      <span class="r-field__value">One sentence on where things stand.</span>
    </div>
    <div class="r-field">
      <span class="r-field__label">Change</span>
      <span class="r-field__value">One sentence on what moves.</span>
    </div>
    <ul class="r-points">
      <li>Short point, six words or fewer</li>
      <li>Second short point</li>
      <li>Third short point</li>
    </ul>
    <p>
      <a class="r-trace" href="record.md#entry-alpha">Record: entry alpha</a>
    </p>
  </div>
</article>
```

Entry titles are `<h3>` under a section's `<h2>`, which keeps the heading order unbroken.

## Badges - `.r-badge`

A short mark on an entry, in one of three weights. The tone names weight, not meaning: pick which
of your own labels each weight carries, and use the same mapping across the whole report.

```html
<span class="r-badge r-badge--accent">Primary</span>
<span class="r-badge r-badge--warn">Caution</span>
<span class="r-badge r-badge--quiet">Neutral</span>
```

## Tags - `.r-tag`

A flat, uncolored label for categorising an entry, sitting beside the badges.

```html
<span class="r-tag">tag-one</span>
```

## Callouts - `.r-callout`

One line that needs to stand out of the flow - a note the reader acts on, or a condition attached
to what the entry just said.

```html
<p class="r-callout r-callout--accent">
  One line worth pulling out of the flow.
</p>
<p class="r-callout r-callout--warn">
  One line the reader should weigh before acting.
</p>
```

## Meta list - `.r-meta`

Paired labels and values: the parameters a section or entry was produced under. The terms and
descriptions are direct children, which is what lets the stylesheet hold every label in one column
and every value in the next.

```html
<dl class="r-meta">
  <dt>Range</dt>
  <dd>0000-00-00 to 0000-00-00</dd>
  <dt>Inputs</dt>
  <dd>3 sources</dd>
  <dt>Record</dt>
  <dd class="r-mono">record.md</dd>
</dl>
```

## File list - `.r-files`

Paths and other literal strings, set in mono so they stay scannable.

```html
<ul class="r-files">
  <li>path/to/first-file.ext</li>
  <li>path/to/second-file.ext</li>
</ul>
```

## Figure - `.r-figure`

Every diagram is a `<figure>` with a `<figcaption>`: the frame holds the drawing, the caption
states what it shows. The caption is what a reader gets when the drawing does not render.

```html
<figure class="r-figure">
  <div class="r-figure__frame">
    <svg
      viewBox="0 0 320 120"
      role="img"
      aria-labelledby="fig-one-title fig-one-desc"
    >
      <title id="fig-one-title">Three parts in sequence</title>
      <desc id="fig-one-desc">
        Node A connects to node B directly; node B connects to node C
        indirectly.
      </desc>
      <rect class="r-node" x="8" y="40" width="88" height="40" rx="4" />
      <text class="r-label" x="52" y="64" text-anchor="middle">Node A</text>
      <line class="r-edge" x1="96" y1="60" x2="120" y2="60" />
      <rect
        class="r-node r-node--strong"
        x="120"
        y="40"
        width="88"
        height="40"
        rx="4"
      />
      <text class="r-label" x="164" y="64" text-anchor="middle">Node B</text>
      <line class="r-edge r-edge--dashed" x1="208" y1="60" x2="232" y2="60" />
      <rect
        class="r-node r-node--quiet"
        x="232"
        y="40"
        width="80"
        height="40"
        rx="4"
      />
      <text class="r-label" x="272" y="64" text-anchor="middle">Node C</text>
    </svg>
  </div>
  <figcaption class="r-figure__caption">
    Figure 1 - three parts in sequence, the middle one emphasized.
  </figcaption>
</figure>
```

An SVG that says something carries `role="img"` plus a `<title>` and `<desc>` referenced by
`aria-labelledby`, which is how a screen reader receives what the drawing says. An SVG that only
decorates a statement already made in words takes `aria-hidden="true"` instead.

### Mermaid frame - `.r-figure__frame--mermaid`

For graph-shaped diagrams. The mermaid frame keeps a light ground in both themes, because mermaid
renders with its own light palette on a publishing surface that draws it natively.

```html
<figure class="r-figure">
  <div class="r-figure__frame r-figure__frame--mermaid">
    <pre class="mermaid">
flowchart LR
  A[Node A] --> B[Node B]
  B -.-> C[Node C]
    </pre>
  </div>
  <figcaption class="r-figure__caption">
    Figure 2 - node A reaches node C only through node B.
  </figcaption>
</figure>
```

### Hand-built schematic

When the layout matters more than the graph, build the diagram from `.r-node`, `.r-edge`, and
`.r-label` as elements. The parts take the same styling in `<div>` form as in SVG, so a page can mix
the two forms and still read as one drawing.

```html
<figure class="r-figure">
  <div class="r-figure__frame">
    <span class="r-label">Group one</span>
    <div class="r-stack">
      <div class="r-node">Node A</div>
      <div class="r-edge" aria-hidden="true"></div>
      <div class="r-node r-node--strong">Node B</div>
      <div class="r-edge r-edge--dashed" aria-hidden="true"></div>
      <div class="r-node r-node--quiet">Node C</div>
    </div>
  </div>
  <figcaption class="r-figure__caption">
    Figure 3 - the same three parts, drawn as a stack.
  </figcaption>
</figure>
```

Connector elements are `aria-hidden` because they carry no text; the caption states the relation.

### Schematic modifiers

`.r-node` takes `--strong` for the part the diagram is about, drawn as a solid heavy box, and
`--quiet` for a part held in the background. `.r-edge` takes `--dashed` for an indirect relation and
`--warn` for one to weigh. Both parts take `--alert`, which paints red; spend it on the single
relation or part the diagram exists to point at, because keeping red to that one thing is what stops
a page reading as a dashboard. Badges and callouts carry the accent and caution tones instead.

```html
<div class="r-node r-node--alert">Node A</div>
<div class="r-edge r-edge--alert" aria-hidden="true"></div>
```

```html
<rect class="r-node r-node--alert" x="8" y="40" width="88" height="40" rx="4" />
<line class="r-edge r-edge--alert" x1="96" y1="60" x2="120" y2="60" />
```

## Comparison pair - `.r-pair`

Two blocks read side by side, stacking to one column under 48rem. The usual pair is two figures - one state and the state it moves to.

```html
<div class="r-pair">
  <figure class="r-figure">
    <div class="r-figure__frame">…</div>
    <figcaption class="r-figure__caption">
      Figure 4a - first arrangement.
    </figcaption>
  </figure>
  <figure class="r-figure">
    <div class="r-figure__frame">…</div>
    <figcaption class="r-figure__caption">
      Figure 4b - second arrangement.
    </figcaption>
  </figure>
</div>
```

## Grid - `.r-grid`

Three or more equal blocks that the reader scans rather than reads in order.

```html
<div class="r-grid">
  <div class="r-callout r-callout--accent">First block.</div>
  <div class="r-callout r-callout--accent">Second block.</div>
  <div class="r-callout r-callout--accent">Third block.</div>
</div>
```

## Table - `.r-table` inside `.r-scroll-x`

Wide content scrolls inside its own container, which keeps the page body from scrolling sideways.
The wrapper is a labelled, focusable region so it can be scrolled from the keyboard.

```html
<div class="r-scroll-x" role="region" aria-labelledby="tbl-one" tabindex="0">
  <table class="r-table">
    <caption id="tbl-one">
      Table 1 - placeholder values by column.
    </caption>
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">Count</th>
        <th scope="col">Note</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th scope="row">Row one</th>
        <td>12</td>
        <td>Short note.</td>
      </tr>
      <tr>
        <th scope="row">Row two</th>
        <td>7</td>
        <td>Short note.</td>
      </tr>
    </tbody>
  </table>
</div>
```

Any wide block takes the same wrapper - a broad schematic or a long code line as well as a table.

## Closing card - `.r-closing`

One larger card at the end: what the report comes down to, and a link to the entry that carries it.

```html
<section class="r-closing" aria-labelledby="closing">
  <h2 class="r-section__head" id="closing">Closing</h2>
  <p>One sentence on what the report comes down to.</p>
  <p><a class="r-trace" href="#entry-alpha">Entry alpha</a></p>
</section>
```

## Trace link - `.r-trace`

Carries a claim on the page back to the record it came from, so a reader can check it. Point it at
a heading anchor in `record.md`, or at another entry on the page.

A `record.md` anchor resolves in the local document, where the record sits beside it, and not on a
published page, where only the page itself is uploaded. Use one where the local file is the copy a
reader checks against; for a claim whose support is elsewhere on the page, point at that entry
instead, which resolves at both destinations.

```html
<p><a class="r-trace" href="record.md#entry-alpha">Record: entry alpha</a></p>
```

The class sits on the link itself, which is what carries its quiet mono treatment and the turned
arrow before it.

## Footer - `.r-footer`

Closes the page with how it was produced.

```html
<footer class="r-footer">
  <p class="r-small r-muted">
    Generated from <span class="r-mono">record.md</span> on 0000-00-00.
  </p>
</footer>
```

## Utilities

Single-purpose classes for a local adjustment inside another component.

```html
<p class="r-small r-muted">Secondary line, set small and quiet.</p>
<p><span class="r-mono">literal/string/here</span></p>
<span class="r-caps">Schematic label</span>
<span class="r-vh">Text only assistive technology receives.</span>
```

`.r-vh` is how a control or region gets a name without adding visible copy - a heading a sighted
reader does not need, or the expansion of a mark.

## Extending the foundation

A consumer skill that needs a shape the standard components do not carry builds its own the way the
foundation builds these: `integrating-a-consumer.md` states the four things that make one
conform. The tokens easiest to miss when you do: `--r-ink-inverse` for text on a filled heavy box,
`--r-strong-fill` and its flat companion `--r-strong-flat` for that fill, `--r-alert` for the one
thing a diagram points at, `--r-step--2` for a schematic or caps label, and `--r-step--1` for small
body text.

A worked example - a rail of ordered steps, one of them current:

```css
.r-rail {
  display: grid;
  gap: var(--r-space-3);
}

.r-rail__step {
  border-left: var(--r-border) solid var(--r-rule);
  padding-left: var(--r-space-3);
  color: var(--r-ink);
}

.r-rail__step--current {
  border-left-color: var(--r-accent);
}

.r-rail__label {
  display: block;
  font-family: var(--r-font-mono);
  font-size: var(--r-step--2);
  line-height: var(--r-leading-tight);
  letter-spacing: var(--r-tracking-caps);
  text-transform: uppercase;
  color: var(--r-ink-muted);
}
```

```html
<ol class="r-rail">
  <li class="r-rail__step">
    <span class="r-rail__label">Step one</span>
    <p>What happens first.</p>
  </li>
  <li class="r-rail__step r-rail__step--current">
    <span class="r-rail__label">Step two</span>
    <p>What happens next.</p>
  </li>
</ol>
```

It reads as the foundation because it borrows the foundation's rule color, accent, spacing, and
label treatment, and it inherits both themes for free by naming tokens rather than colors.
