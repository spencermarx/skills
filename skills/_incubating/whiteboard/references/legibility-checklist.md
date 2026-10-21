# Legibility checklist + the blind critic

Read after every drawing, before you point back (SKILL.md §2(e)): this is the bar
a drawn board must clear. Legibility is a **gate**, not polish: keep correcting
until every item passes. Aesthetics (below) are *not* gated — do not loop on them.

## The gate, step by step

1. `GET /image`, then dispatch the blind critic (below) with only the PNG path
   and the "Must pass" items, never the instruction or the `/exec` code. It
   returns pass or fail per item, locating each fail.
2. On a fail, correct with `/exec` and re-run the critic, at most 3 rounds. If it
   still fails, `/agent-message` that the board may be hard to read, and where.
3. Once legibility passes, take at most one aesthetic pass, then stop.

Alone on a board you may check the PNG yourself against the checklist.

## Must pass (legibility)

1. **No clipped or overflowing text.** Every shape's label sits fully inside the
   shape — nothing cut off at the top, bottom, or sides. (A `geo` box centers its
   text vertically and clips *both* ends when it is too short; see the geo-text
   landmine in `tldraw-editor-api.md`.)
2. **No mid-word breaks.** No single word is split across lines (e.g.
   "TLSocketRoo m", "authoritativ e"). Widen the box or shorten the text.
3. **No content-hiding overlap.** No shape sits on top of another's text; no two
   labels overlap each other into an unreadable smear.
4. **Arrows are readable.** Each arrow's endpoints are clear (you can tell what it
   connects), and its label is readable and not shattered across lines.
5. **Nothing off-canvas.** No shape or label runs past the exported image edge.

## Not gated (aesthetics — stop, do not chase)

Even spacing and alignment; a label crossing a shape's border line while still
fully readable; color choices; perfectly balanced distribution. Once the five
items above pass, take **at most one** aesthetic pass, then stop.

## The blind critic

The drawing turn grades its own work and is optimistic about it — the failure
mode this exists to catch. So the check is run by **fresh eyes, blind to intent**,
the same posture as [`humanize-reader`](../../../agents/humanize-reader.md) and
[`vault-critic`](../../../agents/vault-critic.md) for prose.

Dispatch a **tracked subagent** and hand it **only**:
- the exported PNG path (have it `Read` the image), and
- this checklist (the "Must pass" items).

Do **not** tell it the instruction, the intent, or the `/exec` code — it judges
what is on the pixels, not what you meant to draw. Ask it to return, per item,
**pass / fail**, and for each fail a one-line locator ("Bridge box: title
'Bridge (HTTP + WS)' clipped at the top edge"). It reports; it does not fix.

The drawing agent then fixes the reported defects and re-runs the critic, per
§ The gate, step by step: never silently point back to a broken board.
