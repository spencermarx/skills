# Animation Patterns

Animations are **included by default** in every generated deck. Only omit them if the user explicitly asks for a static deck.

## Design Principle

Animations should feel like content **revealing** itself, not content **performing**. Reference points: Stripe's page transitions, Linear's feature reveals, Anthropic's blog scroll effects. Nothing bounces, spins, or shakes.

## Pattern Library

All CSS patterns are triggered by the `.visible` class, which the `SlidePresentation` JS controller adds via IntersectionObserver when a slide enters the viewport.

### 1. Fade Up (default for all content)

Class: `reveal`

Use on: headings, body text, bullet points, cards, images, any standard content element.

```css
/* Already defined in viewport-base.css */
.reveal {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity var(--duration-reveal) var(--ease-out-expo),
              transform var(--duration-reveal) var(--ease-out-expo);
}
.slide.visible .reveal {
  opacity: 1;
  transform: translateY(0);
}
```

### 2. Fade In (backgrounds, images)

Class: `reveal-fade`

Use on: full-bleed images, background elements, subtle decorative pieces.

```css
.reveal-fade {
  opacity: 0;
  transition: opacity 800ms ease;
}
.slide.visible .reveal-fade { opacity: 1; }
```

### 3. Scale In (hero stats, display numbers)

Class: `reveal-scale`

Use on: massive stat numbers, hero elements, logos. Gives a subtle "landing" feel.

```css
.reveal-scale {
  opacity: 0;
  transform: scale(0.95);
  transition: opacity 500ms var(--ease-out-expo),
              transform 500ms var(--ease-out-expo);
}
.slide.visible .reveal-scale { opacity: 1; transform: scale(1); }
```

### 4. Draw Line (dividers, timeline connectors)

Class: `reveal-line`

Use on: horizontal dividers, timeline vertical lines, decorative rules.

```css
.reveal-line {
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 800ms ease-in-out;
}
.slide.visible .reveal-line { transform: scaleX(1); }
```

### 5. Stagger Children (lists, grids)

Mechanism: `nth-child` delays (built into viewport-base.css) or `--stagger-index` CSS variable.

Use on: bullet lists, card grids, option rows. Each child element fades up sequentially.

```html
<!-- Option A: automatic nth-child stagger (up to 8 items) -->
<div class="slide-content">
  <p class="reveal">Item 1</p>
  <p class="reveal">Item 2</p>
  <p class="reveal">Item 3</p>
</div>

<!-- Option B: explicit stagger index for more control -->
<div class="slide-content">
  <p class="reveal" style="--stagger-index: 0">Item 1</p>
  <p class="reveal" style="--stagger-index: 1">Item 2</p>
  <p class="reveal" style="--stagger-index: 2">Item 3</p>
</div>
```

### 6. Count Up (stat numbers, JS-driven)

Use on: hero stat numbers on stat-hero slides. Animates from 0 to the target number.

This is the only JS-driven animation. It is the `animateCounters()` method of the `SlidePresentation` controller in `html-template.md`, which the controller already calls; do not add a second copy.

Usage in HTML:
```html
<span class="text-display reveal-scale"
      data-count-to="42.5"
      data-count-suffix="%"
      data-count-decimals="1">0%</span>
```

## What NOT to Animate

- No slide-level transitions (scroll-snap handles that)
- No 3D transforms (rotateX, rotateY, perspective)
- No bounce or elastic easing functions
- No parallax scrolling effects
- No auto-playing loops or infinite animations
- No animation on the footer or logo
- No hover-triggered animations on slide content (this is a presentation, not a web app)
