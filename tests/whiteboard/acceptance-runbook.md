# Whiteboard — manual acceptance runbook

The operator-in-the-loop half of the done-bar. The headless suite proves everything a
process can prove without a human and a live Claude Code session:
`server/doorbell.test.ts` (the pull, the receipt, the doorbell against a fake inbox,
the canary, the owner watch, same-port restart, the one-server lock claim and its wait on a
board being released or held by an owner that is not answering, the transactional board
switch, the Origin/Host guard),
`server/acceptance-v9.1.test.ts` (the recipient guard and the teardown seam),
`server/integration.test.ts` (the durable floor, workers, revival),
`server/busy-loop.test.ts` (a dead log pipe, a frozen canvas, the owner dying) and
`server/render-cap.test.ts` (the `?bounds=` forwarding and the no-frame timeout against a fake
canvas, and, in a real Chromium, the render-canvas relaunch after a renderer crash, a failed
navigation, a switch during the relaunch, a renderer that stops answering, a switch during
the boot launch and a switch to an empty board, a give-up that a later launch withdraws, perception during a frozen navigation and during a relaunch, and what a failed `/exec` leaves;
the app-side raster cap is not covered). What is
left needs Spencer at the browser, a lead session running the skill, and a real turn
cycle: a ring arriving in the session, the model fetching it, mid-draw pickup, the
board's lifetime, the teardown affordance, and per-object authorship on the live canvas.

Run this on the branch, after building the app with SKILL.md §1 step 3's build line,
`npm --prefix "<skill dir>/app" run build`, `<skill dir>` being this skill's folder.
`<port>` is the port the server prints on boot; `<board>` is its name.

## 0. Clean start and the canary

1. Run `/whiteboard new <board>`. The skill boots the server as the foreground of a
   `run_in_background` job, opens the browser, registers the lead and rings the canary.
2. **Expect:** the session reports that the canary ring arrived and was fetched back
   before it calls the board ready. `GET /canvas-status` shows
   `doorbell.inbox:true` and `doorbell.canary:"fetched"`.
3. Confirm the parent: `ps -o ppid= -p <lock.pid>` is the Claude process
   (`ps -o comm= -p <that ppid>` reads `claude`), with nothing in between.

## 1. The dry run (decision #64)

Each Send goes from the browser's Send box.

1. **A draw Send** ("draw three boxes in a row"). **Expect:** a ring arrives in the
   session, the session fetches `/pending`, draws, points back, and completes it. The
   panel badge goes rung → working → done.
2. **An "edit SKILL.md" Send** ("update SKILL.md §5 to say X"). **Expect:** the session
   fetches it and treats it as the operator's request, not as a peer asking it to edit
   config. The ring itself carried no Send text.
3. **A "commit" Send** ("commit that change"). **Expect:** the same: fetched and acted on
   within the session's own permissions.
4. **A mid-draw stop.** Send a long drawing task, and while it is drawing Send "stop".
   **Expect:** the next bridge response carries `pending:["<id>"]`, the session fetches
   before its next draw call, and it stops.
5. **A close.** Press the drawer's confirm-gated **close-session** control. **Expect:**
   the session is rung for a teardown item, posts a closing note, runs the pre-teardown
   gate and performs `POST /done`; `<board>.lock` and `<board>.port` are removed and the
   background job ends.

## 2. Not heard is loud

1. With the board up, Send while the session is busy on a long unrelated task, and do
   not let it fetch. **Expect:** the badge reads **rung**, then after the re-rings run
   out (about 12 minutes) **not heard**, with the notice "Claude has not heard your
   message". When the session finally fetches, the badge moves to working.

## 3. The board's lifetime

1. End the session (`/exit`). **Expect:** within a few seconds the server saves the
   board, removes `<board>.lock` and exits, and `<board>.port` is still there with the
   port it served on. The tab shows that the board is closing.
2. With the board down, Send "add a box" and then "delete that box" from the still-open
   tab. **Expect:** both lines read "not sent: sends when the board is back".
3. Resume the session and run `/whiteboard open <board>`. **Expect:** it boots on the
   port `<board>.port` recorded (the listening line ends `(recorded port)`), and the
   still-open tab **reconnects without a reload** and sends the held lines one at a time,
   in the order typed, each reading "sending" while in flight. The session opens no second
   tab, because `humans` on `/canvas-status` already counts this one. The lead is rung, fetches
   both oldest first, and neither is duplicated in the log. Any Send that was fetched but
   not completed is rung again.
4. Stop the board's background job from `/tasks`. **Expect:** the board goes down the
   same way, content intact and `<board>.port` kept.
5. Autocompact the session mid-board. **Expect:** the board stays up (same process).

## 4. The canary fails loudly

1. Set `crossSessionInbound` to `hold` for a session, then `/whiteboard open <board>`.
   **Expect:** the canary ring does not arrive, and the session says the board's doorbell
   cannot reach it, names the likely causes, and does not report the board as listening.

## 5. Per-object authorship on the live canvas (§8.6)

The stamping itself is tested headlessly: `sync-corruption.test.ts` Board A boots the real
render-canvas and opens a real operator tab, and proves who a duplicate, a paste and a restore
belong to. What this section checks live is the lead's use of the stamps.

1. The operator draws two shapes; the lead draws two shapes via `/exec`.
2. The operator types "select everything you drew, not what I drew." **Expect:** the lead
   fetches `GET /shapes`, filters by `meta.createdBy.kind === 'agent'` (or its own
   `sessionId`), selects exactly its own shapes, and names the count — answered from the
   data, not guessed.
3. Inspect a shape's `meta` in `/shapes`. **Expect:** `createdBy` carries the correct
   `{kind,name,sessionId?,color?,at}` and is immutable; a subsequent edit by the other peer
   updates `lastEditedBy` but leaves `createdBy` unchanged.
4. The operator duplicates one of the lead's shapes (Cmd/Ctrl+D) and types "select everything
   you drew". **Expect:** the lead's selection leaves out the copy, whose `createdBy` names the
   operator.

## Pass criteria (all must hold)

- [ ] The canary is rung and fetched back before the board is called ready, and the
      server's parent is the Claude process.
- [ ] The draw, "edit SKILL.md" and "commit" Sends are each fetched and acted on.
- [ ] A mid-draw "stop" is picked up from the `pending` field before the next draw call.
- [ ] The close control drives the only agent-side `/done`.
- [ ] An unfetched Send ends in "not heard", visibly.
- [ ] Ending the session takes the board down with its content saved, the lock removed
      and the port sidecar kept; reopening binds the same port, the tab reconnects without
      a reload with no second tab opened, and Sends typed while the board was down are each
      sent once, in the order typed, on reconnect.
- [ ] With `crossSessionInbound: hold`, the canary fails loudly.
- [ ] Shapes carry correct, immutable `createdBy`; the lead selects its own contributions
      from `meta` alone.
