# Teardown

Teardown is commanded by the operator only, and there is exactly one agent-side
path to it. The lead never tears a board down on its own judgment.

## The rule

**A lead calls `POST /done` only on the operator's explicit instruction to close
this board.** No state counts as authorization on its own: not work that looks
finished, not a full board, not a request to move or switch a file, not silence.
Every teardown traces back to an explicit close: the confirm-gated teardown
directive, or an unambiguous "we're done, you can disconnect". When in any doubt,
ask and keep listening. Asking once more is free; tearing down a board someone is
still editing is not.

## What is not a teardown

An instruction that names a **file**, a **view** or **continued work** ("move the
board file into the repo and switch us onto it", "point us at the moved file") is
a keep-working instruction, the opposite of a close. Serve it with the server
left live.

**Moving a live board's file: copy, then switch in the panel.** The server writes
the live room to the board's `.tldr` within about two seconds of each change.

1. **Copy that file while the server stays up**, once the board has been still
   for a few seconds so the copy holds the latest edits:

   ```bash
   cp "<board file>" "<tracked/path>/<name>.tldr"   # the server stays up
   ```

   The board file is the `board` path `whiteboard.sh locate` prints. The copy
   must be inside the repository.
2. **To keep working on the copy, the operator picks it in the panel's board
   switcher**, which lists every `.tldr` in the repository. Tell them so in an
   `/agent-message`. The switcher moves the server, the render-canvas and their
   browser onto the copy together. The copy is a board of its own: its own room,
   lock and chat log in the boards folder, and the old file stays where it was.
   Finish and ack the Send you are working first, because the queue belongs to
   the room you are leaving.
3. **Commit the copy** whenever the operator wants. While the server hosts it,
   the server keeps writing the operator's edits into it.

Do not switch with `POST /board/open` yourself: it moves the server and the
render-canvas but not the operator's browser, which stays on the old room. Never
move the live file and reboot onto the new path: that is a teardown in disguise,
and it drops every connected peer's unsynced edits. Moving and rebooting is for
an explicit operator teardown only.

## The teardown directive

The panel's drawer has a confirm-gated close-session control. It posts
`POST /request-teardown`, which the bridge raises to the lead's supervisor poll as
a **teardown directive**, and `GET /canvas-status` reports
`teardownRequested:true`. On it the lead:

1. finishes any in-flight turn; never abandon a half-drawn Send;
2. posts a short closing `/agent-message`, so the operator sees the wrap-up;
3. runs the **pre-teardown gate**. `GET /canvas-status`, then:
   - **if you are a guest** (the lock's `ownerSessionId` is not your session id,
     or you did not boot this board), refuse: post an `/agent-message` asking the
     operator to close it from the owning session, and keep listening;
   - **if `humans` shows a peer you cannot account for** (you have worked solo
     but `humans > 1`), do not close silently: name what is still connected, ask
     the operator to confirm the close on this board, and keep listening;
   - otherwise the operator's close stands;
4. calls `POST /done`, which needs a JSON content-type:

   ```bash
   curl -s -X POST http://127.0.0.1:<port>/done -H 'content-type: application/json' -d '{}'
   ```

   It flushes a final snapshot to the board's `.tldr` if the board changed, warns
   every connected browser to export, and stops the render-canvas, the sync
   server and the board's lock, so no Chromium is orphaned and the next boot
   starts clean. Other boards' processes and locks are untouched.

Do not relaunch the poller after a teardown directive. A natural-language close
("we're done, you can disconnect") is honoured the same way, through the same
gate, since it is the fuzzier signal.

## Forced ends: tear down nothing

On a forced session end (compaction, context exhaustion, a turn limit) the lead
does **not** call `/done`. The board's server is a separate process from the
session and stays running. Report the resume coordinates instead: the board name
and `http://127.0.0.1:<port>`. The durable queue carries any Send to the next
session, and the next boot on that board attaches to the live server rather than
starting a rival.
