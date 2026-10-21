# Picking work back up after an interruption

Read when a fetched Send carries `refetch: true`; after a context compaction or a failed fetch of
`/pending`; when the user is about to quit, or this session was resumed with a board open; and
when the board's server exits after it was up. Each section below is one of those moments. The
design spec (§4, §8.3, §8.5) is `docs/whiteboard/SPEC.md` in https://github.com/spencermarx/skills.

## A Send marked `refetch: true`

The Send was served to its recipient before and never completed, so it may be partly drawn. Its
work so far is among the shapes whose `meta.createdBy` or `meta.lastEditedBy` carries your
`name` (a restart or a revive can renew your `sessionId`, so match the name) with an `at` after
the Send's `at`. Perceive the board first ([`SKILL.md`](../SKILL.md) §2(b)), then draw only what
is missing. If you cannot tell what is missing, ask (§2(c)).

A Send stays open until its `POST /instruction-complete`, which you post once you have answered
or acted on the board, not when you receive it. So a Send left open when a session ends mid-draw
is served again to the next lead, and registering as the lead (§1 step 6) brings back any Send
the previous lead fetched and never completed.

## After a context compaction or a failed fetch

The board stays up through a compaction; it is the same process. A wait (§2(h)) whose answer was
lost, because the harness stopped the command or the connection dropped, counts as a failed
fetch.

1. Recover open Sends: `GET /pending?sessionId=<sid>&all=1` returns, besides unfetched items, the
   Sends you fetched and have not completed, each marked `refetch: true`. Handle each as above.
2. Re-read [`tldraw-editor-api.md`](tldraw-editor-api.md) before your next `/exec`.
3. If you act for a worker, re-read [`workers.md`](workers.md) first.

## The session ended

**Owned mode.** When this session ends, the board goes down with it, content and port intact:
the server writes its snapshot, removes its lock and exits within a few seconds, keeping
`<room>.port`. Any end of the harness process does this, including stopping the board's
background job (`harness-notes.md` lists Claude Code's cases). That is why stopping the job
takes the board down (content safe on disk) and why it is never a way to "restart" anything. The
user's tab shows the board closing and holds any Send typed meanwhile.

- **The user is about to quit:** tell them that opening the board again (`/whiteboard open
  <board>`, or asking for it by name) brings it back.
- **This session was resumed:** open the board yourself (SKILL.md §1). It boots on the recorded
  port, the tab reconnects and sends what it held, and the Sends left open come back to you.
- **The board's job exited while this session runs** (the job was stopped, or the server
  crashed): tell the user the board is down and that their tab holds any Send they type
  meanwhile. When they want it back, open it again, which boots it on the recorded port as above.

**Detached mode.** The server outlives the session that started it and keeps serving until the
user closes the board. Sends wait in its queue. A later session finds the board live in SKILL.md
§1 step 2: it is a guest unless it is the owner by session id, or the user tells it to take the
board over, in which case it registers as `lead` and gets the open Sends back. Before the user
quits, tell them the board stays up at `http://127.0.0.1:<port>` until they close it.

A close by `POST /done` differs from both: it warns every browser to export, flushes the
snapshot, stops the server and render-canvas, and removes both `<room>.lock` and `<room>.port`,
so the next open takes a fresh port. Tearing down a board someone is still editing loses their
unsynced edits, which is why only the user's explicit instruction authorizes it (SKILL.md §5).
