# Typography

> **Status: placeholder.** Free, widely available faces chosen so assets render
> anywhere before a brand is set. Replace them with your own faces, weights and
> scale, and change this line to `Status: defined`.

The single source of truth for typefaces, weights and hierarchy.

## Faces

| Role | Face | Weights | Fallback stack |
|---|---|---|---|
| **Display** (headlines, hero numbers) | Inter | 900, 700 | `system-ui, -apple-system, sans-serif` |
| **Body** (body copy, subheads) | Inter | 500, 400 | `system-ui, -apple-system, sans-serif` |
| **Mono** (captions, metadata, badges) | Fira Code | 500, 400 | `'SF Mono', 'Cascadia Code', monospace` |

**Web-font source:** Google Fonts. A consumer building a web page or deck loads
exactly the faces and weights above, for example:

```
https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&family=Fira+Code:wght@400;500&display=swap
```

Replace this line when you change faces, or name the self-hosted files instead.

## Hierarchy

| Element | Face and weight | Colour token |
|---|---|---|
| Display number, hero stat | Display, heaviest weight | `brand-primary` |
| Headline | Display, 700 | `brand-primary-dark` |
| Subhead | Body, 500 | `brand-primary-dark` |
| Body | Body, 400, generous line height | `neutral-ink` |
| Caption, metadata | Mono, 500, small, uppercase, tracked | `brand-primary-light` |

Colour tokens are defined in `color-palette.md`.

## Rules

1. **Sans-serif for display and body; mono for metadata.** No serif faces unless
   this file adds one.
2. **The heaviest weight for hero elements.** A massive headline or stat uses the
   heaviest weight of the display face.
3. **Few weights per asset.** One emphasis weight and one body weight, plus mono
   for metadata. No thin weights; italic only when intentional and rare.
4. **Never name a typeface in another skill or template.** Read this file. When
   the faces change, this is the only place they change.

## Open questions to settle when you replace this

- Which licensed face is the display face, and which the body face?
- What is the canonical type scale, headline to caption?
- Are the fonts loaded from a CDN or self-hosted?
