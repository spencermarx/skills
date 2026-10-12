# Whiteboard v9.1 — manual acceptance runbook

The operator-in-the-loop half of the v9.1 done-bar. The headless suite
(`server/acceptance-v9.1.test.mjs` for the two new server seams;
`server/integration.test.mjs` for the carried §8.5 durable-delivery floor) proves
everything a process can prove without a human and a live poller. What is left needs
the operator at the browser, a lead session running the skill-owned background poller, and
a real Claude Code turn cycle: the wake-on-exit, the listen-while-interact property,
the stay-connected invariant, forced-end survival, the operator teardown affordance,
and per-object authorship on the live canvas.

Run this after all four v9.1 lanes are integrated and the app is rebuilt
(`npm --prefix .claude/skills/whiteboard/app run build`). Times are Donostia local.
`<port>` is the port the server prints on boot; `<board>` is its name.

## 0. Clean start

1. Boot one board on the branch via the skill (SPEC §9). The boot launches the
   render-canvas, opens the operator browser, registers the lead, drains any backlog,
   and starts the background poller.
2. Sanity: `GET /canvas-status` returns `activeRoom:"<board>"`, `agents:[{id:"lead",…}]`,
   and `agentParked:true`. The `agentParked:true` with an empty terminal is the whole
   point of v9.1: a waiter is parked in the background job while the foreground turn has
   already ended.

## 1. Poll-loop spike (prove the loop before trusting anything above it)

This is the load-bearing mechanism. SPEC §12 lane 4 says prove it first.

1. With the lead idle (its foreground turn ended, no Send outstanding), watch the
   background poller. Over a full `LONGPOLL_MS` window (240s, `index.ts:42`) with no
   Send, the poller's `curl` returns `204` and the script **re-opens** the hanging GET.
   **Expect:** the session is **not** woken across the `204` — no new foreground turn,
   the terminal stays quiet, and `GET /canvas-status` still reads `agentParked:true`
   throughout. A `204` is a re-arm, never a wake.
2. Draw a shape, select it, type any instruction, Send. **Expect:** the poller's `curl`
   returns `200` with the Send, the background job **exits**, and that exit **wakes the
   session** (a harness re-invoke) into a fresh foreground turn that acts on the Send.
   The operator did not re-launch anything.
3. Immediately after the lead acknowledges (`POST /instruction-complete`) and while it is
   mid-act on the next stroke, Send again. **Expect:** the second Send waits in the durable
   per-recipient queue and **drains the instant the poller relaunches** (the unmissable
   final step of the turn). Nothing is lost; the operator never re-launches.

## 2. Listen-while-interact (#48)

1. Send an instruction ambiguous enough that the lead asks a clarifying question. The lead
   posts the question and **hands the foreground turn back** to the terminal.
2. While that question sits unanswered in the terminal (operator and lead mid-conversation),
   Send a *second* instruction from the browser. **Expect:** it lands **instantly** — a
   background waiter was parked the whole time — and the lead acts on it. The operator did
   not have to answer the first question or re-launch to get the second Send delivered.
3. Confirm `GET /canvas-status` read `agentParked:true` continuously across the whole
   exchange, including while the terminal was waiting on the human.

## 3. No premature hangup (#49)

1. Steer the lead to a point where the work looks finished.
2. **Expect:** the lead **asks** ("are we done — can I disconnect?") and **keeps listening**.
   It does **not** call `/done` on its own, and `agentParked` stays `true`.
3. Say nothing for a while. **Expect:** operator silence keeps the line open — the lead does
   not interpret silence as permission to close. Only an explicit operator "yes" (or the
   teardown affordance, §5) closes the session.

## 4. Forced-end board survival (#50)

1. Drive the lead session until a **forced** end fires — autocompaction (~76–84%), context
   exhaustion, or `maxTurns`. (To force it deliberately, run the session long/hot enough to
   trip autocompaction.)
2. **Expect:** the board's **Node process stays up** — its port still answers
   `GET /canvas-status`, and `<board>.lock` is still on disk pointing at the live pid. The
   forced end tore down the *session*, not the *board*.
3. Send an instruction while no lead session is attached. **Expect:** `agentParked:false`
   (the session ended, not merely mid-conversation), the panel shows the Send **queued** with
   a plain "no agent is listening" state, and the Send is **not** lost.
4. Run `/whiteboard open <board>`. **Expect:** it **attaches** to the still-live process
   (not a stale-lock reclaim, not a fresh boot), drains the queued Send oldest-first, and acts
   on it. No teardown, no loss.

## 5. Operator teardown affordance closes the session (#53)

1. In the drawer, press the confirm-gated **close-session** control and confirm.
2. **Expect (network):** the browser posts the distinct teardown-request (e.g.
   `POST /request-teardown`), **not** `POST /message`. It does **not** appear in the chat log
   — it is a control signal. `GET /canvas-status` briefly reads `teardownRequested:true`.
3. **Expect (lead):** the lead's `supervise=1` poll returns the **teardown directive**; the
   lead finishes any in-flight turn, posts a brief closing `/agent-message`, and performs the
   graceful `POST /done`. This is the **only** agent-side teardown, and it fires **only** on
   this explicit operator signal — never at the lead's discretion.
4. **Expect (after):** the process exits, `<board>.lock` is removed, and the port stops
   answering. Confirm the natural-language fallback too: on a fresh board, a plain
   "you can disconnect now" Send drives the same graceful close.

## 6. Per-object authorship on the live canvas (§8.6)

Not headlessly testable — the app stamps `meta.createdBy` via an editor side-effect on the
live render-canvas and the operator's browser, both skipped under `WHITEBOARD_NO_CANVAS`.

1. The operator draws two shapes; the lead draws two shapes via `/exec`.
2. The operator types "select everything you drew, not what I drew." **Expect:** the lead
   fetches `GET /shapes`, filters by `meta.createdBy.kind === 'agent'` (or its own
   `sessionId`), selects exactly its own shapes, and names the count — answered from the data,
   not guessed.
3. Inspect a shape's `meta` in `/shapes`. **Expect:** `createdBy` carries the correct
   `{kind,name,sessionId?,color?,at}` and is immutable; a subsequent edit by the other peer
   updates `lastEditedBy` but leaves `createdBy` unchanged.

## Pass criteria (all must hold)

- [ ] The poller holds a waiter across a `204` without waking the session, and wakes it on a
      real Send; a mid-act Send drains on the next relaunch.
- [ ] A Send lands instantly while operator and lead are mid-conversation in the terminal;
      `agentParked` stays `true` throughout.
- [ ] The lead asks before disconnecting and never `/done`s on its own; operator silence keeps
      the line open.
- [ ] A forced session end leaves the board process, port, and lock up; the next `/whiteboard
      open` attaches and drains the waiting Send.
- [ ] The drawer's confirm-gated control posts a teardown-request (not a chat message), the
      supervise poll surfaces the teardown directive, and the lead performs the only agent-side
      `/done`; the natural-language fallback closes the same way.
- [ ] Shapes carry correct, immutable `createdBy`; the lead selects its own contributions from
      `meta` alone.

## Notes

- `LONGPOLL_MS` is hard-coded at 240s (`index.ts:42`); a `204` timeout is a re-arm, not a
  failure. The poller's `curl --max-time` is set just over it (~250s).
- The re-arm rests on three stacked guarantees, not agent memory (SPEC §8.5): the unmissable
  final-step relaunch after `/instruction-complete`, the boot/attach poller-liveness check
  (`/canvas-status agentParked`), and the durable-queue floor. If step 1.3 or 4 ever loses a
  Send, one of the three has a hole — that is the thing to chase.
- A `Stop` hook cannot own the listener: a hook-spawned process does not get the
  `run_in_background` wake-on-exit, so the listener must be the agent's own background job.
