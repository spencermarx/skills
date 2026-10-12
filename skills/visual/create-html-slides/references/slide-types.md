# Slide Types

A catalog of every slide type to generate. Each type has a BEM class, a content density limit, a layout description, and an HTML structure snippet.

**Hard rule:** If content exceeds a slide type's density limit, split into multiple slides. Never cram. `overflow: hidden` will clip anything that doesn't fit, and clipped content is worse than an extra slide.

---

## 1. Title Slide

**Class:** `slide--title`
**Max content:** 1 headline (8 words) + 1 subtitle (15 words) + optional byline
**Layout:** Centered vertically and horizontally. Headline in display weight. Subtitle below in medium weight. Generous negative space.

```html
<section class="slide slide--title">
  <div class="slide-content" style="align-items: center; text-align: center;">
    <h1 class="text-display reveal-scale">Headline Here</h1>
    <p class="text-subheading reveal" style="color: var(--brand-primary-light);">Subtitle goes here with more context</p>
    <p class="text-caption reveal">Presenter Name  |  Date</p>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 2. Section Divider

**Class:** `slide--divider`
**Max content:** 1 label (4 words) + optional subtitle (10 words)
**Layout:** Large display text, minimal content. Signals a topic shift. Can use brand-primary-tint background for differentiation.

```html
<section class="slide slide--divider" style="background-color: var(--brand-primary-tint);">
  <div class="slide-content" style="align-items: center; text-align: center;">
    <span class="badge reveal">SECTION</span>
    <h2 class="text-display reveal">The Data Story</h2>
    <p class="text-body reveal" style="color: var(--brand-primary-light);">Optional subtitle</p>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 3. Content Slide

**Class:** `slide--content`
**Max content:** 1 heading + 6 bullet points (12 words each max)
**Layout:** Left-aligned heading above a card containing the bullet list. Bullets use brand-primary dots as markers.

```html
<section class="slide slide--content">
  <div class="slide-content">
    <h2 class="text-heading reveal">Slide Heading</h2>
    <div class="card reveal">
      <ul style="list-style: none; display: flex; flex-direction: column; gap: 12px;">
        <li class="text-body reveal" style="--stagger-index: 0;">
          <span style="color: var(--brand-primary); margin-right: 8px;">&#9679;</span>
          Bullet point content here
        </li>
        <!-- max 6 items -->
      </ul>
    </div>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 4. Stat Hero

**Class:** `slide--stat`
**Max content:** 1 massive number/stat + 1 context line (10 words) + optional comparison line + optional sparkline SVG
**Layout:** Number fills ~40% of viewport height as the visual anchor. Context line below. Pill badge above. This is the "wow" slide.

```html
<section class="slide slide--stat">
  <div class="slide-content" style="align-items: center; text-align: center;">
    <span class="badge reveal">RESULT</span>
    <div class="reveal-scale">
      <span class="text-display" data-count-to="42" data-count-suffix="%"
            style="font-size: clamp(4rem, 10vw + 2rem, 12rem);">0%</span>
    </div>
    <hr class="divider reveal-line" />
    <p class="text-heading reveal">fewer support tickets after launch</p>
    <p class="text-caption reveal">Example figure: replace with a sourced number</p>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 5. Two-Column

**Class:** `slide--two-col`
**Max content:** 1 heading + 2 columns of max 4 items each
**Layout:** CSS grid with two equal columns inside a card. Each column has its own heading.

```html
<section class="slide slide--two-col">
  <div class="slide-content">
    <h2 class="text-heading reveal">Heading</h2>
    <div class="card reveal" style="display: grid; grid-template-columns: 1fr 1fr; gap: 32px;">
      <div>
        <h3 class="text-subheading reveal">Column A</h3>
        <ul style="list-style: none; display: flex; flex-direction: column; gap: 8px;">
          <li class="text-body reveal">Item 1</li>
          <!-- max 4 items -->
        </ul>
      </div>
      <div>
        <h3 class="text-subheading reveal">Column B</h3>
        <ul style="list-style: none; display: flex; flex-direction: column; gap: 8px;">
          <li class="text-body reveal">Item 1</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 6. Comparison (Before/After, Us/Them)

**Class:** `slide--compare`
**Max content:** 1 heading + 2 labeled columns (5 items each max)
**Layout:** Side-by-side cards with distinct headers. Left card can use a muted style, right card uses brand-primary accent to highlight the preferred option.

```html
<section class="slide slide--compare">
  <div class="slide-content">
    <h2 class="text-heading reveal">Before vs. After</h2>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
      <div class="card reveal" style="border-color: var(--neutral-divider);">
        <span class="badge">BEFORE</span>
        <ul style="list-style: none; display: flex; flex-direction: column; gap: 8px; margin-top: 16px;">
          <li class="text-body">Item</li>
        </ul>
      </div>
      <div class="card reveal" style="border-color: var(--brand-primary);">
        <span class="badge">AFTER</span>
        <ul style="list-style: none; display: flex; flex-direction: column; gap: 8px; margin-top: 16px;">
          <li class="text-body">Item</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 7. Data Story

**Class:** `slide--data`
**Max content:** 1 heading + 1 visualization area (inline SVG) + 3 annotation points
**Layout:** Card with an embedded inline SVG chart (bar, line, donut) and annotation callouts. The chart is a visual element, not a data dump.

```html
<section class="slide slide--data">
  <div class="slide-content">
    <span class="badge reveal">DATA</span>
    <h2 class="text-heading reveal">What the numbers show</h2>
    <div class="card reveal">
      <!-- Inline SVG chart here -->
      <svg viewBox="0 0 400 200" style="width: 100%; max-height: 200px;">
        <!-- chart elements in brand-primary -->
      </svg>
      <hr class="divider reveal-line" />
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <p class="text-body reveal">Annotation 1</p>
        <p class="text-body reveal">Annotation 2</p>
        <p class="text-body reveal">Annotation 3</p>
      </div>
    </div>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 8. Image Slide

**Class:** `slide--image`
**Max content:** 1 full-bleed image + optional caption (15 words)
**Layout:** Image fills the slide. Caption in a semi-transparent overlay at the bottom. For self-contained decks, use base64 data URIs.

```html
<section class="slide slide--image" style="padding: 0; padding-bottom: var(--footer-height);">
  <img src="data:image/png;base64,..." alt="Description"
       class="reveal-fade"
       style="width: 100%; height: calc(100% - var(--footer-height)); object-fit: cover;" />
  <p class="text-caption" style="position: absolute; bottom: calc(var(--footer-height) + 16px); left: var(--slide-padding); color: white; text-shadow: 0 1px 4px rgba(0,0,0,0.5);">
    Optional caption
  </p>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 9. Quote

**Class:** `slide--quote`
**Max content:** 1 quote (30 words max) + 1 attribution line
**Layout:** Large quote text centered, attribution below in mono caption style. Quote marks in brand-primary.

```html
<section class="slide slide--quote">
  <div class="slide-content" style="align-items: center; text-align: center; max-width: 900px;">
    <span class="text-display reveal" style="color: var(--brand-primary-tint); font-size: 6rem; line-height: 0.5;">&ldquo;</span>
    <blockquote class="text-heading reveal" style="font-style: italic; font-weight: 400;">
      The quote text goes here, kept under thirty words for impact.
    </blockquote>
    <p class="text-caption reveal">Speaker Name, Title</p>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 10. Grid / Cards

**Class:** `slide--grid`
**Max content:** 1 heading + max 6 cards (each: icon or number + label + 1-line description)
**Layout:** CSS grid, 2x3 or 3x2 depending on content. Each card is a mini-card inside the slide.

```html
<section class="slide slide--grid">
  <div class="slide-content">
    <h2 class="text-heading reveal">Key Capabilities</h2>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
      <div class="card reveal" style="--stagger-index: 0; text-align: center; padding: 24px;">
        <span class="text-display" style="font-size: 2rem;">01</span>
        <p class="text-body" style="font-weight: 600;">Label</p>
        <p class="text-caption">One-line description</p>
      </div>
      <!-- max 6 cards -->
    </div>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 11. Timeline

**Class:** `slide--timeline`
**Max content:** Max 5 entries (date/label + 1 line description each)
**Layout:** Vertical timeline with connected dots in brand-primary. Entries alternate or stack left.

```html
<section class="slide slide--timeline">
  <div class="slide-content">
    <h2 class="text-heading reveal">How We Got Here</h2>
    <div class="card reveal" style="position: relative; padding-left: 48px;">
      <!-- Vertical line -->
      <div class="reveal-line" style="position: absolute; left: 24px; top: 0; bottom: 0; width: 2px; background: var(--brand-primary); transform-origin: top;"></div>
      <div style="display: flex; flex-direction: column; gap: 24px;">
        <div class="reveal" style="position: relative; --stagger-index: 0;">
          <div style="position: absolute; left: -32px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--brand-primary);"></div>
          <p class="text-caption">Jan 2025</p>
          <p class="text-body">Timeline entry description</p>
        </div>
        <!-- max 5 entries -->
      </div>
    </div>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## 12. CTA / Closing

**Class:** `slide--cta`
**Max content:** 1 headline (6 words) + 1 action line (15 words) + optional contact info
**Layout:** Centered, prominent. Brand-primary accent on the action element. This is the "what's next" slide.

```html
<section class="slide slide--cta">
  <div class="slide-content" style="align-items: center; text-align: center;">
    <h2 class="text-display reveal-scale">Let's Make This Happen</h2>
    <hr class="divider reveal-line" style="max-width: 200px;" />
    <p class="text-subheading reveal">Book a 20-minute kickoff call for next week.</p>
    <p class="text-caption reveal">you@example.com  |  example.com</p>
  </div>
  <div class="slide-footer"><!-- logo + title --></div>
</section>
```

---

## Slide Type Selection Guide

When the user describes content, map it to a type:

| Content pattern | Recommended type |
|---|---|
| One big number or percentage | **Stat Hero** |
| List of points or features | **Content** (split at 6) |
| Two things side by side | **Comparison** or **Two-Column** |
| Chart, graph, or data visualization | **Data Story** |
| Opening with title and subtitle | **Title** |
| Closing with next step or CTA | **CTA/Closing** |
| Topic transition | **Section Divider** |
| Customer testimonial or key quote | **Quote** |
| Multiple small items (features, steps) | **Grid/Cards** |
| Sequence of events or milestones | **Timeline** |
| Photo or screenshot | **Image** |
