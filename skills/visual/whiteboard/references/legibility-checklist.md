# Legibility checklist + the blind critic

Read after every drawing, before you point back (SKILL.md §2(e)): this is the bar
a drawn board must clear. Legibility is a **gate**, not polish: keep correcting
until every item passes. Aesthetics (below) are *not* gated — do not loop on them.

## The gate, step by step

1. `GET /image` and read the picture's caption first. When it begins
   `Overview:`, the picture shows none of the shapes' text, so take `GET /image?bounds=x,y,w,h`
   on the region you drew instead: its page coordinates from `/shapes`, widened
   by about 40 page units on each side so the crop cuts no stroke or label of
   yours. If that picture is an overview too, gate the region in parts small
   enough to draw in full. Then run the blind critic (below) with only that PNG
   path and the six "Must pass" items, never the instruction or the `/exec`
   code. When the picture is a `?bounds=` crop, the brief also says: "This
   picture is a crop of a larger board." It returns pass or fail per item,
   locating each fail.
2. A fail located "overview, not judgeable" means the picture was the wrong one,
   not that a shape is wrong: go back to step 1 and zoom to your piece. It
   changes no shape and counts as no round. On any other fail, correct with
   `/exec` and re-run the critic, at most 3 rounds. If it still fails,
   `/agent-message` that the board may be hard to read, and where.
3. Once legibility passes, take at most one aesthetic pass, then stop.

## Must pass (legibility)

1. **The picture shows its text.** A picture captioned `Overview:` shows none of
   its shapes' text, so nothing on it can be judged: fail this item and every
   other, each with the locator "overview, not judgeable".
2. **No clipped or overflowing text.** Every shape's label sits fully inside the
   shape — nothing cut off at the top, bottom, or sides. (A `geo` box centers its
   text vertically and clips *both* ends when it is too short; see the geo-text
   landmine in `tldraw-editor-api.md`.)
3. **No mid-word breaks.** No single word is split across lines (e.g.
   "TLSocketRoo m", "authoritativ e"). Widen the box or shorten the text.
4. **No content-hiding overlap.** No shape sits on top of another's text; no two
   labels overlap each other into an unreadable smear.
5. **Arrows are readable.** Each arrow's endpoints are clear (you can tell what it
   connects), and its label is readable and not shattered across lines.
6. **Nothing off-canvas.** No shape or label runs past the exported image edge.
   When the picture is a crop of a larger board, a shape whose outline crosses
   the edge was cut by the crop: judge this item on the shapes whose outline is
   wholly inside, where a label running past the edge is still a fail.

## Not gated (aesthetics — stop, do not chase)

Even spacing and alignment; a label crossing a shape's border line while still
fully readable; color choices; perfectly balanced distribution. Once the six
items above pass, take **at most one** aesthetic pass, then stop.

## The blind critic

The drawing turn grades its own work and is optimistic about it: that is the
failure this exists to catch. So the check is run by fresh eyes, blind to intent.

If you can dispatch subagents, dispatch one with the prompt below, filling in the
PNG path. Hand it nothing else: not the instruction, not the intent, not the
`/exec` code. It judges what is on the pixels, not what you meant to draw. If you
cannot dispatch subagents, run the prompt yourself, but view the fresh PNG before
re-reading the instruction, and judge only what you can point to in the image.

> You are checking a rendered whiteboard image for legibility. Open the image at
> `<png path>` and look at it. For each of the six "Must pass" items below,
> answer **pass** or **fail**. For each fail, give a one-line locator naming the
> shape and the defect, for example "Bridge box: title 'Bridge (HTTP + WS)'
> clipped at the top edge". Report only; do not suggest a redesign.
> <for a `?bounds=` crop: "This picture is a crop of a larger board.">
>
> <paste the six "Must pass" items>

The lead fixes the reported defects with a corrective `/exec` and re-runs the
critic, per § The gate, step by step: never silently point back to a broken
board.
