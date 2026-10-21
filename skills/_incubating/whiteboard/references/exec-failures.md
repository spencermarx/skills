# When a bridge call fails, or a recovery runs

Read when `POST /exec` answers `200` with `ok:false`, and when any route answers a `503` other
than `/image`'s `no image produced` (which is only an empty board). Read it before you retry
anything.
The design is [`SPEC.md`](../SPEC.md) §5 and decisions #56, #64 and #67.

## A `503`: the render-canvas could not answer

The call never reached a canvas, so nothing was drawn and its `idempotencyKey` was dropped.

1. Poll `GET /canvas-status` every 10 s while it reads `relaunching: true`.
2. Then retry the call once.
3. If that `503`s too, report its `lastExportError` and `lastNavError` to the operator.
   `self-heal failed` means the relaunch gave up.

## `ok:false` from `/exec`: the blob may have drawn

A `200` with `ok:false` means the blob reached the render-canvas and may have drawn, in part
or whole. Its error ends `this blob may have drawn: read /shapes (what it wrote carries your
name and an at no earlier than this answer's sentAt, in meta.createdBy or meta.lastEditedBy),
then redo only what did not land and no one else has edited since, under a new
idempotencyKey`. `sentAt` is a field of the answer: when the server sent the blob. That tail
follows one of three causes:

- **the blob's own error**: a blob that throws is not undone; what it wrote before the throw
  stays, though tldraw may roll back the writes of an `editor.run` the throw escapes, and a
  throw that leaves the canvas's store corrupted sets off a recovery as well;
- **`sync-severed`**: the write did not reach the room, and the server's recovery runs (below);
- **`the render-canvas did not answer within <n> s, so`**: the blob timed out. Before
  answering, the bridge reloads or relaunches the canvas, which ends the blob, timers and all.
  When the canvas reports its store corrupted, a recovery (below) does that reload or relaunch.

In every case the answer comes once the blob has returned, thrown or been ended, and once any
recovery has run, so if it awaited what it started, nothing it does lands after your read. Then:

1. If the answer carries `recovery`, follow its outcome (§ A recovery in the answer).
2. `GET /shapes` and find what the blob wrote: shapes whose `meta.createdBy` or
   `meta.lastEditedBy` carries your name with an `at` no earlier than the answer's `sentAt`.
   A shape the blob brought back with `editor.undo()` or `editor.redo()`, or moved to another
   page with `moveShapesToPage`, keeps the stamps it had, so this does not pick it out: check
   those by id. `/shapes` lists
   only the current page, so for one on another page send an `/exec` that only reads,
   `return editor.getShape('<id>')`, and find the record in the answer's `result`.
3. Redo only what did not land. An update or a delete can fail to land as well as a create,
   and a relative change (a move by an offset) run again whole applies twice.
4. Leave any shape whose `meta.lastEditedBy` names someone else with an `at` no earlier than
   `sentAt`: they changed it since, whether or not your write landed.
5. Send the corrected write under a **new** `idempotencyKey`. The old key returns its first
   answer for at least 5 minutes without running what you send.

`… already exists; change it with updateShapes` means the blob created a shape on an id that
exists. Give new shapes fresh ids with `createShapeId()` and change existing ones with
`updateShapes` ([`tldraw-editor-api.md`](tldraw-editor-api.md) § Ids).

## A recovery in the answer

When the write did not reach the room (`sync-severed`, the blob's own error on a store it left
corrupted, or a timeout on a store the canvas reports corrupted), the server runs a recovery
before it answers. It reloads the canvas and writes into the room every page, shape, binding
and asset the canvas changed and had not sent, whichever page it is on. The answer then
carries `recovery: { recovered, text, missing?, why?, kept? }`, where `text` is the line the
panel shows as from `Whiteboard`. `kept` lists the records recovery left as the room holds them:
those someone changed during the recovery or that need a record someone removed, and those the
canvas removed that a record in the room still needs. Leave them as the room holds them,
deleted included. An answer without `recovery` followed no recovery: the board holds what the
blob left.

- **`recovered: true`, `Recovered the board after <reason>. …`**: the room holds everything the
  canvas had not sent, bindings and other pages included, except the records in `kept`, and the
  canvas `/shapes` reads already shows it. Redo what the blob did not draw as steps 2 to 5 say;
  after a timeout, the room holds what the blob had drawn when recovery read the canvas.
- **`recovered: false`, a line ending `Reload it, or restart the whiteboard.`** (`Manual
  recovery needed: the board could not be repaired after <reason> (<detail>). The canvas may be
  frozen.`): stop drawing, quote the line to the operator, and leave the call to them.
  Restarting is a close and a reopen (SKILL.md §5, then `/whiteboard open <board>`), done only
  on their explicit instruction; never stop the board's job yourself.
- **`recovered: false`, any other line**: it asks you to read the board and redraw what is
  missing. Do that as for `ok:false` above: read `/shapes` and `/image`, and redraw only what is
  missing under a new `idempotencyKey`.
  - When the line says the server is relaunching the canvas, `/shapes` answers `503` until it is
    back: follow § A `503` first.
  - When the line says the room holds what recovery put back, the room holds everything the
    canvas had not sent, except the records in `kept`, as for `recovered: true`; the canvas,
    which `/shapes` reads, had not shown it yet. Read `/shapes` again a few seconds later before
    you redraw anything, and redraw only what that read still lacks.

  `missing`, when present, lists the ids the room does not hold as the canvas did, bindings and
  assets included, which `/shapes` does not list: what recovery could not put back or remove,
  and what it held back because a record it needs could not go in. It covers only what
  recovery read from the canvas. A write it did not read is in no list: one a blob still running
  made after that read, or, when a relaunch was already under way as the recovery began, one on
  the canvas that went down, since recovery may then have read the relaunched one. So a line can
  say the last write may be missing when `missing` is absent: find what landed as steps 2 to 5
  say. An answer without `missing` has nothing missing of what recovery read,
  unless its line says the corrupted canvas could not be read, the room could not be written,
  or the recovery stopped on an error: then recovery could not tell what is missing, and the
  board is your only record of what landed. `why` gives the cause for
  each asset in `missing` that recovery could not take from the canvas:
  - `too large`: more than the 100 MiB one message from the canvas may carry. The same image
    fails the same way, so redraw it smaller or leave it out.
  - `no answer`: the canvas did not answer in time, or went down before it answered. Sending
    it again may land.
  - `unreadable`: the canvas's answer carried no record list, so it said nothing of the asset.
    Sending it again may land.
  - `gone`: the canvas's record list left the asset out: it was deleted from the canvas while
    recovery read it, by someone else or by the blob, and is not in the room either. Ask the
    operator before you redraw it or what used it.
