# Logos

> **Status: placeholder.** Both files are a generic wordmark reading "YOUR
> BRAND". Replace them with your own artwork, keep the file names, and change
> this line to `Status: defined`.

## The assets

Paths are relative to the brand kit's folder: this skill's directory, or the
configured brand folder when one is set.

| File | Use on |
|---|---|
| `assets/logo-primary.svg` | light grounds |
| `assets/logo-white.svg` | dark grounds and photography |

Both are the same artwork; only the fills differ. A consumer that needs a logo
reads this file for the path and never stores its own copy.

## Picking the variant

Pick by measured contrast against the region the logo will sit on, not by eye and
not by intent: if the region's relative luminance is above roughly 0.5, use
`logo-primary`; below, use `logo-white`. Guessing from the file name is where most
wrong picks come from.

## Rules

1. **Never store a copy of a logo elsewhere.** Reference the path. Inlining the
   SVG markup into a self-contained output file (a slide deck) is a render, not a
   copy: read it fresh each time.
2. **Never recolour a logo inline.** A fill that does not exist is a brand
   decision: add a variant file here.
3. **Never place a logo on a busy region** without measuring contrast against the
   region it actually covers, not the image average.
4. **Keep the clear space.** No other element within half the mark's height.
