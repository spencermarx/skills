# Workers: spawning, addressing, reviving

When one Send splits into independent pieces ("flesh out each box into a
subsystem"), or the operator asks for it, the lead spawns worker subagents so
several cursors draw at once. Each worker is a subagent the lead tracks to
completion, never a detached process: detached workers die at the end of the run
and orphan their work. The single-agent case is just "lead, zero workers". A
harness without subagents never spawns workers; the lead does the pieces one
after another.

## Addressing

The panel's Send box carries a **recipient**: the lead (the default), a named
worker (by its recipient id), or `everyone` (a broadcast to all workers). The
recipient routes the Send; the lead supervises lifecycle and does not relay
human input to workers.

The operator can address only workers the lead has already spawned. The panel
lists them from the `agents` array on `GET /canvas-status`, and the bridge
returns `400` for an unknown recipient (`recipient` on `/message`, `for` on
`/next-instruction` and `/instruction-complete`). A valid id is `lead` or a
worker `clientKey` that has registered at least once; it stays valid after the
worker dies, so a Send can wait for a dead worker. `everyone` is the broadcast
keyword, not an id, and is never a valid `for`.

## Spawning a worker

For each worker:

1. It registers its own session with a stable `clientKey` that **is** its
   recipient id: `POST /session/register {name, clientKey, transcriptPath}` (for
   example `{"name":"Agent-2","clientKey":"worker-2"}`) → its own `{sessionId}`
   and cursor. The same string is what a Send is addressed to and what it polls
   for. It is stable across death and revival (a revived or replacement worker
   re-registers with the same key), so routing keys on it, never on the
   `sessionId`, which changes on revival. Registration is idempotent on the key.
2. The lead assigns it a **disjoint region or subtree**: workers never edit the
   same shapes. Because the operator can aim workers directly, the operator must
   keep to this too. It is a convention, not a lock; a clobber stays visible
   through authorship (`meta.lastEditedBy`).
3. It draws on the shared render-canvas with `POST /exec {code, sessionId,
   idempotencyKey}`, carrying its own `sessionId` so its cursor is attributed.
   `/exec` calls are serialised on the one editor, so concurrent writes never
   corrupt the store.

Give the worker, in its prompt: the bridge URL, its `clientKey`, its region, and
the read-act turn (SKILL.md, the loop's steps (b) to (g)).

## The worker loop: self-park on its own queue

A worker does not wait for the lead to feed it. After registering, it long-polls
its **own** queue in the foreground, carrying its `sessionId` (the heartbeat that
renews its lease):

```bash
curl --max-time 250 "http://127.0.0.1:<port>/next-instruction?for=<its id>&sessionId=<sid>"
```

The payload is `{ instruction, selection, id, at, for, broadcast? }`. The worker:

- drains its backlog oldest-first: the first poll returns any Send held for it
  while it was absent, and blocks only once the queue is empty;
- runs the same read-act turn as the lead, steps (b) to (g);
- acks with `POST /instruction-complete { id, for: "<its id>" }`. Passing `for` is
  mandatory: it completes its own copy, and for a broadcast `broadcast:true` in
  the payload is the reminder;
- treats a `204` as a re-arm, never an exit, and polls again.

A worker waits only on its own queue, never the lead's, and never with
`supervise=1`. Workers do **not** use the background poller: only the lead talks
to the operator in the terminal, so only the lead needs to listen while
interacting.

If a worker goes silent past the lease window mid-draw (a crash, a hang), the
bridge reclaims the Send on that worker's queue and redelivers it: at once to a
parked session for that recipient, or else it shows the worker as **stalled**,
which the lead's supervisor poll turns into a revive directive.

## The revival nudge

A subagent's life is finite (compaction, turn limits), so a parked worker can die
with work still on its queue. That Send is not lost. The lead's supervisor poll
returns `{ revive: "<id>", name?: "<worker name>", nudge: "<text>" }`, and in
**that woken turn** (never from inside a park) the lead:

- relays the directive's `nudge` text to worker `<id>` **verbatim**. The lead never
  writes or paraphrases a nudge. The bridge builds it from the recipient id alone
  (its URL, its `clientKey`, "drain your queue"), so it is identical on every
  revival and carries no instruction content: the queue stays the single source
  of truth, and the revived worker drains it itself;
- if the worker cannot be messaged, spawns a replacement subagent with the
  **same** `clientKey` and primes it with the same nudge.

How to message a running subagent differs by harness: see `harness-notes.md`.
All coordination goes through the bridge, never agent to agent: the lead is the
only agent that nudges a worker, and the Send, the worker's turn and the
completion all travel over the per-recipient queues.

## Scale

Design for 5 concurrent workers. The hard cap is your harness's limit on live
subagents (`harness-notes.md` gives Claude Code's). Count live subagents before
you revive one.
