# Picking work back up after an interruption

Read when a fetched Send carries `refetch: true`; after an autocompaction or a failed fetch of
`/pending`; when the operator is about to quit, or this session was resumed with a board open;
and when the board's job exits after it was up. Each section below is one of those moments.
The design is [`SPEC.md`](../SPEC.md) §4, §8.3 and §8.5, and decision #64.

## A Send marked `refetch: true`

The Send was served to its recipient before and never completed, so it may be partly drawn.
Its work so far is among the shapes whose `meta.createdBy` or `meta.lastEditedBy` carries your
`name` (a restart or a revive can renew your `sessionId`, so match the name) with an `at` after
the Send's `at`. Perceive the board first ([`SKILL.md`](../SKILL.md) §2(b)), then draw only what
is missing. If you cannot tell what is missing, ask (§2(c)).

A Send stays open until its `POST /instruction-complete`, which you post once you have answered
or acted on the board, not when you receive it. So a Send left open when a session ends
mid-draw is rung again for the next owner, and registering as the lead (§1 step 6) rings you
for any Send the previous owner fetched and never completed.

## After an autocompaction or a failed fetch

The board stays up through an autocompaction; it is the same process.

1. Recover open Sends: `GET /pending?sessionId=<sid>&all=1` returns, besides unfetched items,
   the Sends you fetched and have not completed, each marked `refetch: true`. Handle each as
   above.
2. Re-read [`tldraw-editor-api.md`](tldraw-editor-api.md) before your next `/exec`.
3. If you act for a worker, re-read [`workers.md`](workers.md) first.

## The session ended

When this session ends, the board goes down with it, content and port intact. On `/exit`, a
kill, a crash, a `--resume`, `--continue` or update respawn (each a new Claude process), or a
`/tasks` stop of the board's job, the server writes its snapshot, removes its lock and exits
within a few seconds, keeping `<name>.port`. That is why stopping the job takes the board down
(content safe on disk) and why it is never a way to "restart" anything. The operator's tab
shows the board closing and holds any Send typed meanwhile.

- **The operator is about to quit:** tell them that `/whiteboard open <board>` brings the board
  back.
- **This session was resumed:** run `/whiteboard open <board>` yourself. It boots the board on
  the recorded port (SKILL.md §1), the tab reconnects and sends what it held, and you are rung
  for any Send left open.
- **The board's job exited while this session runs** (a `/tasks` stop, or the server crashed):
  tell the operator the board is down and that their tab holds any Send they type meanwhile.
  When they want it back, run `/whiteboard open <board>`, which boots it on the recorded port
  as above.

A close by `POST /done` differs: it warns every browser to export, flushes the snapshot, stops
the server and render-canvas, and removes both `<name>.lock` and `<name>.port`, so the next
open takes a fresh port. Tearing down a board someone is still editing loses their unsynced
edits, which is why only the operator's explicit instruction authorizes it (SKILL.md §5).
