# Workers: spawning, addressing and reviving them

Read by the lead before it spawns the first worker, on every `revive` item (§ Revival), and
when it acts for a worker after a compaction; and by each worker at spawn. A worker
is a tracked subagent that draws on the same board as its own cursor and takes Sends from
its own queue. A harness without subagents never spawns workers: the lead does the pieces one
after another. The lead's own loop is [`SKILL.md`](../SKILL.md) §2; the design spec (§4, §8.5)
is `docs/whiteboard/SPEC.md` in https://github.com/spencermarx/skills.

## The brief each worker gets

The worker did not load the skill, so its spawn prompt carries everything it needs to
start. Hand each worker:

- **its `clientKey`**, which is also its recipient id, for example `worker-2`, and a display
  name no other agent on the board uses, such as `Agent-2`, which a replacement keeps;
- **the bridge URL**, `http://127.0.0.1:<port>`, with the `<port>` you captured at boot;
- **its region**: the shapes or area it owns, disjoint from every other agent's;
- **what to read**: `<skill dir>/references/workers.md` § Worker loop, then
  `<skill dir>/SKILL.md` §2 steps (b) to (g), the read-act turn, and
  `<skill dir>/references/tldraw-editor-api.md`, the write API step (d) uses. Write
  `<skill dir>` as this skill's directory, resolved to an absolute path.

Keep the agent id or name the spawn returns. That is how you message the worker later, if your
harness can message a running subagent; its bridge `sessionId` is not, and it can change on
revival.

## Spawning

Spawn workers when one Send splits into independent pieces ("flesh out each box into a
subsystem"), or when the user asks. Each is a **tracked** subagent, never detached: a
detached one dies at run end and orphans its work. One lead and zero workers is the ordinary
case.

**Disjoint regions are a convention, not a lock.** The user can aim Sends at workers
independently, so the user keeps the convention as much as you do. Two agents on the
same shapes can clobber each other; `meta.lastEditedBy` keeps a clobber visible. `/exec`
calls are serialized on the one Editor, so concurrent writes never corrupt the store.

## Addressing

The panel's recipient box aims a Send at the lead (the default), a named worker, or
`everyone` (all workers). The recipient routes the Send straight to that agent's queue; the
lead never relays user input to workers. **Typing a new name does not create a worker.**
The bridge accepts `lead` or a `clientKey` that has registered on this board at least once (kept
after the worker dies and across a restart of the board, so a Send can wait for it), and answers
`400` for any other `recipient` on
`/message` or `for` on `/next-instruction` and `/instruction-complete`. `everyone` is a
broadcast keyword, never a valid `for`. A guest session (registered with `guest: true`) is
never a recipient: a Send to it gets a `400` (`recipient is a guest session`), and it is
never revived or included in a broadcast. A guest and a worker never share a key, because
the key's prefix says which it is: a guest's must start `guest-` and a worker's must not. A
worker registering on a `guest-` key gets a `400`
(`only a guest's clientKey may start with "guest-"`), so key workers `worker-N`.

## Worker loop

1. **Register** with your own key and transcript path (resolved as in SKILL.md §1 step 6):
   `POST /session/register {"name":"Agent-2","clientKey":"worker-2","transcriptPath":"<path>"}`
   returns your `sessionId` and gives you a cursor. The `clientKey` is stable across death
   and revival, so routing keys on it; re-registering on it keeps one cursor, in the same color.
2. **Self-park on your own queue**, in the foreground, carrying your `sessionId`, which the
   bridge requires: without it the fetch is a `400`, and with a `sessionId` that is not
   registered as your `clientKey` it is a `403`. Neither hands you anything.
   ```bash
   curl --max-time 250 "http://127.0.0.1:<port>/next-instruction?for=<your clientKey>&sessionId=<sid>"
   ```
   It returns `{ instruction, selection, id, at, for, broadcast?, refetch? }`. Your backlog
   comes first, oldest first, so a Send held while you were absent returns at once; the
   poll blocks only when the queue is empty. `refetch: true` marks a Send your key was
   served before and never completed: you, or a worker before you, may have drawn part of
   it, and [`interrupted-work.md`](interrupted-work.md) § A Send marked `refetch: true` says
   how to finish it, by your display name.
3. **Run the read-act turn**, SKILL.md §2 steps (b) to (g), on that Send, in your own region.
   Every bridge call carrying your `sessionId` renews your lease on the Send.
4. **Complete** with `POST /instruction-complete { id, for:"<your clientKey>", sessionId:"<sid>" }`.
   `sessionId` is required. `for` may be left out: it defaults to the key your `sessionId`
   registered on. A `for` naming no recipient of this board is a `400`. On an `everyone`
   broadcast, `broadcast:true` in the payload is the reminder that you complete only your own
   copy: another agent's key in `for` gets a `403`. Off a broadcast a valid `for` changes
   nothing, and completing another agent's Send gets a `403`. Neither `403` completes anything.
5. **Re-arm.** A `204` is a re-arm, not an exit: poll your own queue again.
6. **On a `403` saying your `sessionId` is not registered, re-register and carry on.** That
   `403`, from `/next-instruction` or `/instruction-complete`, most often means the bridge
   restarted. Repeat step 1 with the same `clientKey` and name, then retry the call that
   failed with the `sessionId` it returns. Your queue is intact: a Send that waited across the
   restart is the first one served. A `403` saying your `sessionId` is registered as your key,
   not another, is not a lost registration, and re-registering returns the same `sessionId`:
   the `for` you passed, or the Send you completed, is not yours. Take and complete only your
   own.

Wait only on your own queue: `/next-instruction` answers `400` for `for=lead`, no `for`, or a
key never registered on this board, and `403` for another agent's key. The doorbell rings
only the lead, never a worker.

## Revival

A subagent's lifetime is finite (a turn limit, a context compaction), so a parked worker can die
with a Send waiting. The Send is not lost: it waits in that worker's queue, and the lead
gets a `revive` item on `/pending`,
`{ kind:"revive", revive:"<recipientId>", name?, nudge }`: that worker has a pending Send and
no live self-park. SKILL.md §2(a) sends the lead here on every revive item, so a compaction
that drops this file loses nothing.

**What the lead does with a `revive` item, in the turn it arrives:**

1. If your harness can message a running subagent, message that worker, addressed by the
   agent id or name the spawn returned (never its bridge `sessionId`), with the item's `nudge`
   exactly as served (`harness-notes.md` says how in Claude Code). Never compose or paraphrase
   a nudge: it carries no Send text, and the worker pulls its own queue.
2. If it cannot be messaged, count your live subagents first (§ Scale), then spawn a
   replacement for the same `clientKey`, `name` and region with the brief in § The brief each
   worker gets, and end its prompt with the `nudge` exactly as served.

The server raises a revive only for a worker that holds no live lease on any of its pending
Sends and has made no bridge call for about 30 s, so a worker that is drawing, or waiting on
its own critic subagent, is never revived. After a revive, the same worker is not raised
again for 60 s while it comes back, and a revived worker keeps its cursor color.

**Relay served text, never composed text.** The `nudge` is keyed on the worker's
`clientKey` alone (its bridge URL, its key, "drain your queue") and is identical on every
revival whatever is pending. Test any nudge by asking whether its text varies with the
instruction; it cannot. The nudge carries no Send text, and the revived worker drains its
own queue with `GET /next-instruction`. A fresh-spawned replacement gets the same brief
(above), display name included, so its stamps carry its predecessor's name; it registers
on the same `clientKey`, which reclaims the routing key and the cursor,
and gets the same `nudge`, exactly as served, at the end of its prompt. The brief is fixed
text, so the replacement still receives no Send text.

All coordination goes through the bridge. Worker-to-worker messaging is unconfirmed, so the
lead is the only agent that nudges a worker.

## Scale

Design for 5 concurrent workers. The hard cap is your harness's limit on concurrent subagents
(`harness-notes.md` gives Claude Code's). Where resuming a completed subagent takes a fresh
slot, spawn, complete and revive churn can push the live count above what you expect: count
before you revive, and never assume a completed worker freed its slot.
