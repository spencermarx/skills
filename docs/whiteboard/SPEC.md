# Whiteboard spec (v9.11, built on v9.10: **[v9.11]** the lead's Send delivery moves from a background long-poll the session had to relaunch on every wake to a **doorbell** on its own session inbox: the board server rings the owning session with a fixed, server-authored message, the lead pulls its work through `GET /pending` (the pull is the receipt), unfetched items re-ring and then read "not heard", and the board server becomes the owning Claude process's own child and exits with it (decision #64). Built on v9.9: **[v9.10]** orphaned-server busy-loop fix from the 2026-10-19 investigation — a board process that outlived its booting session wrote its next log line into that session's closed stdout pipe, and the unhandled `EPIPE` became an `uncaughtException` whose handler logged to the same dead pipe, a self-sustaining fault loop that pinned a core and starved the timer the graceful shutdown awaited, so the process never exited; v9.10 swallows stdout/stderr write errors so a lost log sink is never fatal, arms a hard exit deadline in `shutdown()` that runs the synchronous final snapshot and lock removal, and exits at once on a fault during shutdown (decision #63). Built on v9.8: **[v9.9]** whole-board export OOM/hang fix from the 2026-09-28 investigation — the uncapped whole-board PNG export rasterized every shape at the bitmap default `pixelRatio` 2 with no size or time cap, so on a ~244-shape board in a degraded headless Chromium (software swiftshader, post-suspend) it hung/OOM'd the renderer, leaving `GET /image` and every `/canvas-status` `lastExport*` field `null` while `browserUp` still read true, and v9.9 **size-bounds** the export to a downscaled bird's-eye (content/requested bounds scaled so the raster's longest side ≤ `EXPORT_MAX_PX` 2200, `pixelRatio` pinned to 1, every shape still visible) with an optional `GET /image?bounds=` full-detail region-zoom crop, **time-bounds** it on both sides (a 12s client `toImage` timeout below the 15s `WS_REQUEST_TIMEOUT_MS`, and `requestImage` recording `lastExportError` on a no-frame timeout), and makes the render-canvas **silently self-heal** on a Chromium disconnect/crash (nulling the handles so `browserUp` stops lying, then relaunching the room) — delivering the render-canvas self-recovery #61 deferred (decision #62). Built on v9.7: **[v9.8]** render-canvas stale-frame fix from the 2026-09-25 investigation — when the headless render-canvas's image export **fails** (a live-but-degraded Chromium, suspected WebGL/canvas context loss after a laptop suspend), the app uploads nothing and answers `export-image` with `{ok:false}`, but the bridge ignored the `ok` flag and resolved `GET /image` with the **stale last-good PNG path**, returning HTTP 200 + a frozen frame that an agent "verifying visually" read as current (decision #61). The fix is bridge-side: the image frame is ok/err **signalling only** (the fresh path comes solely from `POST /image-upload`, which the app awaits before signalling), a failed export **rejects** the waiter so `/image` returns **503, never a stale 200**, the `resolveImage` idx=0 fallback that could hand a waiter another request's path is removed, and `/canvas-status` gains export-health fields (`lastExportOk`/`lastExportError`/`lastExportAt`/`lastImageMtime`/`lastImageBytes`) so the stall is observable. Independent of #60 (that was a half-open socket on the message path; this is a live socket failing on the image path — same suspend trigger, separate mechanisms). Built on v9.6: **[v9.7]** lost-wakeup receipt-ack fix from the 2026-09-25 incident — the lead's delivered-marker was set on the server's **write** to a parked waiter, not on the consumer's **receipt** of the bytes; a Send handed to a **half-open socket** (the operator's laptop slept mid-poll, so no FIN reached the server and `req.on('close')` never fired) was stamped `deliveredAt`/`deliveredBy`+leased but never reached the lead, and because the lead lease is reclaimed only when the **session** is confirmed dead — the session re-armed and stayed alive — the Send was stranded `working` forever and skipped on every later poll, so the operator had to send a **second** message to get a response (decision #60). The fix adds a **consumer receipt ack**: the poller script sends a receipt-ack POST on a 200 **before it exits**, so a receipt that was **delivered but never receipt-acked**, whose holder **re-arms a fresh listener**, is *provably* lost (the poller re-arms only after its prior socket closed) and is **reclaimed and re-served** to that poll; a genuinely received Send (ack present) is spared, so no busy-loop. This inserts **receipt (consumer-confirmed)** between **delivery (write)** and **completion (handled)** in the lead's clockless model — still liveness-driven (the re-arm is a liveness event, not a timer), still at-least-once (never a strand — a *transient* missed ack costs a bounded redelivery, one and idempotent, terminated by completion), and lead-only (workers keep the `STALL_MS` lease). Because the ack is **load-bearing** (it, not just a nice-to-have, is what stops a re-arm re-serving an already-consumed Send — a *persistent* miss would redeliver every Send), the poller script does not rest it on a single tool: it prefers a `node` JSON parse and falls back to a POSIX grep/sed extraction when `node` is unreachable, and WARNs loudly rather than degrade silently. Built on v9.5: **[v9.6]** teardown-guard hardening from the board-teardown incident — a discretionary `POST /done` on a **shared, live** board disconnected a collaborator whose unsynced edits were lost, because the client keeps **no local persistence**. Four fixes: teardown **always** requires an explicit operator close and is never inferred from a file/migration/"switch" request (decision #59); the lockfile records the **owning session** (`ownerSession`/`ownerSessionId`) so a guest session can tell it did not boot the board and must not tear it down (#57); a live board's file is homed by **copy-then-switch** while the server stays up, never `git mv`+reboot (#59, §8.1); and the **root fix** — a client **disconnection banner** plus a `/done` **"server closing — export now"** broadcast make a disconnect loss **surfaced, never silent**: the client always warns before edits can be lost, regardless of why a disconnect happens (#58). Built on v9.4: every delivered Send leads with a fixed re-arm-first reminder that restates relaunch-first in-band, polling ~99% with Channels the zero-gap ceiling; **[v9.5]** a malformed `/exec` can no longer silently sever sync: a validate-first store-guard rejects a schema-invalid record before the crashing `store.put`, `ok:true` now means confirmed-present-in-the-room, and a server-owned harvest→reload→reapply auto-recovers a corrupted store and announces it)

**Port note.** This is the design record of the Aclarify Workspace's whiteboard skill as of
upstream commit `4274c79c` (v9.11), carried into this repository with workspace specifics removed.
It was written for Claude Code, and its mechanisms (the session inbox and canary, `run_in_background`,
`$CLAUDE_PID`, `$CLAUDE_JOB_DIR`, `SendMessage`, `/tasks`, `--resume`, autocompaction) are Claude
Code's. What this port does in other harnesses, and every other place it departs from upstream, is
in §9's **Port decisions**; where an older passage and a port decision disagree, the decision wins.

An operating brief for a Claude Code skill that stands up a **live, local tldraw
whiteboard** the operator draws on while **one or more Claude Code sessions read the
board and edit it alongside them**, in near-real-time. The felt experience is
*standing at a whiteboard with a coworker*: you sketch, you point, you say what you
want; they ask if unsure, draw on the same board while you watch, and point back at
what they did — and several of them can work at once, each a visible peer.

Status: **approved design, in build.** v1 was the single-agent POC. v2 folded in a
two-agent adversarial review (perception = JSON **+ screenshot**, `/exec`
verify-after-write, agent voice, selection-as-deixis, presence cursor, progressive-
disclosure reference). v3 replaced the single-canvas relay with tldraw sync so the
operator and multiple agent sessions are real peers on one board. v4 added persisted,
attributed chat history (model C) and one process per board. **v5 closes the three
gaps a real session exposed: (a) an operator Send is never silently stranded — the
instruction queue is durable and a "nobody's listening" state is loud; (b) the queue
survives a restart or a session that ended; (c) every object carries who made it, so
the board is sliceable by contributor.** Changes new in v3 are marked **[v3]**; v4,
**[v4]**; v5, **[v5]**. **v5.1** hardens delivery with a **lease / visibility timeout** so a lead
that crashes mid-draw (while the bridge lives) is recovered, and makes the panel's Send-lifecycle
signal honest (`queued → working → done`, or `stalled`) — the "no agent is listening" banner now
fires only when a Send is truly waiting for a lead, never while one is drawing it; marked **[v5.1]**.

**[v6]** adds a **hub-and-spoke model with addressable workers**, built on the v5.1
substrate rather than replacing it. One top-level agent, the **lead**, is the hub:
both an addressable drawing agent (the default **recipient**) and the **supervisor**,
the only thing that can spawn or revive the **worker** subagents it fans out to (the
spokes). One session tree per board, not many sessions on one board. The single Send
box gains a **recipient** selector: a named worker, the reserved `everyone` broadcast,
or the lead (the default, so the zero-worker case is unchanged). Each worker self-parks
by long-polling its **own** durable queue exactly as the lead does; because a subagent's
lifetime is not guaranteed, a Send addressed to a dead worker waits in that worker's
queue until the lead's **supervisor long-poll** returns a revive directive and the lead
resumes it with a **revival nudge**, whereupon the worker drains its own queue. The
lead→worker revival nudge is the only Claude-Code-messaging dependency; steady state is
bridge-native. Changes new in v6 are marked **[v6]**.

**[v7]** folds in a design review of the v6 hub-and-spoke as five
sharpenings that **harden the existing seam** rather than change the topology.
(1) The **lead-SPOF is reconciled as a stated non-goal**: a "supervisor *process*"
that revives *any* agent, the lead included, is **not buildable** — only a Claude
Code agent can spawn or resume a subagent, never a Node process (decisions #26,
#37) — so v6's floor stands (a Send to an ended lead waits, **loud and durable**,
for the next `/whiteboard open`). (2) The bridge's two jobs are named as an
**internal seam**: a **Router** (per-recipient projection + routing) and a
**lifecycle monitor** (health, lease sweep, revive-directive raising) — a
clarity/module split, **no behavior change**; "**supervisor**" is reserved for the
lead's *role*, the only actor that revives. (3) A recipient id becomes a **typed,
seam-validated `AgentId`**, not a bare string — validated at every seam against the
registry, an unknown id rejected. (4) Naming is **sharpened, not collapsed**:
**"agent"** is the actor (the lead and its workers), **"recipient"** the routing
target (an agent, or the `everyone` broadcast); "peer" is retired where it meant an
agent. (5) The revival nudge is made **structurally** payload-free: the bridge's
revive directive carries the **exact verbatim bootstrap text** and the lead sends
it as-is, so **no field can hold a paraphrase**. Changes new in v7 are marked
**[v7]**.

**[v8]** fixes a critical delivery bug a live session exposed: the in-app board
switcher (`POST /board/open`) did an **in-process room switch that stole the target
board's lockfile with no owner check**, so a second server on a board a first one
already hosted produced a **split-brain** — two processes serving one board, a parked
waiter on one and the operator's Send landing on the other, never meeting. The fix
extends the boot-time **one-server guard** (§8.3) to the runtime switch: before
switching in-process it confirms whether a **live foreign owner** already hosts the
target (lock `pid` alive **and** its port answers `GET /canvas-status` for that board),
and if so **attaches to that owner's port instead of stealing its lock**; only an
unowned or stale-locked board is switched-to in-process. The per-process message-store
cache (a related footgun that let two same-board processes diverge silently) is left
**fixed by prevention** — the guard makes two-on-one unreachable in solo-POC use, apart
from two claims at the same instant and a pre-#64 server's lock-less room, which a boot or a
switch now refuses to run beside (§8.3, #65).
v8 also lands the **operator-panel (drawer) redesign**: the always-open board list
becomes a **switcher button + popover** (killing the header/first-row crunch by
design), the boxy status strip + recipient `<select>` merge into one **collaborators
row of identity-colored avatars** where **tapping a collaborator addresses them**
(default lead, roster-bounded so no unknown recipient is reachable — #43), the chat
reads as a room (in-identity attribution, calm no-agent notice), and a real token
system carries light/dark, focus rings and 44px targets. **Agent cursors are dropped
from the operator UI** (agents draw via `/exec`, they don't glide a cursor); identity
**color** now rides the `agents[]` roster for the avatars. Changes new in v8 are marked
**[v8]**.

**[v9]** makes the lead **always-listening** and forbids the **premature hangup** a
live session exposed. The root cause is structural: board→agent delivery is
**pull-only** (no push), so the only "listening" state was a **blocking foreground
long-poll** — the lead could either listen *or* talk to the operator in its CC
terminal, never both, and the moment it left the poll to converse, the board-wide parked flag
flipped false and the operator's next Send sat undelivered at unbounded latency.
v9 fixes it **client-side only** (the server is unchanged): the lead runs its
`/next-instruction` long-poll in a **background job** that keeps a waiter parked
continuously, silently re-arms on each 240s timeout, and **exits only on a real
Send** — its exit wakes the session through the harness. The foreground turn ends
normally, so operator and lead keep conversing while a waiter stays parked
(**listen-while-interact**, decision #48). On top of it, a **stay-connected
invariant**: the lead never disconnects at its own discretion — when work looks
done it **asks** and keeps listening until an explicit operator yes (#49) — and
**teardown (`/done`) is operator-confirmed only**, with a **forced** session end
(autocompaction / context / `maxTurns`) leaving the board **process** up and
reporting resume coordinates rather than tearing down (#50). This removes the
latency #26 accepted **without** reintroducing the declined UDS push. One gap is
**recorded, not fixed**: Sends have no TTL, so a stale unacked Send pins the head
of the oldest-first queue and re-surfaces across sessions (#51). Changes new in v9
are marked **[v9]**.

**[v9.1]** settles the delivery mechanism and hardens the poll-loop lifecycle. The
v9 always-listening design was re-examined against Claude Code **Channels** (a
custom MCP server that *pushes* board events into the live session) as an
alternative to the polling background-waiter. **Channels was evaluated in depth and
deferred, not adopted (#52):** the delivery *guarantee* — a Send reliably received,
in order, and acted on — lives in the **durable per-recipient queue** (§8.5), which
**both** designs ride, so the wake (a channel push *or* a background-job-exit) is a
**best-effort nudge** in either case and polling **matches Channels on reliability,
consistency, and latency**; Channels' one edge (a listener decoupled from the CC
turn cycle) is not worth its research-preview cost for a solo, personal-account POC
(a non-persistable experimental launch flag every session, plugin/marketplace
packaging, an org `channelsEnabled` gate). So the **polling mechanism (#48) stands**,
now **hardened**: the poller is a **skill-owned Bash script** in one background job,
and its re-arm is made reliable by **three stacked guarantees** — an unmissable
relaunch as the first action on wake (**[v9.2]**, moved to the front of the turn),
a **boot/attach poller-liveness check**, and the **durable-queue floor** — rather
than by agent memory (#48 amended). The
operator's "you may disconnect" signal (#49/#50) is given a concrete channel: an
**explicit, confirm-gated app affordance** that posts a distinct teardown-request
the lead recognizes structurally, a natural-language Send as fallback (#53). The
`parseRecipient` seam is hardened to reject a malformed recipient rather than
silently default it to the lead (extends #43). Changes new in v9.1 are marked
**[v9.1]**.

**[v9.2]** sharpens v9.1's always-listening into a **hard requirement** and closes the mid-turn
gap it left open. The background poller is relaunched as the **first action on wake, before the
read-act turn** (immediate relaunch-on-receipt), so a fresh waiter is parked for the whole draw and
a Send arriving mid-act is caught rather than sitting until the turn ends (#48 amended). This rides
leases that are **already per-message** — the server's `inFlightByRecipient` Set (index.ts:822) —
so the lead can hold concurrent leases on two Sends and a relaunched poll is handed the *next*
pending Send, skipping its own in-flight one (`nextPendingFor`); the v9.1 "one lease-renewer at a
time, relaunch only between turns" serialization is dropped as unneeded. The one server change is
the **`STALL_MS` sweep now sparing a lease whose holder session has a live parked waiter** — keying
"stalled/absent" on a genuinely **ended** session rather than an idle lease, which is **both** the
false-"collaborator stepped away" fix and the deliberate-pause busy-loop fix. "Never stop
listening" is now hard, but polling reaches **~99%, not a literal 100%**: the wake still needs the
poller to exit and the harness to re-invoke, and the mid-act relaunch window is a real
sub-second-to-seconds gap **covered by the durable queue, not eliminated** — **Channels (#52)
remains the zero-gap ceiling**, unweakened, and polling stays the settled mechanism. Changes new in
v9.2 are marked **[v9.2]**.

**[v9.4]** lowers the failure rate of guarantee (1) — the relaunch-first re-arm (§9) — on the
drained-Send wake. The root failure it answers: delivering a Send **exits** the lead's background poller
(that exit IS the wake), so at the instant the woken session reads the body its listener is already
down; if the session then yields without relaunching, it goes idle while the durable queue silently
holds the next Send and the liveness signal reads a false *working* through the grace window (#55).
Guarantee (1) is the one guarantee that depends on **agent memory** (relaunch is a foreground action the
model must emit), so v9.4 puts the reminder **in-band**: `instructionPayload` stamps a fixed re-arm-first
directive as the **first field of every delivered Send** (index.ts, the `Instruction` type), so "re-arm
before acting" is the first thing read on every drained-Send wake. It is a **nudge, not a new guarantee**
— it lowers the odds of a missed re-arm but adds no new lossless floor; the durable queue (guarantee 3)
remains the only thing that makes a miss cost latency rather than a lost Send. The directive is
**content-free** (no Send text flows in) and **recipient-classed**, exactly like the revive nudge (#45):
byte-identical for the lead (relaunch the poller script) and byte-identical for a worker (re-arm its own
long-poll), so no paraphrase of the message can ride it. It rides only the drained-Send payload, and the
other two wakes are deliberately out of its scope for different reasons: a **teardown** directive carries
no re-arm-first and needs none (it skips the re-arm, §2), while a **revive** directive carries none *yet
still requires the relaunch* — that wake also exits the poller, so §2 step (a′) applies there too, but by
design it relies on the SKILL prose alone (the deferred `Stop`-hook, §9, would be its only structural
cover). So the revive wake, not the drained-Send wake this nudge covers, is the likelier remaining miss.
Changes new in v9.4 are marked **[v9.4]**.

**[v9.5]** closes a silent-corruption failure a live session exposed: a single malformed `/exec`
could **sever sync for the whole board without a word**. The mechanism is subtle. An `/exec` blob
that produces a schema-invalid record (the classic case is a geo shape with a top-level `w`/`h`
instead of under `props`) makes tldraw's editor call `store.markAsPossiblyCorrupted()` **inside**
the failing `store.put`, before the JS throw ever reaches the exec handler's existing try/catch.
That flag is **sticky, with no public reset** (`@tldraw/store` `Store.js:734-741`), and while it is
set `@tldraw/sync-core` (`TLSyncClient.js:175`) silently suppresses **every** outbound push even
though the socket stays connected. So the next well-formed execs return `ok:true`, render on the
render-canvas, and **never reach the room**: the board freezes at the poison point and every signal
still reads healthy. v9.5 answers it on three levels, none of which can restore the flag (there is
no reset to call): (1) **prevention**, a best-effort validate-first store-guard that rejects a
schema-invalid record cleanly (`ok:false` + the validation message) before it reaches the crashing
`store.put`, so the common blob never poisons the store, though it is not exhaustive for arbitrary
blob JS; (2) an **honest `/exec` contract**, where `ok:true` now means **confirmed present in the
room**: the server bounds-waits for the room's `documentClock`/shape-set to reflect the write and
reads the corruption boolean, per exec, so a severed write returns `ok:false` (a distinct
`sync-severed`) rather than a false success, and this same per-exec check **is** the detector; and
(3) **server-owned recovery**, an automatic harvest→reload→put-back. It clears the sticky flag by
rebuilding the render-canvas's store, writes into the room from the server what the corrupted
canvas changed and never sent, then **announces** what it did (an `/agent-message` and a panel line
naming what it put back). A **loop-guard** bounds it: max 2 reloads per incident plus a short
cooldown, all within one 30 s deadline, after which it stops and surfaces loudly rather than
reload-looping. **[v9.11]** The
put-back is the server's own room write, validated against the room's schema, so it never
re-poisons the canvas (decision #67). The launch/navigate
`verifyCanvasSynced` (a different, known boot race) is unchanged. The **sync-integrity invariant**:
an `/exec` that returns `ok` has reached the room; a corrupted store that a sync-health probe
reads is auto-recovered and announced, never silently dropped. Local to this skill; nothing is upstreamed to tldraw.
Changes new in v9.5 are marked **[v9.5]**.

**[v9.11]** retires the background listener. Eight of twelve delivery failures observed between
2026-09-22 and 2026-10-14 came from its lifecycle (a forgotten relaunch, a turn outrunning the
grace window, a two-hour kill, an orphaned poller, a half-open socket), and orphaned board servers
pinned CPUs after their sessions ended. The board server now **rings the owning session's inbox
socket** with a fixed doorbell that carries no Send text, the lead **pulls** its Sends, the
teardown item and revive items through `GET /pending` (that fetch is the receipt), unfetched items
**re-ring** on a bounded schedule and then show **not heard** in the panel, and every bridge
response the lead calls while drawing carries `pending: [ids]` so a mid-draw "stop" is picked up.
The server boots as the foreground of the session's own `run_in_background` job and **exits with
its parent Claude process**, saving the board; the next `/whiteboard open` restarts it on the same
port. An open-time **canary** proves the doorbell before the board is reported ready, and every
route checks Origin and Host. The worker self-park is unchanged. Changes new in v9.11 are marked
**[v9.11]** (decision #64).

The motivating failure (v5): a real operator Send was **silently stranded** — the
operator↔agent wake was pull-only (HTTP long-poll), the instruction queue was
in-memory, and when the sole consumer stopped re-arming the long-poll, nothing drained
the queue and nothing told anyone. v5 is the fix.

## 1. What this must prove

The proof-target is **the architecture**. By the end we can watch, live, on one branch:

1. The operator draws on a real tldraw canvas in their browser.
2. The operator **selects** the shapes they mean, types/dictates an instruction, and Sends.
3. **[v9.11]** Send **rings the lead's session inbox** with a fixed doorbell, which starts a
   turn in an idle session (or is read between tool calls in a busy one); the lead pulls the
   Send through `GET /pending` — an event, not a timer poll, and the operator's words never
   travel through the inbox (§8.5, #64).
4. The session **sees** the board (shape JSON **+ a rendered screenshot**), and can **ask
   a clarifying question in words** before acting.
5. The session **draws** onto the same board via `/exec`, **checks its own result** in a
   fresh screenshot, self-corrects once, and **points back** at what it changed.
6. The operator **watches**, in their own browser, a labelled agent cursor work and the
   changes appear live (via sync).
7. **[v3] Multiple agents at once.** The lead spawns worker subagents; each appears as its
   **own named cursor** and draws on the **same** board concurrently (disjoint regions).
8. The board **auto-persists** and can be **reopened** later.
9. **[v4] Chat history persists and is attributed.** Every operator Send and every agent
   utterance is retained; reopening a board (or reloading the panel) shows the full log,
   each line attributed to who said it — the operator, or a named agent session.
10. **[v4] Two boards run isolated.** A second board is its own process on its own port;
    neither can corrupt the other's `.tldr` or leak peers/messages across.
11. **[v5] A Send is never silently stranded.** The pending instruction is **durable**: it
    survives a restart or a lead that has ended, and is **drained in order** the next time a
    lead is on the board. **[v9.11 #64]** A Send the lead has not fetched is rung, re-rung on a
    bounded schedule, and then shown as **not heard** in the panel (and on `/canvas-status`) —
    the failure is loud, never silent, and it is per Send, not a board-wide flag. A Send typed
    while the board is down never reaches a store, so the operator's tab holds it as **unsent**
    and re-posts it under its own id, in the order typed, when it reconnects (§8.2).
12. **[v5] Every object carries its author.** Each created shape is stamped with **who made
    it** (the operator or a named agent) and **who last edited it**, so an agent asked for
    "the operator's contributions" / "agent X's" / "my own" answers straight from the
    board's data.
13. **[v6] The operator can address a specific worker.** The Send box carries a **recipient**
    selector; the operator picks a named worker as the recipient and **that** worker acts on
    the Send, not just the lead. The default recipient is the lead, so a board with no workers
    behaves exactly as v5, and the reserved `everyone` fans the Send to all workers.
14. **[v6] A worker stays reachable across turns.** A spawned worker self-parks by long-polling
    its **own** durable queue (its **per-recipient pending projection** over the message log)
    and remains addressable for the life of the session, turn after turn, not only for the turn
    that spawned it.
15. **[v6] A Send to a dead worker waits and is drained on revival.** A subagent's lifetime is
    not guaranteed; when the addressed worker has ended, its Send **waits durably** in that
    worker's per-recipient pending projection. The lead's doorbell rings and `GET /pending`
    hands it a `revive` item, the lead resumes the worker through `SendMessage` (by the agent id
    or name it got at spawn; fallback fresh-spawn) with a **revival nudge**, and the worker
    **drains its own queue in order**. Nothing addressed to a
    worker is lost.
16. **[v9] The lead listens while it talks, and never hangs up on its own.** The operator can
    Send **while actively chatting with the lead in the CC terminal** and the lead is rung for it
    (**[v9.11]** the doorbell, §8.5); the lead never tears down at its own discretion (it **asks**
    before disconnecting, #49); and **[v9.11]** when the session ends the board saves and stops
    with it, keeping its port in `<name>.port`, and `/whiteboard open` brings it back on that
    port, so the operator's open tab reconnects, a Send typed meanwhile is sent from the tab,
    and an uncompleted Send drains on re-attach — the operator is never hung up on (#50).
17. **[v9.5] A malformed `/exec` can never silently sever sync.** A poison exec (the classic being
    a geo shape with a top-level `w`/`h`) is rejected by the **validate-first store-guard** before it
    can trip tldraw's sticky corruption flag, returning `ok:false` with the reason. If a store does
    corrupt anyway, the **honest contract** catches it: `ok:true` means the write is **confirmed
    present in the room** (a per-exec server-side bounded wait on the room clock/shape-set plus the
    corruption boolean), so a severed write returns `ok:false`, and **server-owned recovery**
    (harvest→reload→put-back from the server, loop-guarded, then announced) restores the board and
    names what it put back. The sync-integrity invariant holds: an `/exec` that returns `ok` has
    reached the room; a corrupted store that a sync-health probe reads is auto-recovered and
    announced, never silently dropped (#56).

## 2. Acceptance scenario (the test we build to)

> On the branch, `/whiteboard` boots the sync server, the headless render-canvas, and opens
> the operator's browser on the room. The operator draws three boxes, **selects two**, types
> **"connect these left-to-right and add a store below the middle one"**, Sends. A labelled
> **"Claude" cursor** appears (thinking → drawing); the lead reads JSON + a screenshot, draws
> two bound arrows + a labelled `oval` store, inspects its own result, nudges off any overlap,
> **selects** what it added, and posts a one-line summary to the panel — all of which the
> operator watches appear **in their own browser** via sync.
> **[v3] Swarm check:** the operator types "flesh out each box into a subsystem"; the lead
> spawns three worker subagents; **three distinct cursors** ("Claude-1/2/3") appear and each
> elaborates one box concurrently.
> **[v4] Persistence check:** the operator closes the panel and reopens the board on a later
> run; the canvas **and the whole chat log** come back, every line still attributed to the
> operator or the agent session that wrote it.
> **[v4] Isolation check:** with the first board still live, the operator runs
> `/whiteboard new arch`; a **second instance** boots on its own port; both boards are
> editable at once and neither's file or room touches the other.
> **[v5, v9.11] Durable-delivery check:** the operator Sends and the lead does not fetch it
> (the session is busy elsewhere or cannot be reached). The doorbell re-rings it, and when the
> rings run out the panel shows the Send **not heard** and `/canvas-status` lists it so. When
> the lead fetches it, or on the next `/whiteboard open <board>` if the session ended, the lead
> **gets the pending Send in order** and acts on it — nothing was lost, nothing was silent.
> **[v5] Authorship check:** after the operator and one agent have each drawn, the operator
> types "select everything you drew, not what I drew"; the agent filters shapes by
> `meta.createdBy` and selects exactly its own, naming the count — answered from the data, no
> guessing.
> **[v6] Addressable-worker check:** with workers running, the operator sets the **recipient**
> to **"Claude-2"** and types **"redo the left subsystem"**; only **Claude-2's** cursor acts,
> while **Claude-3** keeps working the right concurrently. The operator then sets the recipient
> to **`everyone`** and Sends, and all workers act. Finally the operator addresses a worker that
> has **ended**; the Send is **held** in that worker's per-recipient pending projection and,
> when the lead is rung for the revive item and resumes the worker with a
> **revival nudge**, is **drained in order** and acted on — nothing addressed to it was lost.
> **[v9] Listen-while-interact check:** while the operator and the lead are **mid-conversation
> in the CC terminal** (the lead has asked a question and handed the turn back), the operator
> Sends again; **[v9.11]** the doorbell rings the lead, which fetches and acts on it without the
> operator having to re-launch anything. **[v9] No-premature-hangup
> check:** when the lead thinks the work is done it **asks** "can I disconnect?" and keeps
> listening; it never `/done`s on its own. **[v9.11] Session-end check:** the lead's session ends;
> the board saves and stops with it, keeping its port in `<name>.port`. A Send the operator
> types meanwhile shows "not sent: sends when the board is back". The next `/whiteboard open`
> from the resumed session boots it on the recorded port, the operator's tab reconnects and
> sends the held Send, and any uncompleted Send is rung again — no loss.
> **[v9.11] Doorbell check (the operator's dry run):** one draw Send, one "edit SKILL.md" Send,
> one "commit" Send, one mid-draw "stop" (picked up through the `pending` field), and one close,
> in a real session; the open-time canary fails loudly with `crossSessionInbound: hold`.
> **[v9.1] Operator-teardown check:** the operator presses the
> drawer's confirm-gated **close-session** control; the lead is rung for the **teardown
> item**, the lead posts a closing note and performs the graceful `POST /done` — the *only*
> agent-side teardown, and never fired without that explicit operator signal. **[v9.1] Recipient-guard
> check:** a `POST /message` with a **malformed** `recipient` (a bare string / bad `kind`) is rejected
> **`400`**, while an **omitted** recipient still defaults to the lead.
> **[v9.5] Sync-integrity check (a malformed exec can never silently sever sync):** the operator (or a
> test) sends a **poison** `/exec` (a geo shape with a top-level `w`), then a well-formed one. The
> poison returns **`ok:false`** with the validation reason and the store is **not** left corrupted; the
> well-formed exec **reaches the room** (its shape appears in the operator's browser and the persisted
> `.tldr` grows) and returns `ok:true` only once **confirmed present in the room**. If a store does
> corrupt, recovery **harvests, reloads, and puts back from the server** what the corrupted canvas
> never sent, posts a panel line **naming what it put back**, and the board resumes (#67); a canvas
> still corrupted past the loop-guard cap stops and surfaces a loud "manual recovery needed" rather than reload-looping. At no point does a later exec
> return `ok:true` while its shape is missing from the room.

**Real-time bar.** *Agent write → pixels on the operator's screen* is near-instant (sync).
*Operator Send → agent's first shapes* is dominated by the model's own turn, so the honest
bar is **"first shapes within a few seconds,"** not ≤2s. **[v9.11]** A Send to a **live** lead
rings it **immediately**, even while it is talking with the operator; mid-draw the ring waits
until the current tool call returns, but the `pending` field on the lead's next bridge response
carries it before the next draw call (the natural serialization of a coworker finishing a
stroke), and the durable per-recipient queue holds it meanwhile.

## 3. Architecture (v6)

**[v4] One Node process per board.** Each open board is its own process hosting the bridge
**and** the sync server, bound to `127.0.0.1` on an **OS-assigned ephemeral port**. The board
lives in a **sync room**; everyone — the operator's browser and one headless **render-canvas** —
joins it as a peer. Because a process serves exactly one board, the instruction queue and the
single render-canvas are correct as-is; isolation between boards is the process boundary itself.

**[v6] Hub-and-spoke with addressable workers.** One top-level agent is the **lead**: the hub,
supervisor, default recipient, and itself a drawing agent. It spawns N **worker** subagents, the
spokes. Each worker is a co-equal addressable session that long-polls its **own per-worker
queue** on the bridge; it is not a burst the lead fans out and relays. Steady-state messaging is
bridge-native: a Send routed to a worker lands at that worker's own `GET /next-instruction`, and
the lead is **not** in the per-message path. **[v9.11 #64]** The lead does not long-poll: the
board server **rings the owning session's inbox** with a fixed doorbell and the lead pulls its
items from `GET /pending` (§8.5). The server is that session's own child (booted with `exec node
--import tsx index.ts` as the foreground of a `run_in_background` job) and exits when the session
ends. One session tree per board.

```
                         ┌───────────────────────────────────────────────┐
                         │  Node process — ONE PER BOARD (127.0.0.1:<eph>)│
   operator's browser    │  ┌─────────────────┐   ┌────────────────────┐ │
   (a human PEER) ──WS───┼─►│  Sync server     │   │  Bridge (HTTP + WS)│ │
   draws, sees agents    │  │  TLSocketRoom     │   │  - per-recipient    │ │
        ▲                │  │  (authoritative   │   │    durable queues    │ │
        │ sync           │  │   board)          │   │    (proj. of msgs)   │ │
        │                │  │  persists .tldr   │   │  - long-poll: lead   │ │
        ▼                │  └────────▲──────────┘   │    + one per worker  │ │
   ┌─────────────────┐   │           │ sync         │  - /exec, /image,   │ │
   │ headless render- │──WS──────────┘              │    /agent-message   │ │
   │ canvas (our app, │◄───────WS (exec/shapes/image)┤  - presence inject  │ │
   │ Playwright)      │   │                          │  - message store +  │ │
   │ = agent eyes+hands│  │                          │    GET /messages [v4]│ │
   └─────────────────┘   │                          │  - doorbell + /pending│ │
                         │  writes <name>.lock [v4]  │  - /boards discovery │ │
                         └───────────────────────────┴─────────▲──────────┘ │
                                                                │ HTTP        │
                ring (inbox socket) + pull, or worker long-poll ┤
              ┌──────────────────┬───────────────────┬──────────┘
              ▼                  ▼                   ▼
   ┌────────────────────┐  ┌────────────────┐  ┌────────────────┐
   │ LEAD [v6, v9.11]   │  │ worker-1 [v6]  │  │ worker-N [v6]  │
   │ drawing agent,     │  │ GET /next-     │  │ GET /next-     │
   │ default recipient  │  │  instruction   │  │  instruction   │
   │ + supervisor:      │  │  ?for=         │  │  ?for=         │
   │ rung, then         │  │  worker-1      │  │  worker-N      │
   │ GET /pending       │  │ (own queue)    │  │ (own queue)    │
   └─────────┬──────────┘  └───────▲────────┘  └───────▲────────┘
             │                     │                   │
             └─ revival nudge [v6] ┴───────────────────┘
                (SendMessage-resume by id; fallback fresh-spawn)
```

- **Sync room = the board.** `TLSocketRoom` (`@tldraw/sync-core`) holds the authoritative
  document and replicates edits + presence to every peer. **[v5]** Shape `meta` (authorship)
  is an ordinary document field, so it rides sync and the `.tldr` snapshot natively.
- **Operator browser** joins via `@tldraw/sync` `useSync` — a real human peer with its own
  cursor; this is where the operator draws and watches. **[v4] It derives the server base URL
  from `window.location.origin`.** **[v5]** It also carries an **author identity** (name +
  stable key) passed in the URL, so shapes the operator draws are stamped locally.
- **[v3] Headless render-canvas** = *our existing app* in a **Playwright** Chromium page joined
  to the room. It is the agents' shared **Editor**: the bridge drives it over WS (`/exec`,
  `/shapes`, screenshot export). Its edits propagate to the operator via sync. One render-canvas
  per process (= per board).
- **Bridge** multiplexes: **[v6] a per-worker long-poll** (each worker draining its own durable
  queue), **[v9.11]** the lead's doorbell and `GET /pending` pull, the `/exec` relay, screenshot
  export, agent voice, discovery, per-session presence injection, **[v4]** the message store +
  `GET /messages`, **[v5]** the durable instruction queue (a projection over the message log,
  **[v6]** one pending projection per recipient, §4/§8.5), and it **launches the render-canvas**
  on boot and **writes the board's `<name>.lock`** and, **[v9.11 #64]**, its `<name>.port` (§8.3).
  It serves sync only for the room it hosts. **[v9.11 #64]** Every HTTP and WebSocket route
  checks Origin and Host: a loopback Host on the board's port, an Origin that is absent or the
  board's own, and a `Sec-Fetch-Site` that is absent, same-origin, none, or same-site on a
  top-level navigation — so a web page in the operator's browser cannot stamp a receipt on
  `/pending` or post a teardown. **[v9.11 #66]** Beneath that check, every route that changes a
  recipient's delivery state requires that recipient's own registered `sessionId`: `GET /pending`
  (the lead's), and `GET /next-instruction` and `POST /instruction-complete` (any recipient's), so
  a request that slips past the browser headers still cannot take or retire a Send.

**[v7] The bridge is two jobs behind one seam — the Router and the lifecycle monitor.**
The v6 bridge already does both; v7 **names the seam** (a documentation + light module
split, **no behavior change**) so the two concerns stop bleeding together:

- The **Router** owns *routing*: the per-recipient pending projection over the one
  message log (§8.5), `POST /message` intake, `GET /next-instruction?for=<AgentId>`
  handoff and `POST /instruction-complete`, the `/exec` relay, and the broadcast fan-out.
  It moves messages to the right queue; it knows nothing about who is alive.
- The **lifecycle monitor** owns *health*: per-agent parked/lease state (§7/§8.5), the
  `STALL_MS` sweep that reclaims a silent lease, and **raising a `revive` directive**
  when an `AgentId` has a pending Send and no live poller. It signals; it never acts.

The monitor **signals, the lead acts**: the monitor cannot spawn or resume a subagent
(no Node process can — §11), so it only *raises* the revive directive, which the lead's
doorbell rings for and `GET /pending` hands over as a `revive` item (§4, §8.5). "**Supervisor**" therefore names the **lead's
role**, the one actor that revives, and is **not** a bridge component — the bridge's
health half is the **lifecycle monitor**. (This answers the design review's "bridge = two jobs"
without a process split, which the CC runtime forbids; §11, decision #42.)

**[v7] Recipient ids are a typed, seam-validated `AgentId`, not a bare string.** The
registry of valid ids is `{ lead, everyone }` ∪ **every `clientKey` ever registered**
(§4). **[v9.11 #66]** The registry is per board and durable: `<name>.recipients.json` (§8.3)
records each worker key the first time it registers on that board, and the registry is rebuilt from
it, and from the worker recipients on the board's Send log, whenever the board is loaded. A restart
therefore forgets every session but no recipient, and a Send to a worker that has not yet
re-registered is accepted and waits in its queue. A worker session live on this process when a
switch brings it to another board is also accepted there. Because a worker's `clientKey` **is** its recipient id and is stable across death
and revival (§4, §9), an id stays valid after the worker dies — that is what lets a Send
wait for a dead worker (§8.5). Every seam that takes a recipient — `recipient` on
`POST /message`, `for` on `GET /next-instruction` and `POST /instruction-complete` —
**validates it against the registry and rejects an unknown id with `400`**. The panel
only offers spawned agents (§4, §7), so a `400` is a bug or a stale panel, never normal
flow — which is exactly the constraint worth catching. (Answers the design review's "convention vs
constraint"; decision #43.)

**Why a page at all (settled):** identity/presence is pure data and needs no page — the bridge
injects a named cursor per agent. The *only* thing needing a rendered page is the agent's
**screenshot** (and the Editor `/exec` ergonomics). So one shared render-canvas.

**Why one process per board, not one server for many (settled) [v4]:** the sync/persistence
layer is keyed per room, but the *hard, heavy* piece — the one Playwright Editor and its
serialized `/exec` — would be duplicated per active room anyway, and every endpoint would grow
session→room routing. A process per board gets full crash isolation and a private `.tldr` for
almost no code. "One server, many boards" is out of scope (§10).

**[v6] The only Claude Code messaging dependency is the lead→worker revival nudge.** Everything
in steady state is bridge-native and rides HTTP/WS off no Claude Code internal. Workers register,
long-poll their own queue, `/exec`, and speak, exactly as the lead does. The one place the design
touches CC messaging is reviving a dead worker: the lead `SendMessage`-resumes the worker by the
agent id or name it got at spawn, never the bridge `sessionId` (fallback: a fresh spawn), with a
bare **revival nudge**, and the revived worker then
drains its own durable queue (§4). This does **not** reintroduce the declined UDS coupling
described next. The nudge is sent by the **lead, an agent using a supported tool**, not by the
Node bridge, and it carries no payload (the queue stays the source of truth). The bridge still
never pushes to any session.

**[v9.11] The lead's own wake is a doorbell on its session inbox (#64).** The board server posts
a fixed ring to the owning session's inbox socket (the documented per-session inbox); the ring
carries no payload, and the lead pulls its work from the bridge (the queue stays the source of
truth). The server is the session's own child, so the inbox verifies the ring as the session's
own. This supersedes the background long-poll the lead used to keep parked.

**[v5] Why the bridge did not push to an unparked lead (declined then; superseded by #64).** The
only mechanism that could wake a *specific live local* session on the browser Send event is
injecting a `user` frame over that session's **undocumented internal UDS messaging socket**
(`/tmp/cc-socks/<pid>.sock` + a token; present in the CLI only as debug strings, no public
client). We **decline** it: (1) it couples load-bearing behavior to a Claude Code internal that
can change on any release; (2) it isn't even desirable — interrupting the agent mid-stroke is
worse UX than letting it finish and read the next note; (3) **[v9]** the gap before the loop
re-polls is now closed structurally, not by a push — the lead keeps a waiter **continuously
parked** in a background job (§8.5, #48), so there is no unparked-but-alive window to bridge. A
lead that has **ended** is provably unreachable by the Node bridge (its socket dies with the
process), so no push could serve that case anyway. The robust design is therefore **not a
push**: the re-arm discipline (§9) is made **structural** by a never-lapsing background waiter
(§8.5), the queue is durable (§8.5), "nobody's parked" is loud (§8.6), and the queue **drains
on the next open**. **[v9]** This closed the latency #26 accepted **without** adding coupling.
**[v9.11]** Superseded by #64: the inbox is now a documented per-session feature, and it carries
only a fixed doorbell (never the Send's content), so a ring cannot interrupt a stroke any more
than a note on the desk would; the pull, the re-ring and "not heard" keep the delivery honest.
See §11.

## 4. Multi-peer, sessions & presence [v3]

- **Lead + workers.** The operator talks to a **lead session** (the `/whiteboard` run); the lead
  is itself a drawing agent and the **default recipient**. For parallel work the lead **spawns
  worker subagents**; each registers with the bridge, drives the **shared** render-canvas, and
  **[v6] long-polls its own per-worker queue**, a co-equal addressable session rather than a
  fan-out burst the lead relays.
- **Per-session identity.** `POST /session/register {name, color?, clientKey?, transcriptPath?, guest?}`
  → `{ sessionId }`. The bridge injects a presence record into the room for that session (a named,
  colored cursor), so every human peer sees each agent distinctly. `/exec` and `/agent-message`
  carry the `sessionId`; the bridge attributes the cursor's motion/state to it. **[v5]** The
  `sessionId` (with the registered `name` + `color`) is also the **author identity** stamped onto
  shapes an agent's `/exec` creates (§8.6).
  **[v4] `transcriptPath`** is the caller's Claude Code transcript file (from
  `$CLAUDE_JOB_DIR/state.json.linkScanPath`, or built from `CLAUDE_CODE_SESSION_ID` + the recorded
  launch cwd). Recorded for attribution and the on-demand reconciler (§8); optional, never blocks.
- **[v9.11 #64] A guest is present, never addressable.** A second top-level session on a board
  another Claude process owns (§8.3) registers with `guest: true` and its own `clientKey`,
  `guest-<its Claude process id>` (`guest-${CLAUDE_PID:-$PPID}`, read in the Bash call itself),
  unique per process because two processes can share a session id (`guest: true` with no
  `clientKey`, or with `lead` or `everyone`, is a `400`). A guest and a worker never share a
  key, because the key's prefix says which it is: `guest: true` on a key that does not start
  `guest-` is a `400`
  (`a guest's clientKey must start with "guest-"`), and so is a worker registration on a key that
  does (`only a guest's clientKey may start with "guest-"`). The rule keeps no state, so it holds
  across a restart, which is when a dead worker's queued Sends are most exposed. Without it, a
  guest on a live worker's key would be handed the worker's session, and a guest on a dead
  worker's key would strand the Sends queued for it, which are never revived for a guest.
  Any `clientKey` containing `$`, `{` or `}` is a `400` (`clientKey must not contain $, { or }`):
  those characters mean a shell template reached the server unexpanded, as when the guest's
  `guest-${CLAUDE_PID:-$PPID}` sits inside single quotes, so the copy fails loudly instead of
  registering every such guest on one literal key.
  A guest gets a cursor and draws, and every
  roster entry the server sends the panel marks it `guest: true`, but it is excluded from the
  recipient registry, from revival and from broadcasts: the panel never offers it as a
  recipient, and a `POST /message` addressed to it is a `400` (`recipient is a guest session`).
  It is never rung, and its `/canary` is a `403` like any non-lead session's. This keeps #33's
  rule that a second top-level session is not a separately addressable agent.
- **[v5] Human author identity.** The operator is a native sync peer and does **not**
  `/session/register`. Their author identity (name + a stable `authorKey`) is resolved by the skill
  from `git config user.name` (falling back to `"Operator"`)
  and passed to their browser in the URL, so their locally-drawn shapes are stamped (§8.6). No bridge
  registration and no injected cursor is added for the human — tldraw already gives them a peer cursor.
- **Routing [v6].** A human Send now carries a **recipient**: the **lead** (the default), a
  **named worker**, or **`everyone`**. The bridge routes the Send into that recipient's
  **per-recipient pending projection** and hands it over at that recipient's own pull: a worker's
  `GET /next-instruction`, or **[v9.11]** the lead's `GET /pending` after its doorbell rings;
  `everyone` fans one copy into each live recipient's projection. Every
  recipient, lead or worker, drains its **own** queue, so the lead is no longer the single
  long-poll consumer and no longer relays human input to workers. (This is the co-equal
  human-addressable routing that v3 held out of scope in §10; **[v6]** supersedes that note.)

**[v6] Worker lifecycle.** A worker **self-parks** on its own durable per-worker queue (§8.5),
long-polling `GET /next-instruction` for its recipient. A subagent is
**finite**: its lifetime is undocumented and it ends on `maxTurns` or compaction, so a worker can
die with Sends still pending on its queue. Those Sends are not lost. They sit in the worker's
durable projection (each a `Message` with no `completedAt`, keyed to that recipient), and the
**lead revives the worker** to drain them. The dead worker's own queue is the single source of
truth; revival carries no message content.

**[v6] Supervisor.** The lead wears two hats: an **addressable drawing agent** (the default
recipient) and the **supervisor**. Only an agent can spawn or resume a subagent; no external
process, the bridge included, can. So the lead is the **sole lifecycle authority** for workers.
**[v9.11 #64]** The lead is rung for, and pulls through `GET /pending`, its **own Sends**, the
operator's teardown item, and **`revive worker-N` items** (raised by the **lifecycle monitor**, §3,
when a Send is pending for a worker that is not currently parked). On a revive item the lead **`SendMessage`-resumes the worker by the agent
id or name it got at spawn** (fallback: a fresh spawn) with a **revival nudge**; the revived worker then drains
its **own** durable queue, so the single source of truth is preserved and the lead never relays
the message content. Sibling→sibling subagent messaging is **unconfirmed**, so all coordination
routes through the bridge, never through CC messaging.

**[v7] The revival nudge is payload-free by construction, not by discipline.** In v6 "carries
no instruction content" was a **rule the lead had to keep** — and a real lapse this build proved
it breakable: a revival `SendMessage` **paraphrased** the operator's instruction into the nudge,
creating a second, divergeable source of truth beside the queue (safe only because the paraphrase
happened to match). v7 removes the *opportunity*: the `revive` directive the monitor raises
**carries the exact `nudge` text** — a **fixed bootstrap template parameterized by the recipient
`AgentId` alone** (its bridge URL, its `clientKey`, and "drain your queue"), identical on every
revival. The lead **sends that string verbatim**; it is **never handed the instruction**, so there
is no field to paraphrase *from*. The payload-vs-bootstrap test is: *does the nudge text vary with
the instruction?* Under v7 it cannot — it varies only with the `AgentId`. (Answers the design review's
sharpened #37; decision #45.)

- **Concurrency.** `/exec` calls are **serialized** on the one render-canvas Editor, so writes
  never interleave; two agents editing the **same** shapes can still logically clobber. **[v6]**
  The operator can now **aim workers independently** (recipient routing above), so
  **disjoint-region discipline is a convention the operator, not only the lead, must keep**; a
  clobber stays **visible via authorship** (`meta.lastEditedBy`, §8.6). A **soft region-lock**
  that makes the discipline enforced rather than conventional is a **fast-follow**. **[v5]**
  Serialization is also what makes per-`/exec` author-context stamping unambiguous (§8.6).
  **[v6] Scale:** designed for **5** concurrent workers, hard cap **20** concurrent subagents
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, ultracode-exempt). Resuming a **completed** subagent
  takes a **fresh slot without re-checking the cap**, so spawn→complete→revive churn can drift the
  live count above what a naive count expects (a caveat to watch, not gated this round).
- **[v3] Idempotency (driven over HTTP, retries happen).**
  - *Session identity:* `/session/register` is idempotent on a stable **`clientKey`** — a retry
    or reconnect with the same key returns the **same `sessionId`** and one cursor, never a
    duplicate. Presence records key by `sessionId` (upsert); unregister/remove is a no-op if gone.
  - *Writes:* `/exec` takes an **`idempotencyKey`**; a repeat of a completed key returns the
    cached result **without re-running the blob**, so a timeout-retry never duplicates shapes.
    The key cache lives in memory for at least 5 minutes and does not survive a restart, so it guards a
    retry, never a redelivery. **[v5]** What keeps the durable queue's at-least-once redelivery
    (§8.5) from doubling a drawing is the read-act turn: a Send its recipient was served before and
    never completed is served again with `refetch: true` (the lead's through `GET /pending`, a
    worker's through `GET /next-instruction`), and the recipient perceives the board first and
    draws only what is missing. Its work so far is among the shapes whose `meta.createdBy` or
    `meta.lastEditedBy` carries its `name` with an `at` after the Send's `at` (§8.6); its `sessionId`
    is new after a restart, and can be after a revive or a replacement, so the `name` is what
    matches, and the lead keeps every agent's name distinct (`workers.md`); when it cannot tell, it
    asks (`references/interrupted-work.md`, SKILL §2(c)). **[v9.11]** Shapes take fresh ids (`createShapeId()`), so no write lands on
    another draw's shape: tldraw's `createShapes` on an id that exists replaces that shape whole,
    so the render-canvas refuses it (§5). A shape that exists is changed with `updateShapes`.
  - *Messages:* `/message` and `/agent-message` accept an `idempotencyKey`. **[v4] For messages
    the key doubles as the message `id`** (§8): a repeat drops the duplicate (no double-post, no
    double-wake, no double-store), and the panel dedupes its optimistic echo by that same `id`.

## 5. Agent write mechanism — `/exec`

The session writes JS run against the render-canvas's live `editor` (unchanged from v2):

- **Tolerant execution.** Guard missing ids (a shape moved/deleted between read and write) —
  no-op, never throw the whole blob. **[v9.11]** A blob that does throw is not undone: what it
  wrote before the throw stays, though tldraw may roll back the writes of an `editor.run` the
  throw escapes, and its answer says it may have drawn (below). An undo
  to a mark set before the blob cannot be guaranteed (a throw inside `editor.run` after an
  awaited write, a blob that calls `editor.undo()` first, a `history: 'ignore'` write), and it
  would revert a peer's edit, made while the blob awaited, to a shape the blob had written
  (#64). The render-canvas sets a history mark before each blob, so undo is per exec (§10). A
  blob awaits everything it starts: a timer or an un-awaited promise it leaves behind is not
  stopped, and writes after the answer, stamped with whichever exec is running then, or none.
- **Prefer bindings / relative placement** over absolute coordinates captured earlier, so a
  nudged box drags its arrow. (Bound arrows also auto-route on every peer's screen.)
- **[v9.11] A create never lands on a shape that exists.** tldraw's `createShapes` on an existing
  id replaces that shape whole (`store.put`): props the call does not pass reset to their
  defaults, the shape moves to the top, and its `meta` is rebuilt. Another draw's shape, or the
  operator's, would be overwritten with `ok:true`. So the render-canvas's write guard refuses it,
  and `/exec` answers `ok:false` with `<id> already exists; change it with updateShapes`. Blobs
  give new shapes fresh ids and change existing ones with `updateShapes`.
- **[v9.11] A failed `/exec` says what it left.** Two answers, each with one meaning:
  - `200` with `ok:false`: the blob reached the render-canvas and may have drawn, in part or
    whole. The error ends `this blob may have drawn: read /shapes (what it wrote carries your name and an at no earlier than this answer's sentAt, in meta.createdBy or meta.lastEditedBy), then redo only what did not land and no one else has edited since, under a new idempotencyKey`,
    after the blob's own error, after `sync-severed` (below), or after
    `the render-canvas did not answer within <n> s, so` when the bridge sent the blob and the
    canvas did not answer within `WS_REQUEST_TIMEOUT_MS`. Every answer from a blob that was sent
    carries `sentAt`, the bridge's `Date.now()` just before it sent the blob. The server-owned
    render-canvas runs on the same machine and stamps `at` with its own `Date.now()`, so the
    stamps of what this blob wrote are no earlier than `sentAt`. A blob the canvas did not
    answer may still be running, so
    before it answers the bridge reloads the render-canvas, which ends every script on the
    page, and waits for the fresh canvas to rejoin the room: nothing the blob does lands after
    the answer, so the agent's read of `/shapes` is final, and no later exec's author is
    stamped on its writes. When the canvas still answers a sync-health probe and reads its
    store corrupted, the blob may hold writes the room never got, so the bridge runs recovery
    (below) in place of the plain reload: recovery's reload, or its hand-over to the launcher,
    ends the blob as well, and its harvest keeps what the store held when it was read. A
    recovery that did neither (it threw before reloading, for one) is followed by the plain
    reload. Whichever ends the blob has `CANVAS_NAV_TIMEOUT_MS`, counted from the
    timeout, the time the plain reload alone had before recovery ran on this path, so a page
    that stops answering part-way through costs the answer no more than it did then. A canvas
    that has not reloaded within it, whether its page is blocked or the time went on a recovery's
    reads, is handed to the launcher, which closes it, and perception answers `503` while it
    runs; a write it had not
    yet pushed to the room is lost, unless a recovery's harvest had read it, which the read
    after the relaunch shows. What did not land can be an
    update or a delete as well as a create, and an update that landed carries the agent's
    `name` in `meta.lastEditedBy` until someone else edits that shape; a shape whose
    `lastEditedBy` names someone else with an `at` no earlier than `sentAt` was changed by
    them since, so the agent leaves it. The answer is cached under the idempotency key for at
    least 5 minutes, whatever code a repeat carries, so a retry with the same key gets it
    again and never runs the blob a second time, and the corrected write goes under a new key.
  - `503`: the blob never reached a canvas (none connected, or the launcher is running a canvas
    for a board a switch has left, `render-canvas relaunching`). The key is dropped, so SKILL's
    one retry runs it.
- **Verify-after-write is a legibility GATE, not a single look [v4].** After `/exec` the
  render-canvas re-exports a PNG. Legibility (no clipped/overflowing text, no mid-word breaks, no
  content-hiding overlap, readable arrows/labels, nothing off-canvas) is a **gate the loop keeps
  correcting until it passes** (bounded to 3 rounds), distinct from an **aesthetic-polish cap**
  (one pass, then stop). The check is run by a **blind critic** — a tracked subagent handed only
  the PNG + the checklist, not the instruction or the exec code. See
  `references/legibility-checklist.md` and the geo-text sizing landmine in
  `references/tldraw-editor-api.md`.
- **Point back.** After drawing, `editor.select(...)` the shapes touched and post a one-line
  `/agent-message` naming them.
- **[v5] Authorship is stamped below the blob, not by it.** An `/exec` blob does **not** set
  `meta` itself; the app stamps `meta.createdBy` / `meta.lastEditedBy` from the exec's author
  context via an editor side-effect (§8.6), so authorship holds even for blobs that never think
  about it. A `meta` stamp a blob passes when it creates a new shape is replaced (§8.6, #68).
- **The exec scope exposes** `editor`, `createShapeId`, `createBindingId`, `toRichText` (the
  app injects them), so blobs use them bare as the reference shows.

**[v9.5] `ok` is a sync-integrity contract, not a local-render receipt.** A schema-invalid record
(the classic: a geo shape with a top-level `w`/`h` instead of under `props`) trips a failure path
that is worse than a thrown blob. tldraw's editor calls `store.markAsPossiblyCorrupted()` **inside**
the failing `store.put`, before the JS throw reaches the tolerant-execution try/catch above; that
flag is **sticky with no public reset** (`@tldraw/store` `Store.js:734-741`), and while it is set
`@tldraw/sync-core` (`TLSyncClient.js:175`) silently suppresses **every** outbound push while the
socket stays connected. Without this contract, later well-formed execs return `ok:true`, render on
the render-canvas, and never reach the room. Three levels answer it:

- **Prevention: a validate-first store-guard (best-effort).** The record is validated against the
  store schema and a schema-invalid one is rejected **before** it reaches the crashing `store.put`,
  so the guard returns `{ok:false, error}` with the validation message and the store is never
  poisoned. This is not exhaustive for arbitrary blob JS (a blob can still find a crash path), so it
  **reduces recovery frequency**; it is not itself the guarantee.
- **Honest contract: `ok:true` means confirmed present in the room.** After the exec relay returns,
  the **server** bounds-waits for the room's `documentClock`/shape-set to reflect the write and reads
  the store's corruption boolean, one sync-health round-trip to the render-canvas after every exec,
  whether or not the room moved, because a peer's change moves the room too.
  If the write is not reflected within the bounded timeout, or the store is corrupt, the exec returns
  **`ok:false`** with a distinct `sync-severed` error, never a false success. This per-exec check
  **is** the detector; the existing launch/navigate `verifyCanvasSynced` (a different, known boot
  race) stays.
- **Recovery: server-owned harvest→reload→put-back, then announce [v9.11].** Recovery runs in four
  steps when an exec comes back severed or corrupt, or goes unanswered on a store a sync-health
  probe reads corrupted. A recovery runs within `RECOVERY_DEADLINE_MS` (30 s, the time a reload
  of the canvas may take), counted from when it began, or on the timeout path from the timeout:
  every request it makes and every wait in it is bounded by what is left, so a page that stops
  answering part-way through costs one deadline in all, not one request bound per asset.
  1. **Harvest.** The server reads every document record in the render-canvas's store, on every
     page: its pages, assets, shapes and bindings. First it reads the room clock the canvas's store
     had caught up to (its sync client's `lastServerClock`), so every room change the records may
     lack is later than that clock. The app sends each asset's inline data (`props.src`, the image
     itself) as its SHA-256 digest, or whole on a page without Web Crypto. An asset the room holds
     the same, data included, is taken from the room, and any other is asked for whole, one asset
     per request, so the harvest's size does not grow with the images the room already holds. That
     answer carries the asset's record and no page shapes. An asset the harvest cannot take is
     left unread, with its cause:
     - `too large`: its record is more than a websocket message to the bridge may carry, 100 MiB.
       The bridge closes the socket on it, which fails the read at once, and the page reconnects
       about a second later;
     - `no answer`: the canvas did not answer within the request's bound or the recovery's time,
       or went down first. A canvas that leaves one asset unanswered is taken to have stopped
       answering and is not asked for the rest. The harvest reads only the canvas it began on: a
       canvas that goes down is closed with its launch generation, and one launched since from the
       room never held what the harvest is after, so once the generation has changed no asset is
       asked for, and an answer that comes after the change is not taken. A change before the
       canvas's list of records has come back fails the harvest, and the line says the corrupted
       canvas could not be read;
     - `unreadable`: the canvas answered without records;
     - `gone`: the asset was absent from a well-formed answer of the canvas that listed it, so
       that canvas removed it since, and the room does not hold it either. When the room does
       hold it, the room's copy is taken instead, and stays as the room holds it.

     The rest of the harvest goes on, the room keeps its own copy of an unread asset, if any, and
     the recovery is not recovered.
  2. **Reload.** The server reloads the page until a sync-health probe reads the store clean, at
     most twice, within the recovery's time. The reload is the only way to clear the sticky flag.
     A server-owned page whose reload fails or does not finish within the recovery's time, or that
     has no time left for one, is handed to the launcher, which closes it, ending whatever ran on
     it, and launches a canvas from the room. A canvas that crashes, or whose browser closes,
     during the recovery is already in the launcher's hands, and a reload waiting on it fails. A
     reload sent to a page that has just crashed can draw a late reply from Chromium that fails an
     assertion in Playwright's dispatch of Chromium's messages, which no caller can catch. An
     uncaught fault whose stack is whole and lies in Playwright and Node's internals alone, through
     that dispatch, is the canvas's (`server/canvas-fault.ts`), and the server keeps serving. Such a
     fault names no browser, and one the launcher has replaced can still be dispatching, so, as the
     `crash` and `disconnected` hooks ignore a replaced browser's events, the fault hands the canvas
     to the launcher only when the launcher is not running and the current canvas does not answer.
     That check is the launcher's own: the browser is connected, and the page answers an evaluate
     within 15 s. A page that crashes or closes during the check, or whose browser disconnects,
     reads dead when that happens, and one that does not answer reads dead at the 15 s deadline. A
     page that navigates while it is asked, as a reload does, drops the document the evaluate was
     sent to, and is asked again on the new one 250 ms after each ask a navigation drops, within the
     same 15 s; any other rejection reads the canvas dead when it comes. Any other uncaught fault
     still shuts the server down.
  3. **Put back.** The server writes into the room itself, in one storage transaction, what the canvas
     changed and never sent:
     - each harvested record the room lacks or holds a different copy of, written whole: pages and
       assets first, then shapes (a parent before what it holds), then bindings;
     - the removal of each page, asset, shape or binding still in the room that the canvas no
       longer held.

     A record the room changed after that clock keeps the room's version, because a peer (the
     operator or another tab) has moved past the harvest. So does a harvested record needing a page,
     parent shape, bound shape or asset that the canvas held and the room no longer does. A record
     needing one the room lacks because it did not go in (an asset left unread, a record the room's
     schema refused, or a record held back for either) is held back too. A record the canvas
     removed stays while a record staying in the room needs it in one of those ways, so a peer's
     change keeps what it needs, and the put-back itself leaves no record pointing at one the room
     lacks, other than as the canvas held it. A record written whole keeps the
     `meta.createdBy` and `meta.lastEditedBy` it was drawn with. Every client, the reloaded canvas
     included, receives the put-back as a remote change, so no app stamps it and it is on no
     canvas's undo stack.
  4. **Test.** Recovery counts itself recovered only when the canvas's store is clean **and** the room
     holds every record it meant to write and none it meant to remove, compared record by record,
     **and** the canvas a read of `/shapes` reaches shows the room as it stands after the put-back:
     no launcher is running, since perception answers `503` while one does, and the canvas's sync
     client's `lastServerClock` has reached the room's clock, so a read of `/shapes` made on the
     answer shows what was put back. A canvas whose sync client is not exposed counts as showing it. A
     cut-off create, update or delete of a page, asset, shape or binding, on any page, that is not
     in the room fails this test, unless step 3 left it to a peer's change or kept a removed record
     for one that needs it. An asset left unread and a record held back fail it too, and so does a
     canvas that has not caught up when the recovery's time runs out. A peer's change that moves
     the room's clock cannot pass it.

  Recovery then **notifies** the panel:
  - On success: `Recovered the board after <reason>. Reloaded the canvas and put back <counts> the
    corrupted canvas had not sent to the room.`, where `<counts>` counts each kind it wrote and the
    deletions, for example `3 shapes, 2 bindings and 1 deletion`. When it wrote nothing, it ends
    `the room was missing nothing.` instead, or `put back nothing.` when step 3 left or kept a
    record. Then, for the records left to a peer's change, `<counts> stay as the room holds them,
    after someone's change during the recovery.`, and for the removed records kept,
    `<counts> the canvas removed stay, because a record in the room needs them.`
  - When the canvas is still corrupted and not in the launcher's hands: `Manual recovery needed: the
    board could not be repaired after <reason> (<detail>). The canvas may be frozen. Reload it, or
    restart the whiteboard.`, where `<detail>` is `tried <n> time(s)`, `<n>` counting the reloads it
    began (1 or 2), or, where the server owns no page to hand to the launcher, `the recovery's time
    ran out before a reload could begin`.
  - When the canvas is still corrupted and in the launcher's hands (step 2): `Manual recovery
    needed: the recovery after <reason> could not reload the canvas: <what stopped it>, so the
    server is relaunching it from the room[, and <what>]. The last write may be missing from the
    board. Read the board and redraw what is missing.`, where `<what stopped it>` is one of:
    - `it did not reload within the <time> the recovery had left`, `<time>` in milliseconds under
      a second (`<n> ms`) and in seconds to a tenth from a second up (`<s> s`);
    - `the recovery's time ran out before a reload could begin`;
    - `its reload failed (<message>)`;
    - `it went down during the recovery (<cause>)`, when a launcher run began during the recovery;
    - `it was already being relaunched (<cause>) when the recovery began`, when the run under way
      as the recovery began is still the one running, or `it was still being launched at boot when
      the recovery began` when that run is the boot launch.

    `<cause>` is why the launcher started, as `page crashed`.
  - When a reload's sync-health probe read the store clean or went unanswered, but the harvest could
    not be read, or the put-back did not reach the room: `Manual recovery needed: the canvas was
    reloaded after <reason>, but <what>, so the last write may be missing from the board. Read the
    board and redraw what is missing.`
  - When the room holds the put-back but the reloaded canvas had not caught up with it in time:
    `Manual recovery needed: the room holds what recovery put back after <reason>, but the reloaded
    canvas had not shown it when the recovery's time ran out. Read the board again in a few seconds,
    then redraw what is still missing.` A read of `/shapes` made at once can still lack the put-back,
    which the room holds.
  - On either of the two lines above, when a launcher run that began during the recovery is still
    running at the answer, the canvas went down during the recovery, and the line says so before its
    last sentence: `The canvas went down during the recovery (<cause>), and the server is relaunching
    it from the room.` It may have gone down before the reload, which then reached the launcher's new
    page or none, so the first of the two lines then opens `Manual recovery needed: in the recovery
    after <reason>, <what>, so the last write may be missing from the board.` instead.
  - When the recovery itself throws: `Manual recovery needed: the recovery after <reason> stopped on
    an error (<message>), so the last write may be missing from the board. Read the board and
    redraw what is missing.`

  The `/exec` answer waits for the recovery and carries its outcome as `recovery: { recovered,
  text, missing?, why?, kept? }`. `text` is the panel's line. Once the put-back has run: when the
  board did not recover, `missing` lists the records the room does not hold as the canvas did
  (those it meant to write or remove, assets left unread, and records held back), and `why`
  gives each unread asset in it its cause from step 1; and `kept` lists the records step 3 left
  as the room holds them, those left to a peer's change and the removed records kept for one that
  needs them. An answer no recovery followed has no `recovery`. `references/exec-failures.md` is
  what an agent does with it. Decision #67, as amended.

The **sync-integrity invariant**: an `/exec` that returns `ok` has reached the room; a corrupted
store that a sync-health probe reads is auto-recovered and announced, never silently dropped. See
decision #56 and §11.

**The reference is a pointer, never memory [operator: progressive disclosure].** tldraw is
pinned at **5.4.2**; arrow bindings are **separate `binding` records via
`editor.createBinding(...)`**, not arrow props. `references/tldraw-editor-api.md` carries a
**small verified core** (smoke-tested at 5.4.2) plus **pointers** to the installed `.d.ts` and
tldraw.dev docs. **Acceptance check: the verified-core calls smoke-test green.** **[v3]** Add
`@tldraw/sync` presence APIs to what the reference points at. **[v5]** Add the `editor.sideEffects`
create/change handler API (verify against installed types).

## 6. Perception — JSON **+ screenshot**

Each turn the session perceives **both**: `GET /shapes` (JSON, for the **ids** to write
against) and a **rendered PNG** it `Read`s (for spatial judgment). Per-turn payload is **image +
a shape diff** since last turn (whole board on the first turn) to slow context growth. The
operator's **selection** rides on `/next-instruction` so "these/this" resolves to what is
selected. **[v5]** The `/shapes` JSON includes each shape's `meta` (`createdBy` / `lastEditedBy`),
so the agent can **slice the board by contributor client-side** — no server query is added; every
consumer already holds the whole document (agent via `/shapes`, humans via sync), so filtering is
a client-side projection on both sides (§8.6, §10).

### 6.1 Export integrity — a failed render never reads as a fresh frame [v9.8 #61]

The rendered PNG has exactly one producer: the headless render-canvas answering `export-image`. When
its `editor.toImage` throws or yields no blob (leading suspect: **WebGL/canvas context loss after a
laptop suspend** — a live-but-degraded Chromium, not a dead socket), the app performs **no upload** and
answers `{type:'image', id, ok:false}`. The invariant: **`GET /image` must never return a 200 pointing
at a PNG that was not (re)written for that request.** A stale frame served as success is worse than an
error, because an agent that "verifies visually" reads an old board and draws a false conclusion — this
already corrupted a legibility gate.

The **fix is bridge-side** (the app already signals `ok:false`): the `image`/`image-result` frame is
**ok/err signalling only, never a resolve-with-path**. The fresh path arrives solely from `POST
/image-upload`, which the app **awaits before** it sends the frame — so on success the waiter is already
resolved and the frame is a no-op, and on `ok:false` there was no upload, so the bridge **rejects** the
`/image` waiter (`rejectImage`) and the route returns **503 with the export error**. `resolveImage` and
`rejectImage` both match the waiter by **exact id only**; the former idx=0 fallback (resolve the oldest
waiter for an unmatched id) is removed, so a stray or mismatched frame under concurrent `/image` calls
can never hand a waiter a path meant for another request — an unmatched id resolves nothing and the
waiter times out honestly at `WS_REQUEST_TIMEOUT_MS`.

Export health is **observable in `/canvas-status`**: `lastExportOk` / `lastExportError` /
`lastExportAt`, and `lastImageMtime` / `lastImageBytes` from the last successful (re)write. The old
status was structurally blind to this (`connected` = WS open, `browserUp` = Playwright handle exists),
so a live-but-degraded render-canvas read as healthy. `lastExportOk` flips **false only on a genuine
export failure of a real `/image` request** — an `ok:false` frame that both carries an error *and*
matches an outstanding waiter, or a failed `POST /image-upload` write. Deliberately **not** counted as
a failure: an **empty board** (`ok:false` with no error — nothing to render, not a degraded canvas),
and a **stray or superseded** frame that matched no waiter (e.g. a post-`/exec` auto-export under a
different id) — either would make the signal cry wolf on a normal turn. One residual: two concurrent
`/image` calls where one fails and one succeeds can leave a transient `false` via last-writer-wins;
closing that fully needs per-request health, which is out of scope. **[v9.9]** The no-frame server
timeout (below) is now an additional writer to that same transient (it stamps `false`); this widens
the documented last-writer-wins window by one writer but does not create a new class, and it
self-corrects on the next successful export. **[v9.11 #64]** Beside the export fields, `relaunching`
reads `true` while the render-canvas is being launched or relaunched, the boot launch included, and
`/image` and `/shapes` then answer `503` (`render-canvas relaunching`) at once, so a `503` then means
the canvas is being repaired; the launcher always ends, so it returns to `false`
(§8.3 runtime switch, step 5). A launch that succeeds withdraws a `self-heal failed` the launcher
recorded earlier, so `lastExportOk`, `lastExportError` and `lastExportAt` read `null` again until the
next export. An `/image` `503` reading `no image produced` is an empty board, never a fault.

**[v9.9]** Render-canvas self-recovery — the piece left out of scope above — is now built (decision
#62), alongside the OOM cap this stale-frame fix did not address. The whole-board export is now
**size-bounded** (a downscaled bird's-eye: content or requested bounds scaled so the raster's longest
side ≤ `EXPORT_MAX_PX`, with `pixelRatio` pinned to 1, every shape still visible) and
**region-zoomable** (`GET /image?bounds=x,y,w,h` renders a full-detail crop; malformed/non-positive
bounds degrade to whole-board, never a 400; the JSON response **echoes the applied region** as
`{ path, bounds }` — `null` for a whole-board bird's-eye — so a caller can tell a dropped/typo'd
region from an honored one rather than silently reading the wrong frame); it is **time-bounded on
both sides** (a 12s client `toImage` timeout that in production must stay below the 15s
`WS_REQUEST_TIMEOUT_MS`, and `requestImage` recording
`lastExportOk:false` / `lastExportError` / `lastExportAt` on a **no-frame timeout** instead of the old
all-`null` signature); and the render-canvas **self-heals** on a Chromium disconnect/crash — the
`disconnected`/`crash` handlers (identity-guarded so a stale browser's late event can't tear down a
recovered canvas) null the browser/canvasPage handles so `browserUp` stops lying, then relaunch the
hosted room (**[v9.11 #64]** the board active when the relaunch finishes, §8.3 runtime switch) with a **bounded retry** (up to 3 attempts, 1 s and 2 s backoff, **[v9.11 #64]** each attempt bounded at 120 s and every wait on a Chromium inside it bounded, re-entry- and teardown-guarded; a
parked `/image` waiter is failed fast rather than left to time out, and a waiter still parked on
the page a switch's navigation replaced fails at once with `render-canvas switched boards; retry`,
recording no export failure). Recovery is **silent**
(server-log only, no panel line — a missed export beat is not worth a chat line), but an
**exhausted, unrecoverable** self-heal is **surfaced on `/canvas-status`** (`lastExportOk:false` +
`lastExportError`), the one deliberate break from pure silence [operator decision 2026-09-28,
amends #62: silent for a blip, attestable for a permanent death].
`render-stall.test.ts` proves the invariants against a fake render-canvas on an ephemeral
port (never the live board): a failed export returns 503 (not a stale 200), recovery returns a fresh
200, a mismatched-id frame resolves no parked waiter, two concurrent waiters each resolve to their own
frame, and an empty-board `ok:false` returns 503 without flipping health false. **[v9.9]**
`render-cap.test.ts` covers the **region forwarding** (a `?bounds=` crop forwarded verbatim on the
export-image frame) and the **no-frame timeout health** (an export that returns no frame records
`lastExportOk:false` with a timeout error), both by toggle against a fake render-canvas on an ephemeral
port (Phases A and B). **[v9.11 #64]** Its Phases C to L run the render-canvas relaunch against the
server's own real Chromium: C a renderer crash; D a failed navigation on a live browser; E a switch
during a relaunch; F a relaunched renderer that stops answering; G a switch during the boot launch;
H a renderer that stops answering during a switch's navigation; I a switch to an empty board,
healthy and with a renderer that stops answering; J a launch that succeeds after the launcher gave
up, and an `/image` parked when a switch navigates; K `/image` and `/shapes` made during a
navigation that freezes, and during a relaunch a switch stood aside for; L what a failed `/exec`
leaves: a blob that throws, which says it may have drawn and undoes no peer's edit, a write a
corrupted store cut off while a peer moves a shape, which answers `ok:false` and reaches the room
though the next blob is ended by a reload, a blob the canvas does not answer, which draws nothing
after its answer, so the missing shape the agent then writes is drawn once and carries no other agent's name, and an `/exec` made while the
launcher runs a canvas for a board a
switch left (§5). D, F, H, I, J and K use the
test-only
`WHITEBOARD_FAIL_NAV`, `WHITEBOARD_TEST_WEDGE_LAUNCH`, `WHITEBOARD_TEST_WEDGE_NAV` and
`WHITEBOARD_TEST_FAIL_LAUNCHES`, which the skill never sets. The app-side raster cap is not covered.

## 7. Presence [v3: real sync presence, per agent]

Presence is replicated through the sync room, so the operator sees agents in their own browser.
Each registered session gets a presence record (name + color); states over the WS `presence`
frame drive it: **idle / thinking / drawing**, and the cursor moves toward the shapes it creates.

**Verified constraint [v3, build finding].** A tldraw sync *client* (`TLSyncClient`) broadcasts
**exactly one** presence record and replicates only **document-scoped** diffs — so
`instance_presence` records written into the render-canvas's own store do **NOT** propagate to
human peers. Therefore **per-agent cursors are contributed server-side**: the bridge opens **N
lightweight presence-only sync clients** (one per registered `sessionId`), each broadcasting its
single cursor via the supported one-presence-per-client path (`server/presence.ts`,
`PresenceManager`). `presenceMode` must be `atom('full')` or post-connect presence updates
silently drop.

**[v6] Per-agent status is per-session, not one global flag.** Presence (the cursors above) still
rides the same server-side N-presence-only-sync-clients mechanism, unchanged. What generalizes is
the *listening* signal. In v5.1 "is a lead parked?" was one board-wide boolean meaning *any*
waiter exists. Under hub-and-spoke that question is asked **per agent**: is **this** worker
listening? **[v9.11 #64]** For the lead it is asked **per item**: each lead Send is rung, fetched,
done or not heard, and the lead's row (working / not-heard / queued / idle / absent) is read off
those items, never off a listener. So the bridge exposes a **per-session status** for the lead and every worker,
each carrying that session's **per-recipient parked** signal and its **per-recipient lifecycle
state** (§8.5). The panel renders these as a **per-agent status strip**, one row per agent, each
with a lifecycle badge:

- **queued** — the agent has pending Sends but is not yet leasing one.
- **working** — a Send is leased to this agent and it is live.
- **stalled** — this agent held a lease and went silent past `STALL_MS`; its Send re-queued.
- **absent** — no live session for this agent: never spawned, or dead. This is the state revival
  (§8.5) acts on. **[v9.11]** For the **lead**, "absent" means no lead session is registered;
  its other states are read off its items (working, not-heard, queued, idle), never off a
  listener.

A spawned, parked agent with an empty per-recipient queue reads as idle/listening — present, not
absent. **[v9.11 #64]** A guest's roster entry carries `guest: true`: the strip shows its
presence, and the recipient selector leaves it out (§4). The strip is driven by the bridge status signal, distinct from the sync cursors: cursors
show *where* an agent is on the board, the strip shows *whether* each agent is listening and what
it is doing.

## 8. Persistence & discovery

### 8.1 Board persistence (`.tldr`)

- **Format:** `.tldr` (native `RoomSnapshot`), reloadable into a room.
- **[v3] The sync server owns it:** `onDataChange` flags the room dirty; a ~2s interval writes
  `room.getCurrentSnapshot()` to the board's `.tldr`; a synchronous flush runs on shutdown.
  **[v5]** Shape `meta` is inside the snapshot, so authorship persists and reloads with the board.
- **Home:** the boards folder, `<scratch>/whiteboard/` (git-ignored; boards are runtime artifacts),
  which the server takes from `WHITEBOARD_HOME` (Port decisions, §9). Screenshots land here as
  `<name>.png`.
- **[v9.6] Homing a live board's file is a copy, not a move (decision #59).** Because the ~2s
  interval keeps the scratchpad `.tldr` **≤~2s-fresh**, a live board's file is homed into tracked
  storage by **`cp`-ing that snapshot to the destination while the server stays up** and committing
  the copy — the process, its port, its lock, and every peer are untouched. A `git mv` of the live
  file plus a reboot-onto-new-path is a **teardown in disguise** (it drops every peer's unsynced
  edits) and is reserved for an **explicit operator teardown**. This is the fix for the v9.6 incident,
  where a move-then-reboot was used to free a live file and disconnected a collaborator
  ([`references/homing-a-live-board.md`](../../skills/_incubating/whiteboard/references/homing-a-live-board.md), §11).

### 8.2 Message persistence & the panel read model [v4, extended v5]

The panel's chat log is durable, attributed, and rebuildable, on **model C** (settled): the
bridge's own append log of what crosses the seam is the **live source of truth**; the agent's
Claude Code transcript stays available only as an **on-demand rebuild/audit backstop**.

- **Capture at the seam.** Both message flows cross the bridge firsthand: the operator's Send
  (`POST /message`) and the agent's deliberate utterance (`POST /agent-message`). The bridge
  **stores each on receipt** — no live transcript parsing.
- **`Message` model** (flat, ts-ordered):
  ```
  Message {
    id:          string             // == the message idempotencyKey (one stable UUID)
    room:        string
    ts:          number             // epoch ms, server receipt time
    author:      { kind: "human" | "agent", name: string, sessionId?: string, color?: string }
    text:        string
    selection?:  string[]           // shape ids the human referenced (human Sends only)
    recipient?:  { kind: "lead" | "worker" | "broadcast", name?: string, sessionId?: string }
                                     // [v6] human Sends only; absent == the lead (default); broadcast == everyone
    deliveredAt? number             // [v5] set when handed to its recipient via /next-instruction (human Sends only)
                                     //   [v6] per-recipient for a broadcast — see the per-recipient delivery map, §8.5
    completedAt? number             // [v5] set when that recipient reports its turn done (human Sends only)
                                     //   [v6] per-recipient for a broadcast; "done" == all recipients complete, §8.5
  }
  ```
- **[v6] The recipient is chosen in the panel and rides the Send.** The panel's compose box carries
  a **recipient selector** (the lead, a named worker, or `everyone`). Its value stamps `recipient`
  on `POST /message`. Absent or `{ kind: "lead" }` addresses the lead — the default, so nothing
  changes for a plain Send. A named worker addresses that spoke directly. `{ kind: "broadcast" }`
  (`everyone`) fans the one Send into **every** worker's per-recipient pending projection (§8.5).
  The recipient is a routing target for delivery only; it does not change how the message is stored,
  attributed, or shown.
- **Store.** An in-memory per-room array serves reads; each message is also appended to a
  human-readable sidecar `<scratch>/whiteboard/<name>.messages.jsonl`, reloaded into memory on
  boot. This sidecar **is** the materialized store of model C — durable and rebuildable. **[v5]**
  Setting `deliveredAt` / `completedAt` **rewrites the message's line** (the store re-serializes,
  keyed by `id`); the JSONL is thus the durable record of both what was said and its delivery state.
  **[v6]** The sidecar line carries `recipient` and, for a broadcast, the per-recipient delivery map
  (§8.5), so routing and per-recipient completion survive a restart with everything else.
- **`GET /messages?room=<room>&since=<ts>`** → `{ messages: Message[] }`, ascending by `ts`;
  `since` omitted returns full history.
- **Freshness / live.** The panel `GET`s history on load or reconnect, renders it, then stays live
  over the WS push. **[v4] `/message` broadcasts a `message` frame to human peers** so a second
  browser and a reloaded panel both see human Sends. The panel **dedupes by `id`**. The panel's
  Send **generates an `idempotencyKey`** per message. **[v5]** A message-state change
  (`deliveredAt` / `completedAt`) also broadcasts a light `message-state` frame so the panel can
  render a Send's lifecycle (queued → delivered → done). **[v6]** Dedupe and render are otherwise
  unchanged; the `message-state` frame now carries the recipient so a Send's badge tracks the
  right per-recipient state, and a broadcast reports done only once every recipient completes.
- **[v9.11 #64] Sends leave the panel in the order typed, and one the server never stored says
  so.** The server orders the lead's work by when each Send arrives, so the panel sends every
  operator Send, held or new, and the close control's teardown request (below) through **one
  outbound queue**. One drainer posts one item at a time, in the order the operator created
  them, awaiting each; parallel posts could deliver "delete X" before "add X". Each POST times
  out after about 10 s and the timeout counts as a network error, so one hung POST (a half-open
  socket after a laptop sleep) cannot hold every later Send. The in-flight line reads
  "sending", and a line behind a POST that has not failed reads "waiting to send" (the
  client-only state **`waiting`**). On a network error, a timeout or a `5xx` the drain stops,
  and that line and every line behind it get the client-only state **`unsent`**, labelled
  "not sent: sends when the board is back"; a line reads that label only after a stop, and
  never reads "queued" until the server has stored it. A `4xx` gives that line the client-only
  state **`failed`**, labelled "not sent (<status>)", never retried automatically, and the
  drain continues, because a refusal is permanent. The drain runs on a new Send, on the close
  control's confirm, after each successful POST, at once on every events-socket reconnect
  (`onopen`), and on a retry timer: a drain that stops while the events socket stays open (a
  timeout or a `5xx` from a board that is up) has no reconnect coming to wake it, so it
  schedules its next attempt after 2 s, then 5 s, then every 10 s. A successful POST resets the
  backoff and turns the lines still held back to `waiting`; the socket closing cancels the
  timer, since the reconnect drains. Each drain re-POSTs every held line under its original id.
  Because the id is the message's `idempotencyKey` and `/message` dedupes on it, a retry never
  duplicates. The text box clears on Send; the line in the log is the operator's record. The
  retry depends on the board coming back on the same origin (§8.3).
- **Correlation.** The human Send's `id` is **threaded through the `/next-instruction` payload** to
  the agent, so it lands in the agent's transcript `tool_result`; the reconciler can later join a
  transcript entry back to its panel message, and the lead uses that `id` to mark `completedAt`.
- **Transcript backstop (specified, not built this round).** Given a session's `transcriptPath`
  the bridge could rebuild `<name>.messages.jsonl` from transcripts (an Anti-Corruption Layer over
  CC's JSONL projecting into the `Message` model). Off the demo path; built only when a
  recovery/audit need appears.
- **[v9.1] The operator teardown-request is a control signal, not a chat `Message`.** The drawer's
  confirm-gated **close-session** affordance (#53) posts a distinct request (a small dedicated
  intake, e.g. `POST /request-teardown`, not `POST /message`), so it never enters the attributed chat
  log or a recipient queue. The bridge holds a per-room **teardown-requested** flag, **[v9.11]**
  rings the lead and hands it over as a **teardown item on `GET /pending`** (§9). The item
  carries `at`, when close was first pressed, in epoch ms; a repeated press keeps the first time,
  so a Send whose `at` is later was typed after the close, and the lead handles it before closing.
  It is the same signal-not-act pattern as a
  revive directive: the bridge raises it, the **lead** performs the graceful `POST /done` (§8.3). It is
  the structural counterpart to a natural-language "you can disconnect" Send, which the lead still
  honors as a fallback. **[v9.11 #64]** The request goes through the panel's outbound queue (above),
  so it never overtakes a held Send, and a `room` naming a board this process does not host is a
  `409` (§8.3).

### 8.5 Durable instruction queue & delivery [v5; lease v5.1; doorbell and pull v9.11]

The instruction queue is **no longer a separate in-memory array** — it is a **read-model
projection over the message log** (§8.2), so there is **one source of truth** and nothing to keep
consistent between two stores. **[v6]** That projection is now **filtered per recipient** (the
**per-recipient pending projection**): the topology is one **lead** — the hub, the supervisor, and
the default recipient — plus N **worker** subagents (the spokes) it spawns, and each recipient
drains its own view. There are **not N physical queues**: there is one message log and N filtered
views over it, which is what preserves the single-source-of-truth of the **Durable queue**
decision as the design fans out.

- **[v6] Pending is per-recipient.** **Pending for recipient R = a human `Message` with
  `recipient == R`, no `completedAt`, and not currently leased.** A Send is pending for its
  recipient from the moment it is stored until that recipient reports its turn done. `deliveredAt`
  records that the recipient has taken it, `deliveredBy` which session holds the lease, but
  **delivery is not completion**. The lead's view is `recipient == lead` (the default); each
  worker's view is `recipient == that worker`; a broadcast is pending for every worker at once
  (see the broadcast bullet).
- **[v9.11 #64] Each recipient drains its own pending, oldest-first — the lead by a pull, a
  worker by its self-park.** The lead fetches `GET /pending?sessionId=<lead sid>` when its
  doorbell rings (below); a worker long-polls `GET /next-instruction?for=<worker>&sessionId=<worker sid>` on its own
  queue. Either way the recipient does its read-act turn, then
  `POST /instruction-complete {id, sessionId}` (for a broadcast, scoped to the calling recipient)
  stamps completion. **[v9.11 #66]** Both calls serve only the session registered as that recipient
  (missing `sessionId` `400`, not registered or another recipient's `403`, nothing taken or
  stamped). If a recipient **ends
  mid-draw** (a crash, or the owning session ending), its Send is never completed, so it is
  delivered again — the exact class of loss this exists to kill. One that was served before
  reaches its next holder marked `refetch: true`, because it may be partly drawn, and that
  recipient draws only what the board shows is missing rather than drawing it again (§4). For
  the lead this is drain on open: when this process loads the board, at start or on a switch
  back to it, a Send fetched before is marked. For a worker it is its delivery slot: a Send whose
  slot was served before (its lease reclaimed, or the server restarted, since a worker's slot
  keeps `deliveredAt` on disk) is marked when it is served again. The `/exec` idempotency keys
  cannot do this: they live in memory for at least 5 minutes and do not survive a restart.
- **[v9.11 #64] The lead is rung by a doorbell and pulls its work.** The board server rings the
  owning session's inbox socket (`$CLAUDE_CODE_MESSAGING_SOCKET`, read from the server's own
  environment, never over HTTP) whenever the lead has unfetched items: its Sends, the operator's
  teardown request (§8.2, #53), a worker that needs reviving, or the open-time canary (§9). Each
  ring connects fresh, writes `{"type":"auth","token":…}` and
  `{"type":"user","message":{"role":"user","content":<ring>}}` as two newline-terminated lines,
  and closes. The ring is **server-authored from validated fields only**:
  `whiteboard <board>: <n> pending (ring <k>, newest <ref>) for the /whiteboard skill. Fetch: curl -s 'http://127.0.0.1:<port>/pending?sessionId=<sid>'`
  — the board slug, the count, a ring counter, the newest item's id reduced to letters, digits and
  dashes, the skill that handles it, and the exact fetch command. **No Send text ever enters the inbox.** Pending items
  coalesce into one ring, with a minimum gap between rings. Rings go to the owner only, and only
  once a lead session is registered (the ring's fetch names it). **The skill fetches its own
  `/pending`, never a URL a message supplies:** the inbox cannot authenticate a sender, any
  session in the same permission mode can post a message in the ring's format, and what the
  fetch returns is treated as the operator's words. So the lead fetches on the port it captured
  at boot with its own session id; a ring says *when* to look, never *where*. The real ring always
  names `127.0.0.1:<port>` and the lead's sid, so pinning loses nothing. `/pending` checks only
  the sid, so a fetch needs no ring: the skill also fetches when the operator says they Sent
  something and after a failed canary, and a fetch that returns `{"items":[]}` means the ring was
  already answered (routine after a Send caught through `pending`).
- **[v9.11 #64] The pull is the receipt.** `GET /pending` answers at once and never parks. It
  returns every item the lead has not fetched, oldest first, in a fixed precedence: the canary,
  the lead's own Sends, then the teardown item, then revive items. Fetching a Send stamps
  `receivedAt` (with `deliveredAt`/`deliveredBy`), so a Send reads *fetched* only because the
  lead's own call took it — receipt comes from the consumer, never from a transport's write.
  Only the session registered as the lead (`clientKey` `lead`) may call it. `?all=1` also
  re-returns fetched-but-uncompleted Sends (marked `refetch`), the recovery read after a fetch
  whose response was lost or an autocompaction that dropped one from context. A Send drained on
  open that was fetched before (by the previous owner, or by this lead before it switched away
  and back) is marked `refetch` when it is fetched again.
- **[v9.11 #64] Re-ring, then *not heard*.** The inbox gives no receipt: it drops silently on its
  per-sender rate limit, on an identical body within a short window, on a full queue, and on an
  expired approval hold. So every unfetched item is **re-rung** about 30 s, 2 min and 10 min after
  its first ring (`WHITEBOARD_RERING_MS`), each ring with a new counter so the duplicate filter
  never drops it, and two minutes after the last re-ring (`WHITEBOARD_NOT_HEARD_AFTER_MS`) the item
  is marked **not heard** (reason `unanswered`). A ring that fails to connect (`ENOENT`: the
  session exited; `ECONNREFUSED`: it was killed) marks the items it named not heard at once
  (`inbox-unreachable`), a board with no inbox in its environment marks them `no-inbox` (in this
  port, `not-listening`, and only once no lead has pulled within `WHITEBOARD_PULL_GRACE_MS`: Port
  decisions, §9), and a later ring that lands clears either of those two. `/canvas-status` reports the doorbell: inbox
  configured, ring count, last outcome, the canary's state, and `doorbell.items`, each unfetched
  item as `{ id, state, reason? }` with `state` `queued`, `rung` or `not-heard`.
- **[v9.11 #64] Mid-turn pickup rides the bridge responses.** Claude Code shows an inbox message
  when the current tool call returns, never during one (observed on 2.1.292 in the dry run, where
  a mid-draw ring landed with the first `/exec`'s `pending`; undocumented, so the open-time canary
  re-checks delivery at every open). Idle, a ring starts a turn; mid-turn it waits for the call in
  flight, so a long `/exec`, a `sleep` or a critic subagent delays it and a ring cannot interrupt
  a draw. Every
  bridge response the lead calls while drawing (`/exec`, `/agent-message`, `/shapes`, `/image`,
  `/presence`) therefore carries `pending: [<ids>]` while the lead has an unfetched item, and the
  skill fetches before its next draw call when it is non-empty. The canary never appears there.
- **[v9.11 #64] Lifecycle states are per item.** For the **lead**: **queued** (no ring yet) →
  **rung** (the doorbell reached the inbox socket) → **fetched** (pulled; the panel shows
  "working") → **done** (completed), or **not-heard**. For a **worker**: **queued** →
  **working** (leased to that live worker) → **done**, or **stalled** (its lease expired,
  re-queued). The panel renders `state` directly (it never re-derives from timestamps), and
  `GET /messages` carries it. The lead's roster row (§7) is read off the same items: *working*
  while a fetched Send is uncompleted, *not-heard* while an item is not heard, *queued* while one
  waits, *idle* when a lead is registered with nothing pending, *absent* when none is. No
  board-wide listener flag exists.
- **Workers keep the per-recipient `STALL_MS` visibility timeout and its `stalled` state.** Workers
  are genuine competing consumers (many, revivable, no takeover event), so a delivered worker Send
  is a **lease** held by `deliveredBy` and renewed by every bridge call carrying that worker's
  `sessionId`. A periodic sweep reclaims any worker lease whose holder has been silent past
  `STALL_MS` (120s default) and has no parked waiter: the Send returns to pending for that worker,
  redelivered if it is parked or surfaced as *stalled* if it is not, which the lead's doorbell
  then rings as a revive item. The lead has no lease and no sweep.
- **[v6] Revival is done by the lead, never the bridge.** The bridge cannot spawn or wake a
  subagent; only an agent can. So when a **worker has a pending Send but is not parked** (no live
  long-poll for it), the bridge rings the lead with a **"revive worker-N"** item on `GET /pending`.
  **[v7]** That item **carries the exact `nudge` text** the lead must send — a fixed bootstrap
  template keyed only on the recipient `AgentId` (§4), so the lead relays a **verbatim** string and
  has no instruction to paraphrase. The lead revives that worker — **SendMessage-resume by the
  agent id or name it got at spawn**, falling back to a **fresh spawn** if the session is gone — with that **revival nudge** (no
  instruction content; just wake and self-park). The revived worker then re-registers on its `clientKey` and opens its own
  `/next-instruction?for=<worker>&sessionId=<sid>` and **drains its own pending**. **[v9.11 #64]** A revive is
  raised only for a worker that holds no live lease on any of its pending Sends and has made no
  bridge call for `REVIVE_QUIET_MS` (30s), so a worker busy drawing, or waiting on its own critic
  subagent while it holds Send 1 with Send 2 queued, is never revived (the lease sweep already
  decides when a lease holder is dead), and a guest is never revived (§4), and a revive grace window (`REVIVE_GRACE_MS`, 60s) keeps the same worker from
  being rung for again while it comes back. A revived worker keeps its original cursor color.
- **[v6] Broadcast (`everyone`) is one Message projected to N recipients.** Chosen over N
  recipient-stamped copies because it best preserves single-source-of-truth: there is exactly
  **one `Message` in the log** for the operator's one Send, and the per-recipient pending
  projection makes it appear in **every** worker's view. Per-recipient delivery, lease, and
  completion are tracked in a small **per-recipient delivery map** on that one Message (rewritten
  in place, as v5 already rewrites delivery state, §8.2). Each recipient **leases and completes its
  own entry independently** via `/next-instruction?for=<worker>&sessionId=<sid>` and
  `/instruction-complete {id, for, sessionId}`; **[v9.11 #66]** a session completes only the copy of
  the recipient it registered as, and `for` left out names that recipient.
  The broadcast reads **done only when every current recipient has completed** its entry; until
  then it is *working* (some in flight) or *queued* (some still waiting), and a worker that must be
  revived to reach its copy is surfaced the same way as any other unparked recipient.
  **[v9.11 #64]** A guest is never in a broadcast's recipients (§4), so a guest's presence never
  holds a broadcast open.
- **[v9.11 #64] Drain in order on open.** A board server belongs to one Claude process (§3), so
  each boot is a new owner: on load, every lead Send that is not completed is **unfetched again**
  (its receipt and doorbell record cleared), and registering the lead rings it for the whole
  backlog, served **oldest-first by `ts`** — the order the operator sent it. What the drain
  re-rings is what was stored: Sends a previous owner fetched but never completed, and Sends
  that arrived and were never fetched. A Send typed while no server was up was never stored; the
  operator's tab holds it as `unsent` and re-posts it on reconnect (§8.2), which rings the new
  owner then. Each worker's self-park likewise serves its own backlog oldest-first.
- **Live delivery for a parked worker.** When a worker is long-polling, a fresh Send addressed to
  it is handed over immediately (the waiter path), then follows the same complete-ack lifecycle.
- **[v9.11 #64] Why a doorbell, not the Send's text, and not a poller.** Every post into a
  session's inbox reaches the model framed as from another Claude session, "not typed by your
  user", with a standing refusal to edit permission settings, `CLAUDE.md` or config because a peer
  asked — the very requests an operator legitimately sends from a board. A ring asks only for a
  read of the session's own board, which that framing invites; the operator's words then arrive as
  the output of the session's own fetch. The earlier design, a background long-poll the session
  had to relaunch on every wake, failed in eight distinct ways in two weeks of use (decision #64).

### 8.6 Per-object authorship [v5]

Every shape carries **who created it** and **who last edited it**, stored in tldraw's per-shape
`meta` (`TLBaseShape.meta: JsonObject`) so it rides sync and the `.tldr` snapshot natively — no
side-table, no separate persistence.

- **Shape,** mirroring `Message.author` for codebase consistency:
  ```
  shape.meta.createdBy:    { kind: "human"|"agent", name, sessionId?, color?, at }   // stamped once, immutable
  shape.meta.lastEditedBy: { kind, name, sessionId?, color?, at }                    // rewritten on each edit
  ```
- **Stamped by an editor side-effect, in two surfaces feeding one synced store:**
  - **Agent shapes** are stamped on the **shared render-canvas**. Before running an `/exec` blob the
    app sets a module-level **current author context** = the exec's `sessionId` + its registered
    `name`/`color`; the `editor.sideEffects` create handler stamps `createdBy` from that context, the
    change handler updates `lastEditedBy`. Because `/exec` is serialized (§4), the context is
    unambiguous. A blob never sets `meta` (§5); a `createdBy` or `lastEditedBy` a blob passes when it
    creates a new shape is replaced by the exec's author.
  - **Human shapes** are stamped on the **operator's own browser**. Its `editor.sideEffects` handler
    stamps `createdBy` / `lastEditedBy` from the human author identity the skill passed in the URL
    (§4). No `/exec` and no bridge round-trip — the operator draws directly.
- **`createdBy` is immutable once stamped, and a copy is a new shape [v9.11 #68].** Each client
  keeps the set of shape ids it has held: those in its store when the editor mounts, and every
  id created since, from any source (a deleted id is one of these). A local create
  (`source === 'user'`: the operator's tab, or the render-canvas while an `/exec` runs) of an id
  outside that set is a new shape, and the create handler stamps both `createdBy` and
  `lastEditedBy` with the acting author, replacing whatever the record carried. tldraw's
  duplicate and paste copy a record whole, `meta` included, under a fresh id, so a duplicate, a
  paste, or a blob's create belongs to whoever made it, whoever drew the original. A cut and
  paste counts as a paste: the pasted shape takes a fresh id and belongs to the paster. A local
  create of an id inside the set is a restore (undo, redo, `moveShapesToPage`'s delete and
  recreate) and keeps the stamps it carries, filling in only one it lacks. The change handler
  carries `createdBy` across every later local write, so a write that rebuilds `meta` (a
  whole-record `store.put`) can neither erase nor replace it. A remote change is never stamped,
  recovery's put-back included, which every client receives as a remote change (§5, #67).
  `lastEditedBy` is rewritten on every content edit by whichever peer made it; a restore leaves
  it as it was.
- **Query is client-side, both consumers (settled, §6, §10).** The agent slices the `/shapes` JSON
  it already fetches by `meta.createdBy` / `lastEditedBy`; no `?author=` endpoint is added, because
  every consumer already holds the whole document. A human-facing **canvas legend/highlight** (pick a
  contributor → dim/highlight their shapes, using the `meta` already in the browser's synced store,
  zero server calls) is the right UX shape but is a **fast-follow, not built this round** (§10).
- **No backfill.** Shapes created before v5 have no author `meta`; that is honest (their true
  authorship is unrecoverable) and they read as unknown. Only new shapes carry authorship. The demo
  boards are disposable and cleared before the v5 demo, so in practice every shape is authored.

### 8.3 Multi-board: one instance per board [v4]

- **One process, one board, ephemeral port.** Each `/whiteboard new|open <name>` runs its own
  process on `127.0.0.1`; it reads the **actually-assigned** port off the listening socket.
- **[v9.11 #64] The board keeps its port: `<name>.port`.** The port is a fact about the board
  (the operator's open tab depends on it), the lock a fact about one process, so they live in
  two files with two lifetimes. After `listen` succeeds the server writes
  `<scratch>/whiteboard/<name>.port` = `{"port":<n>,"board":"<name>","pid":<server pid>,"at":<epoch ms>}`
  beside `<name>.lock`, recording the port actually bound. At boot it picks its port in this
  order: `WHITEBOARD_PORT` when set and non-zero (an explicit override, used by the tests);
  otherwise the sidecar's port when the file exists; otherwise `0` (ephemeral). `PORT` is never
  read, so a `PORT` exported by the operator's shell profile, which the agent's shell inherits,
  cannot move the board off its recorded port. If the recorded port is taken (`EADDRINUSE`) it
  falls back to an ephemeral port and rewrites the sidecar. The listening line ends
  `(recorded port)` only when the recorded port was bound. The skill never passes `WHITEBOARD_PORT`. Only `/done`, the operator's explicit close, removes
  the sidecar, and only when the sidecar names this server's pid; the owner watch, the signals, the shutdown deadline and a crash all leave it, so
  a reopen comes back on the same origin and the open tab reconnects.
- **[v9.11 #66] The board keeps its recipients: `<name>.recipients.json`.** A JSON array of every
  worker `clientKey` ever registered on the board (never `lead`, never a guest key), written
  whole (temp file, then rename) only when a key the board does not yet know registers on it. The
  server reads it when it loads the board, at boot or on a switch back, and adds every worker
  recipient named on the board's Send log, so a log written before this file existed still
  yields its workers. A switch's release drops the board's set with its Send log, and the board
  switched to accepts, besides its own recorded keys, a worker whose session is still live on
  this process.
- **[v9.11 #64] The server hosts one room, the one its lock names.** One check, `hosts(room)`
  (the room is the active room), guards the four routes a stale tab could act through: a `/sync/<room>`
  WebSocket upgrade, or a `role=human` `/events` upgrade, for any other room is refused with
  `404`, and a `POST /message` or `POST /request-teardown` whose `room` names any other board
  answers `409` `this server is hosting a different board` and stores nothing; a body with no
  `room` (curl, the tests) is unchanged. Agent and render-canvas `/events` connections are not
  room-checked. The `/events` guard, with a switch's release closing the operator tabs' event
  sockets (below), makes `humans` on `/canvas-status` count only tabs on the hosted board, so the skill
  skips opening a tab exactly when one is already on this board (SKILL §1 step 5). `GET /messages` stays open, since a read changes nothing; for a room
  this server does not host it reads the sidecar straight from disk and caches nothing, so it
  never takes that board's Send log into memory. A remembered port makes "an old tab reconnects to whatever now listens
  on its port" a routine event; without the check, a tab for board X that reached board Y's
  server would open a second live copy of X there, and two servers would write `X.tldr`. For
  the same reason the panel names its board (`room`) in every Send and close request.
  **An in-app switch releases the board it leaves at once**, as the step straight after its
  commit and before the render-canvas navigates (the runtime-switch bullet below), all inside
  `runExclusive`, so a switch never lands in the middle of an `/exec`. The server closes the
  previous room's sync sockets and its operator tabs' `/events` sockets, waits for any in-flight
  save, writes its snapshot once, drops it from memory and then removes its lock, pid-guarded.
  The board's Send log goes with it: its cached `<name>.messages.jsonl` and known recipients, this
  process's leases on its Sends and its teardown flag are dropped, so the lease sweep can never rewrite a log
  another server now owns. The board is therefore held for the milliseconds that release takes,
  never through a navigation. Until its lock goes, `/canvas-status` lists it in `held` while
  `activeRoom` names the new board, so another server's `claimLock` reads it as `releasing` and
  waits rather than taking it (below). A tab still on it is refused and shows the disconnected
  banner (#58), a second server may boot it once its lock is gone, and switching back reloads it
  from disk. On exit the server flushes and unlocks every board it holds, which outside a
  switch's release is the one it hosts: the graceful path first awaits any save still in flight,
  so an older snapshot never lands after the final one, and the hard-exit path stays
  synchronous. Every snapshot write, async and sync, goes to a temporary file in the board's
  directory, `<name>.tldr.<pid>-<n>.tmp`, and is renamed over `<name>.tldr`, so no exit path
  leaves a torn `.tldr`, which would read back as an empty board. A kill between the write and
  the rename leaves that temporary file behind, so at boot the server deletes every such file in
  the board's directory whose `<pid>` is dead; the pid in the name means it never removes a live
  process's write in progress. Without the sweep a board opened from the repo would gather
  untracked files beside it.
- **Lockfile = discovery + one-server guard.** On boot the process writes
  `<scratch>/whiteboard/<name>.lock` = `{ port, pid, parentPid, board, startedAt, ownerIsClaude, ownerSession?, ownerSessionId? }`,
  beside `<name>.tldr`. **[v9.11 #64]** The lock means one thing: a server holds this board now,
  serving it or, for the moment a switch takes, releasing it. It is removed on every graceful exit, and only by the server whose `pid` it names, so a
  dying server never removes the lock of a live server on the same board. Its jobs: (1) the next `/whiteboard` for that board reads it to find the
  running port and **attach**; (2) it stops a **second server process** from hosting the same
  board, through one helper, `claimLock`, which makes that check where the lock is written (below);
  **[v9.6]** (3) it records **whose** session booted the board, so a second session can tell it is a
  guest (below). It is **not** a session limit — any number of agent sessions and human browsers
  still share the one process.
- **[v9.11 #64] `claimLock`: the one-server check is made where the lock is written, and asks
  what the lock means.** It reads `<name>.lock`, and when the lock names another process's `pid`
  it probes that process. `GET /canvas-status` reports `pid`, the answering process's own, and
  `held`, every board whose lock names that process; `writeLock` and `removeLock` maintain
  `held`, so it includes a board being released after a switch. The probe answers one of four
  ways:
  - **`active`**: `/canvas-status` answered with the lock's `pid`, and `activeRoom` is this
    board. The claim is refused at once.
  - **`releasing`**: it answered with the lock's `pid` and `held` lists this board, but
    `activeRoom` names another. The owner is letting go of it.
  - **`unknown`**: the `pid` is alive but did not answer: the probe timed out, or failed with
    any request error other than a refused connection. A slow or paused owner is never read as
    gone.
  - **`stale`**: the `pid` is dead, the connection was refused, the answer is not a board
    server's, it reports another `pid` (the pid was reused), or `held` omits this board. Only
    this answer lets the claim write the lock.
  - **A server from before `pid` and `held`** answers `/canvas-status` with `activeRoom` alone.
    With no `pid` field the probe falls back to the older test: `activeRoom` naming this board is
    `active`, anything else is `stale`. Without the fallback such a server would read as `stale` and a claim could take a board it
    is still serving. At boot a server from before #64 never reaches this probe, because its lock
    has no `parentPid` and the boot has already exited 4 (attach vs boot, below), nor does the
    switch, which has already answered `409`; the fallback covers a server of this decision from
    before `pid` and `held`.

  The claim re-probes while the answer is `releasing` or `unknown`, for up to
  `RELEASE_WAIT_MS` (10 000 ms; `WHITEBOARD_RELEASE_WAIT_MS` overrides it), and refuses when
  the wait runs out. Waiting is safe because a switch releases its old board in milliseconds
  (the hosting bullet above), and refusing at the bound keeps a wedged owner from holding the
  claimant forever. Nothing is awaited between the last check and the write: a synchronous
  re-check (`readLock` and `kill -0`) runs immediately before `writeLock`, and it exempts a live
  `pid` only when the probe just answered `stale` for that same `pid`.
  It runs at both places a lock is written. **At boot** it runs before `listen`, so any wait
  happens before the port opens. It is logged once, at the first waiting answer, with a line
  that names the state: for `releasing`,
  `[bridge] board '<room>' is being released by pid <pid>; waiting up to <n> s`, and for
  `unknown`,
  `[bridge] board '<room>' is held by pid <pid>, which is not answering; waiting up to <n> s`.
  The `unknown` form never contains the exit line's "which does not answer", so the skill
  cannot mistake a wait for a refusal. Its synchronous re-check runs again just before the lock write in the listening handler. Each
  refusal exits 3 with exactly one of three lines on stderr, so the skill can tell them apart
  (SKILL §1 step 3):
  - `[bridge] board '<room>' is already served by pid <pid> on port <port>; not starting a second server`,
    when the owner is `active`. The skill returns to its step 2 once, which re-reads the lock
    and attaches; re-reading the lock is not a retry of the boot.
  - `[bridge] board '<room>' is still being released by pid <pid> on port <port>; not starting a second server`,
    when the wait ran out on `releasing`.
  - `[bridge] board '<room>' is held by pid <pid> on port <port>, which does not answer; not starting a second server`,
    when the wait ran out on `unknown`.

  On either of the last two the skill reports the line to the operator and does not retry,
  because the server has already waited the bound. With "which does not answer" it adds what
  `ps -p <pid> -o comm=` shows, so the operator can see what that pid is; removing the lock is
  their call. **In the switch** it is the first step of
  the transaction (the runtime-switch bullet below).
- **[v9.6] Owner identity in the lock (decision #57).** `ownerSession` (the human-readable CC
  session name) and `ownerSessionId` (the stable session id) are written into the lock (each only
  when non-empty). **[v9.11 #64]** The server resolves them itself from the environment it
  inherits as the session's child, and the resolution never fails: `ownerSessionId` is
  `WHITEBOARD_OWNER_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, else the `id` (or, as the file
  is written today, `sessionId`) in `$CLAUDE_JOB_DIR/state.json` when that file exists and parses; `ownerSession` is
  `WHITEBOARD_OWNER_SESSION`, else the `name` in that `state.json`. `CLAUDE_JOB_DIR` is set only
  for background-job sessions, which is why the lookup lives in the server: in the boot command,
  its absence in an interactive session would stop the command before `exec`.
  `/canvas-status` echoes them. **Ownership is a process, not a session id:** two Claude processes
  can share one session id (`--resume` or `--continue` in a second terminal), and the doorbell
  rings only the process that booted the server. So a second `/whiteboard` is the owner only when
  the lock's `parentPid` is its own Claude process (`${CLAUDE_PID:-$PPID}`, read in the Bash call
  itself, since a nested shell's `$PPID` names its wrapper); any other live owner makes it a
  **guest**, even when `ownerSessionId` matches. `ownerSessionId` stays for display and for
  recognising one's own board after a crash. A guest attaches and draws freely but must **never** perform a **destructive** act — no
  `POST /done`, no lock reclaim — on a board another session drives (SKILL §1 step 2, §5, decision
  #59). Every reader parses the lock **by field name**, so the added fields are backward-compatible
  (the sole in-process reader, `readLock`, still gates only on `port`/`pid`).
- **Attach vs boot.** Before booting, the skill reads `<name>.lock`. **[v9.11 #64]** The server is
  live when `pid` **and** `parentPid` are both alive and `GET /canvas-status` answers with
  `activeRoom` naming this board; then the skill **attaches**, as lead or guest (above). A server
  whose `activeRoom` names another board is releasing this one after a switch, and attaching
  there would reach a server that has left it. If `pid` is alive and `parentPid` is dead,
  the server is already exiting after its owner (within one owner-watch tick, about 2 s), and the
  skill waits for `pid` to exit and then boots; without that wait, a respawned session would join
  its own dying server as a guest. Any other lock, one with no `parentPid` included, sends the
  skill to boot, and the server decides. **[v9.11 #65] First, before any claim, the server looks
  for a live server from before #64 on any board.** It reads every `*.lock` in
  `<scratch>/whiteboard/` and counts a lock with no `parentPid` whose `pid` is alive and whose
  port either answers `/canvas-status` as a board server from before `pid` (an `activeRoom`, no
  `pid`) or does not answer within 1 s. A refused port, or any other answer, is a reused pid and
  does not count, nor does a lock with a `parentPid` or a dead `pid`. If any count, the boot exits
  4 before it binds a port or writes a lock, a port record or a board file, with one line on
  stderr naming each:
  `[bridge] board server from before #64 running: pid <pid> on port <port>, board '<board>'[; pid …]; not starting a server while one runs`.
  Such a server never exits with its session, and once its session's pipe has closed it may
  ignore SIGTERM (the `EPIPE` loop #63 fixes, which that server predates); after an in-app switch
  it keeps the board it left in memory with no lock, so no claim can see it there (the defect
  bullet below). The check covers the board being booted too, so a pre-#64 server on this board
  exits 4 rather than reaching `claimLock`'s "already served" exit 3: one path, whichever board it
  holds, and the in-app switch makes the same check (the runtime-switch bullet below). Stopping it
  is the operator's call, because another session may still be using it, so on exit 4 the skill tells the operator each pid, port and board, with what
  `ps -p <pid> -o comm=` shows, and, on their go-ahead, sends `kill <pid>`, then `kill -9 <pid>`
  if the pid is alive 5 s later, and boots again. If they decline, the skill neither boots nor
  attaches, because this version cannot drive a pre-#64 server and no board can boot while it
  runs, and tells the operator why. A lock the stopped server leaves behind names a dead `pid`,
  so the next boot proceeds. After the check, `claimLock` decides: a stale lock is reclaimed and a
  fresh instance boots, a board being released or held by an owner that does not answer is
  waited for and then claimed or refused, and a board another server serves is refused (exit 3).
  The board is on disk as of the stopped server's last 2 s persist; a board from before #64 has
  no `<name>.port`, so the new boot takes an ephemeral port and the skill opens a new tab.
  **[v9]** `/done` is **operator-confirmed only** (#50); it removes the lock and the
  port sidecar. **[v9.11 #64]** The process is the owning Claude process's child (`parentPid` in
  the lock) and exits with it: when that session ends it saves the board, removes its lock, keeps
  `<name>.port` and exits, so the next `/whiteboard open` boots a new owner from the snapshot on
  the recorded port and the open tab reconnects. Autocompaction keeps the process, so it removes
  nothing.
- **[v9.11 #64] The boot shape is checked, and a wrong boot fails loudly.** The skill boots with
  exactly `exec bash <skill dir>/scripts/whiteboard.sh start --board '<absolute path to <name>.tldr>'`, whose last step is `exec node --import tsx index.ts` (Port decisions, §9),
  which has nothing in it that can fail before `exec`. The server computes `ownerIsClaude`:
  `process.ppid === Number(process.env.CLAUDE_PID)` when `CLAUDE_PID` is set, `null` (unknown,
  never blocking) when it is not. It records it on the lock and on `GET /canvas-status`, and
  `POST /canary` answers `409` (`not booted as this session's child`) when it is `false`. The
  server's `npm start` prints `start the board with scripts/whiteboard.sh start, not npm`
  to stderr and exits 1, because npm would sit between Claude and node. A `WHITEBOARD_BOARD` that
  is set must be an absolute path ending in `.tldr` whose directory exists; anything else, an
  empty value included, exits before `listen` (exit 2 in this port, which also applies the
  placement rule: Port decisions, §9), with
  `[bridge] WHITEBOARD_BOARD must be the board's absolute .tldr path (got <value>)`. Unset keeps
  the default board. The check is the server's because the single quotes must stay (a
  repository's path may hold a space), and inside them an unfilled `<…>` placeholder reaches
  the server as literal text with exit status 0. Requiring the directory rather than the file
  keeps `new` working.
- **Command semantics.** `/whiteboard open <name>` requires the board to exist and attaches-or-
  boots; `/whiteboard new <name>` **errors if `<name>.tldr` already exists**.
- **[v8] The runtime board-switch honors the same guard.** The in-app board switcher (`POST
  /board/open`, `POST /board/new`) is the boot-time attach-vs-boot rule's runtime twin. Before it
  switches this process to another board in-process, it checks for a **live foreign owner** (a
  lock whose `pid` is alive **and** whose port answers `GET /canvas-status` for that board). If one
  exists it **does not switch** — it returns `{ attach: true, port }` and the browser navigates to
  that owner's port; only an unowned or stale-locked board is switched-to in-process. Without this
  the switch stole the target's lock unconditionally, producing a **two-processes-on-one-board
  split-brain** (a parked waiter on one process, the operator's Send on the other, never meeting).
  **[v9.11 #64] The switch is a transaction: it commits, or changes nothing.** All of it runs
  inside `runExclusive`, so it runs after any `/exec` queued ahead of it:
  1. **Prepare.** **[v9.11 #65]** First the boot's check for a live server from before #64 on any
     board (attach vs boot, above), through the same helper, `findPre64Servers`. If it finds one,
     the switch answers `409` with
     `{ error: "board server from before #64 running: pid <pid> on port <port>, board '<board>'[; …]; stop it before switching boards", oldServers: [{ pid, port, board }, …] }`
     and claims and releases nothing: the server still hosts and holds only its board, and the
     target gets no lock and no port record. The panel shows that `error` in the switcher, as it
     shows every refused switch's. Once that server has exited, its lock left behind, the switch
     proceeds. Then `claimLock` (above) claims the target's lock. An `active` owner, such as a
     server that booted the target while the switch waited, answers
     `{ ok: true, attach: true, port, path, room }` and is never robbed of its lock. A wait on
     `releasing` or `unknown` that runs out answers `409`
     `board is being released by another server; try again`, or, for an owner that does not
     answer, `board is held by another server that does not answer; try again`. The target board then loads inside a `try`; a load that fails, such
     as a snapshot `TLSocketRoom` cannot read, releases the lock just claimed (pid-guarded) and
     answers `422` `board cannot be loaded: <reason>`. On any `409` or a `422` nothing else has changed, and the
     panel stays on its board and shows the error.
  2. **Commit.** `activeRoomId` moves to the target, with the fields that follow from it.
     Nothing after the commit can throw: writing the port record and rebuilding the agent
     cursors are each logged on failure and the switch goes on, so the board left is always
     released.
  3. **Release the old board at once** (the hosting bullet above), before anything navigates.
  4. **Answer** `200 { ok: true, attach: false, path, room }`; the panel follows `room`.
  5. **Navigate the render-canvas** to the new room. A navigation that fails is recorded as
     `lastNavError` on `/canvas-status` and hands off to the render-canvas launcher
     (`handleRenderCanvasDeath`). It is the only launcher: the boot launch goes through it, and
     so does every relaunch: after a crash, a disconnect, a failed navigation, a page handed over
     because its reload failed, did not finish, or had no time to begin (§5), or a fault in
     Playwright's dispatch of Chromium's messages (§5, recovery step 2). While it runs,
     `/canvas-status` reads `relaunching: true` and a switch's own navigation stands aside; a
     switch that finds no canvas to navigate records `no render-canvas to navigate` and hands
     off to it in the same way. The launcher closes the old browser, then makes up to three
     attempts, 1 s and 2 s apart. It always ends, because every wait on a Chromium in it is
     bounded (a call at 15 s, a launch or navigation at 30 s, the old browser's close at 3 s),
     and each attempt at 120 s; a canvas that does not answer, or does not connect its bridge
     socket, counts as a failed attempt. After the third it stops and records `self-heal failed`
     in `lastExportError`, and a later launch that succeeds withdraws it. Each attempt launches
     into the board active at that moment, and succeeds only when the canvas answers, its bridge
     socket is connected, and that board is still the active one; if a switch committed during the launch, it closes
     that browser and relaunches into the new board without spending an attempt. Every attempt
     and every close bumps a launch generation, so an attempt given up on acts on nothing newer,
     and a launch that finishes after its attempt was given up closes its own browser. The
     canvas therefore ends on the active board, with one Chromium serving it plus at most one
     being closed: a browser that has not closed within 3 s is left to Playwright, which kills it
     within 30 s. A successful relaunch clears `lastNavError`. Until the canvas is back, `/shapes`,
     `/image` and `/exec` answer `503`: the skill polls `/canvas-status` every 10 s while
     `relaunching` reads `true`, then retries once, and on a second `503` reports
     `lastExportError` and `lastNavError`. A navigation, like a launch, ends only on a canvas
     that answers and whose bridge socket is connected, an empty board included, so an `/exec`
     queued behind the switch runs on the new board. It is bounded the same way, so it never
     holds the exec queue for good: against a page that stops answering after it loads, it fails
     in about 15 s on an empty board and about 20 s on one with shapes, and an `/exec` queued
     behind it then answers `503` with `relaunching: true`. From the commit until the navigation
     ends, `/image` and `/shapes` wait for it, as an `/exec` queued behind it does: every step
     of the navigation is bounded, so the wait is too. They then answer for the new board, or,
     when the navigation failed or the switch stood aside for the launcher, `503`
     (`render-canvas relaunching`) with `relaunching: true`, which the skill polls out. An
     `/exec` made while the launcher runs a canvas it launched for the board the switch left
     answers the same `503` before its blob is sent: that page holds the old board, and a write
     it ran would answer `ok:true` while the new board never got it (render-cap Phase L). A
     request still parked on the page the navigation replaced fails at once with
     `render-canvas switched boards; retry`, and records no export failure.

  Every step that can refuse runs before the commit, so a failed switch never strands the panel
  on a board the server has left, and the release runs before the answer, so the leaving board
  is held for milliseconds rather than through the navigation. `claimLock` protects the target
  of a switch, the release its source.
- **[v8] Defect fixed by prevention: the per-board message store (`<name>.messages.jsonl`) is
  cached per-process and never re-read**, so two processes on one board would silently diverge (a
  full-file `rewriteMessages` on one clobbers the other's appends). The one-server guard makes
  two-processes-on-one-board unreachable in solo-POC use, apart from two claims at the same
  instant (the race caveat below), so the cache stays correct without a re-read mechanism; a
  re-read would guard a state the guard already prevents. The guard sees only boards with a
  lock: a server from before #64 that switched boards in-app keeps the room it left in memory,
  with no lock, until it is stopped. **[v9.11 #65]** A boot therefore refuses, exit 4, and an
  in-app switch refuses, `409`, while any live pre-#64 server's lock exists, whichever board it
  names (attach vs boot, and the runtime switch's step 1, above), so neither lands on that
  lock-less room, including when the pre-#64 server started after the current one booted.
- **Race caveat (accepted for a solo POC):** the only remaining way for two servers to claim
  one board is two claims within the same instant. Every other overlap between servers that
  write locks is refused or waited out: a board its owner serves is refused, and one it is releasing, or whose owner does not
  answer, is waited for and never read as free. Within one process `claimLock`'s last check and
  its write cannot be interleaved, but the file system does not serialize two processes: two
  that run that synchronous check-and-write on one board at the same instant could both claim
  it. Only an exclusive (`O_EXCL`) lock create would close that.

### 8.4 Board discovery

- **Discovery sources:** union of **(1)** `<scratch>/whiteboard/*.tldr` (always) and **(2)** a
  repo-wide `*.tldr` scan (excluding `node_modules`, `.git`). A live board is one whose `.lock`
  points at a reachable port.
- **Gitignore trap (must handle):** a search tool that obeys `.gitignore` (ripgrep, ugrep) skips
  the scratch folder, which is git-ignored, so a naive recursive scan **skips every scratchpad board**. Use a direct glob /
  gitignore-bypassed walk for the home.
- **Opening a board** loads that `.tldr` into the process's room; the render-canvas and operator
  browser join it.

## 9. The skill

`/whiteboard [new <name> | open <name-or-path>]`

The boot and loop below are the **Claude Code** path, the one upstream designed and verified:
`run_in_background`, `$CLAUDE_PID`, the session inbox, the canary, `SendMessage`, `/tasks`,
`--resume` and autocompaction are all Claude Code mechanisms. A harness without them boots
detached and pulls (**Port decisions**, at the end of this section); everything not named there
is the same in both.

**Boot (lead session):**
1. Install deps if needed (`scripts/whiteboard.sh status`, then `install` once the operator
   agrees: Port decisions). Resolve the board → `<name>.tldr`.
2. **[v4] Read `<name>.lock`.** If a live instance is found (**[v9.11 #64]** `pid` and
   `parentPid` alive, and `/canvas-status` answering with `activeRoom` naming this board),
   **attach**: as its lead when the lock's `parentPid` is
   this session's Claude process (`${CLAUDE_PID:-$PPID}`; outside Claude Code, by `ownerSessionId`,
   Port decisions P3), otherwise as a guest, registering with
   `guest: true` on the key `guest-${CLAUDE_PID:-$PPID}` through the one literal `curl` line in
   `references/guest.md`, which SKILL §1 step 2 points to, and skipping the canary (§4, §8.3, #57). A server whose `activeRoom` names
   another board is releasing this one, so the skill boots and the server waits out the release
   (§8.3). A live `pid` with a dead `parentPid` is a
   server exiting after its owner: wait for it, then boot. A lock with no `parentPid` is not
   live: boot, and the server looks for it (step 3). `new` on an existing board errors here.
   **[v9.11 #64]** A session becomes a board's owner only by booting it, which it does only when
   the server is gone.
3. Otherwise **start the Node process** (Claude Code; elsewhere `whiteboard.sh start --detach`,
   Port decisions P3) as the **foreground of a `run_in_background` Bash job**:
   `exec node --import tsx index.ts`, with no `npm`, no tsx CLI and no trailing `&`, so the
   shell is replaced by node and this Claude process is its **direct parent** (§3, #64). The
   command is exactly `exec bash <skill dir>/scripts/whiteboard.sh start --board '<absolute path to <name>.tldr>'`, whose last step is `exec node --import tsx index.ts` (Port decisions, §9)
   (§8.3): the skill passes no port and no owner fields, and the server refuses a
   `WHITEBOARD_BOARD` that is not an absolute `.tldr` path in an existing directory. The server takes the port recorded
   in `<name>.port`, so a board coming back reconnects the operator's open tab on the same
   origin, and a taken port falls back to an ephemeral one. Read the assigned port from the
   job's output; the process writes `<name>.lock` and `<name>.port`. A boot on a board another
   server is releasing, or whose owner is not answering, logs a waiting line that names which
   (`is being released by` or `which is not answering`) and waits before `listen`; both mean
   the boot is still working. A refused boot exits 3 with one of three lines (`claimLock`,
   §8.3). On "already served" the skill returns to step 2 once, which re-reads the lock and
   attaches; on "still being released" or "which does not answer" it reports the line to the
   operator and does not retry, adding for "which does not answer" what `ps -p <pid> -o comm=`
   shows.
   **[v9.11 #65]** Before any claim the server looks for a live server from before #64 on any
   board, and on finding one exits 4 with one line naming each pid, port and board (§8.3). The
   skill tells the operator, since stopping it is their call; on their go-ahead `kill <pid>`,
   then `kill -9 <pid>` if it is alive 5 s later, then boot again; if they decline, it neither
   boots nor attaches, and tells them why. The in-app switch refuses, naming the same servers, while
   such a server runs (§8.3), and the skill stops it the same way when the operator asks.
4. The bridge **launches the headless render-canvas** (Playwright Chromium running the app,
   joined to the room, `role=agent`). Wait until it reports connected. **[v9.11 #64]** The boot
   launch goes through the one render-canvas launcher, so `/canvas-status` reads
   `relaunching: true` until it ends, either connected or with `self-heal failed` in
   `lastExportError` (§8.3 runtime switch, step 5).
5. **[v5] Resolve the operator's author identity** (from `git config user.name`;
   else `"Operator"`) and **open the operator's browser** on
   `http://127.0.0.1:<port>/?role=human&room=<board>&author=<name>&authorKey=<stable>&session=<name>`
   (skipped when `humans` on `/canvas-status` is 1 or more: the operator's tab is already on
   this board, §8.3).
   **[v9.1]** The `session=<urlencoded>` param carries the **bound CC session's semantic name** — the
   driving session's `name`, resolved at boot from `$CLAUDE_JOB_DIR/state.json` (the same file step 6
   reads `linkScanPath` from for `transcriptPath`), e.g. `"my-repo: whiteboard session 10"`;
   fallback plain `"Whiteboard"` if unresolvable. On load the app sets `document.title` to
   `"Whiteboard: " + truncate(session)` (the app truncates for the tab), so each tab names the session
   bound to it rather than reading a generic `"Whiteboard"` — a tab-identity affordance in the
   drawer's room-identity language (#13, #47), client-only with no new server field (#54).
6. Register the lead session (`POST /session/register`, `clientKey` `lead`, **[v4] with its
   `transcriptPath`**) → its cursor and author identity. Registering rings the lead for the
   stored backlog: Sends a previous owner fetched but never completed (drain on open, §8.5). A
   Send typed while the board was down is held by the operator's tab and sent, in the order
   typed, when it reconnects (§8.2).
7. **[v9.11 #64] The canary** (Claude Code only; a lead in pull mode skips it, Port decisions P4). `POST /canary {sessionId}` rings the session with a server nonce that
   only the ring carries (never logged, never on `/canvas-status` or a `pending` field). The open
   procedure must see the ring arrive and fetch the nonce back as the first item of
   `GET /pending` before it reports the board ready. That proves server, inbox, model and fetch
   together, and every later ring-then-fetch repeats the proof. It fails loudly: `409` with
   `no inbox socket in the server's environment` or with `not booted as this session's child`
   (`ownerIsClaude` false, §8.3), the two told apart by their error strings; `502` when the ring
   could not reach the inbox; `504` when no ring was attempted within 5 s; and `403` for any
   session other than the registered lead, so a guest skips this step. The ring shows when a
   tool call returns (§8.5), so the skill makes up to three cheap calls before it reports a
   ring that never arrives as a doorbell that cannot reach the session (a `crossSessionInbound`
   of `hold` or `refuse`, or a changed inbox). A ring that arrives later still passes.

**The read-act turn (shared discipline, lead and worker).** **[v9.11 #64]** The lead's turn starts
when a ring arrives (in pull mode, when its foreground `GET /pending?wait` answers, P4) (or a bridge response carries a non-empty `pending`): it fetches
`GET /pending` and works each item. For a Send: `GET /shapes` + `Read` the screenshot → (ask via
`/agent-message` if ambiguous) → `/exec` → verify screenshot + one correction → select touched
shapes + summarize via `/agent-message` → **[v5] `POST /instruction-complete {id, sessionId}`** to retire it
(this is what marks the instruction done; skipping it leaves it open, and the next owner is rung
for it again). Then the turn ends; there is nothing to relaunch. **[v6]** Lead and worker differ
only in **how their Sends reach them** and, for the lead, in **supervising worker lifecycle**; a
worker keeps the **in-turn blocking self-park** (§8.5), re-arming by re-polling its own queue at
the turn's end.

**[v6] Worker loop (self-park on its own queue).** A spawned worker first `POST /session/register`
for its cursor + author identity, then **self-parks by long-polling its own queue**:
`GET /next-instruction?for=<its recipient id>&sessionId=<its sid>` (payload carries the Send's
`id` + selection). It **drains its backlog oldest-first** before parking (a Send may have been
held for it while it was absent, §8.5), then runs the read-act turn, points back, calls
`/instruction-complete {id, for, sessionId}` (`for` may be left out: it defaults to the key the
session registered on), and re-arms. Same read-act discipline as the lead,
on its **own** queue, never the lead's. A `204` is a re-arm, not an exit. **[v9.11 #64]** The
worker self-park is not part of the retired lead listener: it stays, and `/next-instruction` now
serves workers only (`for=lead` or no `for` is a `400`). **[v9.11 #66]** Both calls require the
worker's registered `sessionId`: missing is a `400`; not registered, or registered as another
recipient, is a `403`. The `403` saying the session is not registered is the worker's cue to
re-register on its `clientKey` and retry, which is how a worker recovers from a bridge restart
without the lead: the restart forgets every
session but keeps the board's recipients (§8.3), so Sends to the worker are accepted while it is
away, and once it re-registers the oldest of them is served first.

**[v9.11 #64] The lead's items.** A fetch of `GET /pending` returns, by `kind`: the open-time
**canary**; the lead's own **Sends** (`recipient` = lead); a **teardown** item (the operator
pressed the close affordance, §8.2, #53; its `at` is when close was first pressed); and **revive** items (a Send is waiting for a worker
whose queue has no live self-park). On a Send the lead runs the read-act turn. On a revive item
it issues a **revival nudge**: **SendMessage-resume that worker by the agent id or name it got at
spawn** with the item's **verbatim nudge** (fallback: fresh-spawn a replacement bound to the
same recipient id and region, handed the fixed brief from `references/workers.md` with its
prompt ending in that nudge, so it still receives no Send text); the woken worker
then drains its own queue and acts. On a **teardown** item — the operator's *only* structural
close signal — the lead first handles any Sends in the same fetch (one whose `at` is later than
the teardown's was typed after close was pressed), then finishes any in-flight turn, posts a brief closing `/agent-message`, runs
the pre-teardown gate (#59) and performs the graceful **`POST /done`** (§8.3). The lead **spawns
workers when the work splits** (or when the operator asks). The operator addresses only workers
the lead **has already spawned**; typing a new name into the recipient box does **not** conjure a
worker (§4).

**[v9] Stay-connected invariant — no premature hangup (#49).** A session **never tears the board
down at its own discretion** (SKILL §5, §8.3). When the work **looks** done the session **asks** ("are we
done — can I close the board?"); operator **silence keeps the board up**, never closes it. The
motivating v9 incident was a lead that ended its turn to ask a question and never received the
operator's next Send. **[v9.11 #64]** Hearing the operator no longer depends on the session keeping
anything running: the board server rings it, re-rings an unanswered item, and shows the operator
"not heard" when the rings run out. The listener lifecycle that this invariant used to police
(relaunch on every wake, verify a parked waiter at boot) is gone.

**[v9.11 #64] The board's lifetime is the owning session's.** The server records its parent pid at
boot and checks it every ~2 s; when the parent dies or changes (the session exited, was killed, or
was respawned by `--resume`, `--continue` or an update, each of which also retires its inbox
socket and token), it writes the `.tldr` snapshot, removes its lock, keeps `<name>.port` and
exits. Autocompaction keeps the process, so it costs nothing. Stopping the board's background job
(from `/tasks`) takes the board down the same way. The next `/whiteboard open` from the resumed
session boots a new owner from the snapshot on the recorded port, the operator's open tab
reconnects and sends any Send it held as `unsent`, and an uncompleted Send is rung to the new
owner again (§8.5). Workers are unaffected: a worker that dies is revived by the lead through a revive item,
and a worker's lease still expires after `STALL_MS` silence.

**[v3] Spawning workers:** when a task splits, the lead reads `references/workers.md` and spawns
tracked subagents, handing each a brief (its `clientKey`, the bridge URL, its region, and what to
read); each
`POST /session/register {name, transcriptPath}` for its own cursor and a **recipient id [v6]**, works
a **disjoint region**, drives the shared render-canvas via `/exec` carrying its `sessionId`, and
**self-parks on its own queue** (above). Workers are tracked subagents (they die with the run; no
detached scouts).

**Keep the loop cheap:** bounded per session; small per-turn payload (image + diff); **re-read
`references/tldraw-editor-api.md` after any autocompaction**, and recover any fetched-but-uncompleted
Send with `GET /pending?sessionId=<sid>&all=1`.

The whiteboard is a self-contained skill (#69): its source and its own dependency installs stay in
its folder, and it depends on no other skill. In this repository its tests and this spec live
outside that folder, so installers never copy them to users.

### Port decisions

This repository's port tracks upstream commit `4274c79c` (v9.11) and departs from it only where a
skill that any harness reads, installed anywhere, must. Each entry says what changed and why.

**P1. The boards folder and the repository come from the environment, never the install folder.**
Upstream finds the git root above `server/` (`findRepoRoot(__dirname)`) and uses
`.scratchpad/whiteboard/` there. An installed skill's `server/` sits in a plugin cache or a
user-level skills folder, so that root is the wrong repository or none. The server reads
`WHITEBOARD_REPO` (default: the git root of its working directory, else that directory) and
`WHITEBOARD_HOME` (default: `<WHITEBOARD_REPO>/.scratchpad/whiteboard`, created at boot).
`scripts/whiteboard.sh` passes both, from `--repo` and `--scratch`; the skill takes the scratch
folder from `docs/agents/workspace.md` (default `.scratchpad/`). `/boards` walks `WHITEBOARD_REPO`.

**P2. The runtime is installed through `whiteboard.sh`, after the operator agrees.** `status`
says whether the app is built and the server's dependencies and Chromium are installed from the
skill's current lockfiles and sources (a hash over `app/` and `server/`), and exits 5 with the
exact commands when not; `install` runs only the stale steps. When the skill's folder is
read-only (a plugin cache), the runtime is copied to and installed in
`<scratch>/whiteboard-runtime/`. Upstream builds the app in place, through Claude Code's skill-directory variable.

**P3. Two boots: owned in Claude Code, detached elsewhere.**
- *Owned (Claude Code).* `whiteboard.sh start` validates the board, checks the runtime, creates
  the boards folder, then `cd <runtime>/server && WHITEBOARD_REPO=… WHITEBOARD_HOME=…
  WHITEBOARD_BOARD=… exec node --import tsx index.ts`, with no log redirect. The skill runs it as
  `exec bash <skill dir>/scripts/whiteboard.sh start …`, the foreground of a `run_in_background`
  job, so the exec chain leaves the Claude process as node's direct parent: #64's owner watch,
  `ownerIsClaude` and the canary hold unchanged.
- *Detached (any harness that cannot keep a background job as the server's parent).*
  `whiteboard.sh start --detach` spawns the same `start` in a session of its own (Node's detached
  spawn, which calls `setsid()`) with `WHITEBOARD_OWNER_WATCH=off`, appends its output to
  `<room>.log`, waits until the board is live (`WHITEBOARD_START_WAIT_S`, 60 s) and prints its
  `locate` JSON. With the watch off the server never checks its parent: it runs until `/done`. Its
  lock records `parentPid: process.pid` (a number, so `findPre64Servers` does not take it for a
  server from before #64, and the attach check's `kill -0 <parentPid>` holds while it lives) and
  `detached: true`, and `/canvas-status` reports `detached: true`. This amends #64 part 3 outside
  Claude Code and restores #50's "survives its session" there; #63's swallowed stdio errors and
  hard exit deadline still apply.
- *Owner or guest, outside Claude Code.* No `$CLAUDE_PID` exists, so a session is the owner when
  the lock's `ownerSessionId` is its own (passed as `WHITEBOARD_OWNER_SESSION_ID` at boot) or it
  booted the board in this conversation; otherwise it registers as a guest.

**P4. Pull delivery where there is no inbox.** #64 rejected "a polling fallback" because it would
keep the background listener's lifecycle. This port adds a pull that has none of it, for
harnesses with no session inbox: `GET /pending?sessionId=<sid>&wait=<ms>`. With items it answers
at once, as before. With none and `wait > 0` it parks, clamped to `LONGPOLL_MS`, and answers as
soon as an item arrives (a Send, a teardown, a revive) or, at the timeout, `200 {"items":[]}`; a
dropped connection drops the waiter. The hook is in `doorbellTick()`, which every item source
already reaches through `ringSoon()`, after `syncBell` and before its `!leadSid` and
`!INBOX_SOCKET` returns. The lead runs the call in the foreground as the last act of each turn,
with `wait=110000` to stay under common two-minute tool caps, and runs it again on an empty answer.
There is still no background job, no relaunch-first and no parked flag: a call that is not running
is the same state as a lead between turns, and the item waits, durable, for the next pull.
`/canvas-status.doorbell.mode` is `inbox` when `CLAUDE_CODE_MESSAGING_SOCKET` was set and `pull`
otherwise. In pull mode an item stays `queued` while a lead waiter is parked or the last pull
(or the lead's registration) is within `WHITEBOARD_PULL_GRACE_MS` (5 min), and then reads
`not-heard` with reason `not-listening`, replacing `no-inbox`. Any `/pending` call is a pull, and
`?all=1` still recovers a fetched-but-uncompleted Send with `refetch: true`. The canary is
Claude Code's: its `409 no inbox socket…` stays, and the skill skips it in pull mode.

**P5. Hardening re-applied from the port's earlier reviews, which upstream lacks.**
- *No framing.* Every response, the final 404 and the error handler included, carries
  `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. A framed copy's
  requests would be same-origin, so the Origin/Host guard cannot refuse them, and its `/events`
  socket would count as a phantom human.
- *The render-canvas's sockets need a key.* `role=agent` on `/events` and `/sync` needs
  `canvasKey=<key>`, random per process (`WHITEBOARD_CANVAS_KEY` for tests), carried only in the
  render-canvas's URL, which is never logged; `app/src/bridge.ts` forwards it.
- *Teardown needs JSON.* `/done` and `/request-teardown` answer `415` without
  `content-type: application/json`, which a cross-site form cannot send without a preflight.
- *Placement.* One rule, `placementRefusal` in `server/boards.mjs`: a board is a `.tldr` inside
  `WHITEBOARD_REPO` or `WHITEBOARD_HOME`, in a folder that exists (the boards folder excepted). It
  applies at boot (exit 2), on `/board/open` (`403` outside, `400` not a board or no such folder),
  `/board/new` and `/snapshot?path`.
- *A board it cannot load is refused, never replaced.* Unparseable JSON, or tldraw.com's
  `{tldrawFileFormatVersion, records}` format, exits 1 at boot and is a `422` on a switch. Upstream
  logs "starting empty" and its next save overwrites the file.
- *A board it cannot save is never switched away from.* If the room being left cannot be flushed,
  the switch answers `503` and that room stays served and locked; a failed save is also posted to
  the panel as an agent message.
- *`GET /messages` checks the room id* (`isRoomId`, else `400`).
- *Sends enter only by `POST /message`.* The WebSocket `{type:'message'}` path is removed, so every
  Send passes the Origin/Host guard's HTTP checks.
- *A wait bounded by a recovery's time ends at that time by `Date.now()`.* Recovery measures its
  deadline with `Date.now()`, and `setTimeout` counts on libuv's monotonic millisecond clock, which
  floors on a different phase: a timer armed for `deadline - Date.now()` wakes with a millisecond still
  left in about 2 of 100 runs. Recovery then read time left, began a reload with a millisecond, took
  its unanswered probe for a clean store, and said "the canvas was reloaded" where it should have said
  its time ran out (CI caught it as a flaky Q0). `wsRequest`, `delay` and `withTimeout` arm
  `wallClockTimeout`, which re-arms a timer that wakes early, so a wait ends no earlier than its
  `Date.now()` bound. `sync-corruption.test.ts` Board Q0e runs Q0 with every server timer 5 ms
  early, which fails without the re-arm every time.

**P6. Room ids are upstream's: the board's base name.** The earlier port named a room by a hash of
the board's canonical path, so two `x.tldr` files in different folders were two rooms. This port
adopts upstream's basename room ids, lock, `<name>.port`, `claimLock` and Origin/Host guard to keep
the fork small. Known limitation: two boards with one file name in different folders share a
room id and so its lock, port record, chat log, recipients and render; open one at a time.
`server/boards.mjs` keeps the rest: `slugFor` (the one name-to-file rule for `--name`, `new` and
the panel's new board, which `/board/new` now uses), `placementRefusal`, `sidecarPaths` and the
`locate` CLI, which judges a lock live by upstream's rule (`pid` and `parentPid` alive,
`/canvas-status` answering `activeRoom` for the board).

**P7. Neutral names.** An agent with no name is `Agent`, not `Claude` (the `/exec` and
`/agent-message` stamps, the panel and presence), and the panel says "The agent has not heard your
message". The operator's author name comes from `git config user.name`, else `Operator`. The ring
text keeps "the /whiteboard skill": only Claude Code ever receives it. Messages that said "from
before #64" say "an older whiteboard server (no parentPid)". `npm start` prints `start the board
with scripts/whiteboard.sh start, not npm`, and the server's `bin` entry and `npx tsx` shebang are
gone. The legibility critic's brief is written out in its reference, not linked to agents of
another repository.

**P8. Exit codes.**

| Code | Server (`node --import tsx index.ts`) | `whiteboard.sh start` |
|---|---|---|
| 0 | clean exit | ok (`--detach`: the board is live, its JSON on stdout) |
| 1 | failed, including a board it cannot load | failed |
| 2 | board refused (not absolute, not `.tldr`, outside the repository and the boards folder, or no such folder) | bad board, refused before anything is created |
| 3 | held by another live server (`claimLock`'s three lines) | held by a live server: attach (its JSON on stderr) |
| 4 | an older server, with no `parentPid` in its lock, is running (#65) | an older server is running |
| 5 | | not installed (`status` prints the commands) |

Owned `start` execs the server, so past the script's own checks (2, 3 and 5) its code is the
server's. `whiteboard.sh locate` prints the board's JSON and exits 0 live or not, 2 on a refusal.

**P9. Where the files live.** The skill ships only what an agent running a board needs; the
spec, its diagram, the suites and the manual runbook stay in this repository:

```
skills/_incubating/whiteboard/
  SKILL.md
  scripts/whiteboard.sh                # status / install / path / locate / start [--detach] (P2, P3)
  references/tldraw-editor-api.md      # verified core + pointers (§5)
  references/legibility-checklist.md   # the gate + blind-critic contract (§5)
  references/workers.md                # [v9.11] spawning, the worker brief, the worker loop, revival
  references/homing-a-live-board.md    # [v9.11] copy-then-switch homing (§8.1, #59)
  references/guest.md                  # [v9.11] a second session on a live board (§8.3, #57)
  references/boot-failures.md          # [v9.11] the exit codes, the waiting lines, a taken port (§8.3, P8)
  references/delivery.md               # [v9.11] the canary failing, rings, the pull, not heard, the panel (§8.5, P4)
  references/exec-failures.md          # [v9.11] ok:false, a 503, and reading a recovery's outcome (§5)
  references/interrupted-work.md       # [v9.11] refetch, autocompaction, the session or the job ending
  references/harness-notes.md          # [port] Claude Code's mechanisms, and what other harnesses do instead
  app/                                 # Vite + React + <Tldraw> + useSync + panel + presence + PNG export + [v5] author stamping + [v6] recipient selector + per-agent status strip + [v7] valid-AgentId-only selector
  server/                              # Node: bridge (HTTP+WS) + TLSocketRoom sync + Playwright launcher
                                       #   + snapshot IO + message store + [v5] durable queue projection
                                       #   + [v6] per-recipient projection + per-recipient lease + worker self-park
                                       #   + [v7] Router / lifecycle-monitor seam + typed AgentId (400) + verbatim revive nudge
                                       #   + [v9.11] lead doorbell (inbox.ts) + GET /pending pull + owner watch + Origin/Host guard
                                       #   + [port] boards.mjs (P6), /pending?wait (P4), owner-watch opt-out (P3)
docs/whiteboard/
  SPEC.md                              # this spec
  skill-arch.tldr                      # the architecture diagram (still draws the retired poller flow)
tests/whiteboard/                      # the server suites (*.test.ts from upstream, *.test.mjs from the port)
  acceptance-runbook.md                # the operator-in-the-loop acceptance runbook
tests/whiteboard.test.mjs              # runs them under `npm test`, plus the whiteboard.sh cases
```

## 10. Out of scope

Speech-to-text (a local dictation tool types into the box); tldraw licensing/watermark;
packaging as a distributable; a structured/validated write-API; Obsidian/`.excalidraw.md` interop;
productization. **[v6] Now in scope (was out): addressable workers** — realized as **one top-level
agent (the lead) + the worker subagents it spawns**, a hub-and-spoke within **one session tree**.
**Still out of scope: multiple top-level agents / sessions on one board** (co-equal peer sessions);
the in-scope shape is strictly one lead plus its own subagents. **[v4] Explicitly rejected:** "one
server, many boards". **[v4] Specified but not built:** the transcript→message reconciler (§8.2).
**[v5] Explicitly declined:** a bridge→lead **push** over the internal UDS messaging socket — it
couples to a Claude Code internal, is undesirable UX, and cannot reach an ended lead anyway (§3,
§11). **[v9.11] Superseded by #64:** the lead is now rung through its documented session inbox
as a fixed doorbell, with the Send's content left on the pull. **[v9.1] Evaluated and
deferred (not declined): Claude Code Channels** (a sanctioned MCP event-push) — a real alternative to
the polling waiter, but it rides the **same durable queue** so it adds no delivery guarantee, and its
research-preview cost is not worth its lone edge for a solo POC; it is the **documented future
upgrade** for when it leaves preview and gains a persistable opt-in (#52, §11). **[v9] Specified
but not built this round: a Send TTL / supersede.** Sends have **no expiry**, so a stale unacked
Send pins the head of the oldest-first per-recipient queue and re-surfaces across sessions ahead
of live work (§8.5, §11) — the v9 drain-of-stale-Sends gap. The **fix is deferred** (a TTL, an
expiry sweep, or operator supersede — undesigned here); this round only **records** it (#51). **[v5] Specified but not built this round:** the human-facing **canvas legend/highlight**
filter by contributor (the data model and the agent-side slice ship; the UX affordance is a
fast-follow, §8.6); a `GET /shapes?author=` endpoint (client-side slicing needs none, §6);
per-shape **last-editor** history beyond the single most-recent editor. **Free consequence, not a
focus:** multiple *human* peers on one board. **Fast-follow:** per-turn undo namespacing; **[v6] a
soft region-lock** (clobber stays a convention made visible by authorship in v6, §11).
**[v9.11]** Undo is per exec, not per turn: the render-canvas sets a history mark before each blob
(§5), so one `editor.undo()` at the top of a blob reverts only the writes of the last exec that
wrote, whoever made it, a worker's included, and not every agent write since the canvas loaded;
once the blob has written, it reverts that blob's own writes so far. A reload of the render-canvas
to end a blob it did not answer (§5) starts the history afresh, so an undo at the top of the next
blob reverts nothing. Recovery reloads too, and puts its harvest back from the server, never as an exec, so an undo at the
top of the next blob reverts nothing of a recovery either (decision #67).
**[v9.1] Specified but not built this round: an adherence eval for the skill's LLM behavior.** Our
evals system (`harness-eval` / `.evals/`) covers **routing** (which skill fires) and **glob reach**
today; the **adherence tier** — "was the convention obeyed" — is **not built**. The behavior worth
hardening here is the lead's invariant-adherence (fetch on every ring and every non-empty
`pending`, stay-connected / ask-before-disconnect, teardown only on the operator signal, handle
each `/pending` item kind),
which is exactly adherence. **Trigger evals** on the skill's description **are** run this round
(recognition of the NL-trigger surface; the `/whiteboard` command fires deterministically). The
**adherence eval is a scoped follow-on** — scenario fixtures that drive the skill via the Skill tool
and score invariant-adherence against a paired injected-defect/stays-quiet fixture — deferred because
v9.1 already makes the risky behavior largely **structural** (the three-part re-arm reliability, the
structural teardown signal), shrinking the judgment surface such an eval would guard.
**Later, maybe never:** idle *initiative*. **[v7] Explicitly declined:** a **supervisor
*process*** that revives agents (a Node process cannot spawn/resume a subagent, §11, decision
#41) and, with it, a **second top-level agent to revive the lead** (that is multiple sessions on
one board, already out of scope, #33) — the lead-SPOF is accepted (§11). **[v7] Deliberately not
done:** a **mass rename** to one term — naming is *sharpened*, not collapsed (#44); and a **full
Router/Supervisor process split** — the seam is named and lightly modularized within one process,
no behavior change (#42).

## 11. Risks & mitigations

- **[v5] Silent stranding (the motivating failure).** Mitigated three ways at once: the queue is
  **durable** (a projection over the persisted message log, §8.5), completion-acked so a mid-draw
  crash **re-drains** rather than loses, and **loud**: **[v9.11 #64]** a lead Send the lead has not
  fetched is re-rung and then shown **not heard** (§8.5). No listener lifecycle remains to forget.
- **[v5] Coupling to CC internals — avoided by decision; [v9] its latency cost now removed without
  coupling.** The one true event-push (UDS socket injection) stays **declined** (§3, #26): the
  design adds **no** dependency on undocumented Claude Code internals, and the bridge still never
  pushes to any session. **[v9]** The latency #26 accepted — a Send to an unparked-but-alive
  recipient waiting until its next poll — is now **removed on the client side, not the server**:
  the lead keeps its `/next-instruction` waiter **parked continuously via a background job** (§8.5,
  #48), so the server's existing instant parked-waiter delivery (index.ts:1099/:1427–1433) applies
  without gaps and the board-wide parked flag (:927) stays true. This is **not a push** and reintroduces no
  UDS/bridge coupling — it only stops the client dropping its own waiter. A Send to an **ended**
  recipient still waits for the next open (loud + durable, never lost); the sole residual gap is
  the brief mid-turn-acting window, carried by the durable queue. #26 stands, its accepted cost
  retired without weakening it. **[v9.1]** The **sanctioned** event-push that did *not* exist at #26
  — Claude Code **Channels** — was later evaluated head-to-head and **deferred** (#52): it would not
  improve the delivery *guarantee* (both it and polling ride the same durable queue; a channel push is
  itself best-effort), and its research-preview cost (a non-persistable experimental launch flag every
  session, plugin/marketplace packaging, an org gate) is not worth its lone edge for a solo POC.
  Channels is the documented **future upgrade**. **[v9.11 #64] Superseded:** the lead is now woken
  through Claude Code's **documented** per-session inbox socket, used only as a **doorbell** (a fixed,
  server-authored ring; the Send's text stays on the pull). The one undocumented piece is the
  `type:"user"` message line, which is `SendMessage`'s own wire format; the open-time canary catches
  a change loudly and "not heard" catches one mid-session (decision #64).
- **[v5] Authorship ambiguity on the shared render-canvas.** All agents drive one Editor, so
  "which agent" is resolved by the **serialized per-`/exec` author context** (§8.6), not by guessing
  from the store. Human shapes are stamped on the operator's own page, never confused with agents'.
- **Stale-read / concurrent clobber [v3].** `/exec` tolerant of missing ids; prefer bindings;
  workers on disjoint regions; execs serialized.
- **Stale reference vs pinned SDK.** Generate the core from installed 5.4.2 types + smoke-test;
  never memory. **[v5]** Verify the `editor.sideEffects` API against installed types too.
- **Context growth over a long loop.** Small per-turn payload; bounded session; re-read reference
  after compaction.
- **[v3] Playwright weight.** One-time Chromium download; each process manages one page; tears down
  on `/done` and on crash. N boards = N Chromium pages — acceptable for a solo POC.
- **[v9.10] A board process outlives its log sink.** A board's stdout/stderr can point at a pipe
  nobody reads. Write errors on both streams are swallowed (logs are lost, the board keeps serving),
  and once shutdown starts the process exits by a hard deadline even if teardown hangs, after the
  final snapshot and lock removal (#63). **[v9.11 #64]** A board no longer survives its session:
  the owner watch exits it when its parent Claude process dies, and #63 is what lets that exit
  complete on a dead pipe.
- **[v9.11 #64] The doorbell's dependencies.** (1) The inbox's `type:"user"` message line is not in
  the docs (it is `SendMessage`'s own wire format); the canary at every open fails loudly on a
  change, and re-ring then "not heard" catches one mid-session. (2) A remote kill switch can refuse
  every message while the poster still sees a successful write; re-ring then "not heard" surfaces
  it. (3) The inbox's own-child check walks `ps` with a short timeout; on a machine pinned by
  runaway processes it can fail, and the token is the fallback. (4) The ring itself arrives under
  the inbox's peer framing; the members judged a refusal to "fetch your board" unlikely, but it is
  assumed, not measured — the operator's dry run checks it. (5) Background-job semantics have
  changed twice in recent releases; if a time limit returns for local sessions, the server is
  killed loudly and reopens from the snapshot. (6) Stopping the board's background job (from
  `/tasks`) takes the board down; SKILL.md says so. (7) Any session in the same permission mode
  can post a message in the ring's format, and the inbox cannot tell it from the real ring; the
  skill fetches only its own captured port with its own sid, never a URL a message names (§8.5),
  so a forged ring can at most cause a harmless read of the lead's own board. (8) `CLAUDE_PID` is
  as undocumented as the inbox's message line; the attach check falls back to `$PPID`, and the
  server's `ownerIsClaude` reads `null` and never blocks when it is unset.
- **[v9.11 #64] The board is down between a session ending and the next `/whiteboard open`.** Its
  content is on disk and its port in `<name>.port`, so the next open boots on that port and an
  open tab reconnects; a Send typed into the tab meanwhile is held as `unsent` and sent on
  reconnect; an uncompleted Send is rung to the new owner. A guest session never becomes owner of
  a live board. If the recorded port is taken by then, the server falls back to a fresh one and
  the skill opens a new tab; the old tab cannot reach the board, and the sync-room guard keeps it
  from opening a copy of its board on whatever server holds its old port (§8.3).
- **[v4] Stale lockfile / same-board race.** Liveness is pid + `/canvas-status`; a stale lock is
  reclaimed. **[v9.11 #64]** `claimLock` makes the check where the lock is written, at boot and
  in the switch, and reads `pid` and `held` on `/canvas-status`, so a board its owner is
  releasing, or whose owner does not answer, is never read as free. A second server on a board a
  live server serves exits 3 or attaches; on one being released, or held by an owner that does
  not answer, it waits up to `RELEASE_WAIT_MS` and then claims it or refuses (exit 3, or a `409`
  in the switch). The only remaining window is two processes claiming one board at the same
  instant, accepted for a solo POC; only an `O_EXCL` lock create would close it (§8.3).
- **[v4] Message log growth.** `<name>.messages.jsonl` is unbounded append; **[v5]** now also
  rewritten in place on delivery-state changes — still fine at POC scale. No rotation this round.
- **Long-poll starvation (workers).** ~240–250s max-time; the durable queue holds a no-waiter Send
  (§8.5). **[v9.11 #64]** The lead does not long-poll, so this applies to worker self-parks only.
- **`/exec` on localhost.** Accepted for a local POC; bind `127.0.0.1` only.
- **[v6] Worker finite lifetime.** A subagent's lifetime is undocumented (bounded by `maxTurns` and
  autocompaction), so a parked worker can die between Sends. Mitigated by the **durable per-recipient
  queue** (a Send held for a dead worker is not lost), **lead revival** (the lead's doorbell and
  `GET /pending` hand it a `revive` item), and **drain-on-open** (the revived worker works its backlog
  oldest-first before re-parking); §8.5, §9.
- **[v6] Lead is a single point of lifecycle authority.** Only the lead spawns and revives workers,
  so if the **lead** dies, worker revival pauses until `/whiteboard open` re-drains everything and a
  fresh lead resumes supervising. This is the **same failure floor as v5** (a Send waits for the next
  open: loud, durable, never lost), now applied per queue; §9, §8.5.
- **[v7] The lead-SPOF is a reconciled non-goal, not an unaddressed gap.** The design review proposed
  a **supervisor process that outlives and revives any agent, the lead included**, so nothing is the
  sole reviver. It is **not buildable**: only a Claude Code agent can spawn or resume a subagent — a
  Node process **cannot** (decisions #26, #37, and the whole reason v6 made the *lead* the reviver).
  The only actor that could revive a dead *lead* is a **second top-level agent**, i.e. multiple
  sessions on one board, which is **out of scope** (decision #33). So v7 **accepts** the lead-SPOF
  and keeps v6's floor (a Send to an ended lead waits, loud + durable, for the next `/whiteboard
  open`); the "supervisor" that *does* exist is the lead's **role**, and the bridge's health half is
  the **lifecycle monitor** that signals it (§3). Decision #41.
- **[v6] Subagent-slot churn.** Resuming a completed subagent takes a **fresh slot** without
  re-checking the concurrent-subagent cap, so repeated death/revive churn can creep the live count up
  toward the runtime limit. Mitigated by designing for 5 and treating **20** as the hard cap
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, ultracode-exempt), and by watching the count on revive;
  §12.
- **[v6] Sibling→sibling subagent messaging is unconfirmed.** A worker cannot be relied on to message
  another worker directly, so **all coordination routes through the bridge** (the per-recipient queues
  plus the lead's doorbell and `GET /pending`, which carries `revive` items), never agent-to-agent; §9.
- **[v6] Independent human addressing raises clobber odds.** Addressing workers directly means more
  concurrent independent draws, so a higher chance two touch the same shapes. Mitigated by
  **authorship visibility** (every shape carries `createdBy`/`lastEditedBy`, §8.6), which makes a
  clobber legible: a **convention, not a lock**. The soft region-lock is a fast-follow (§10).
- **[v9] Premature hangup / forced session end.** Delivery is **pull-only**: the single
  "listening" state is the long-poll, so a session that leaves the poll — to talk, think, end a
  turn, or stop — **hangs up**, and a later operator Send sits undelivered at unbounded latency
  (the revive path excludes the lead, so a silent lead never self-heals). This is the v9 incident:
  a lead ended its turn to ask a question and the operator's next Send was never received.
  Mitigated by (1) the **stay-connected invariant** — no disconnect at agent discretion; when work
  looks done the agent **asks and keeps listening**, silence keeps the line open (§9, #49) —
  buildable because listening now runs in a **background job** (§8.5, #48) that does not block the
  foreground; **[v9.1]** the job's re-arm is itself hardened so *staying* connected doesn't rest on
  agent memory — an **unmissable final-step relaunch**, a **boot/attach poller-liveness check**, and
  the **durable-queue floor** (#48 amended, §8.5); (2) **operator-confirmed-only teardown** (SKILL §5, §8.3),
  **[v9.1]** now carried by an **explicit app close-affordance → teardown directive** so the close is a
  structural signal, not a fuzzy natural-language read (#53); and (3) **forced-end board
  survival**: the board is a **separate Node process** from the CC session (§3), so on a forced end
  (autocompaction / context / `maxTurns`) the agent leaves it running, tears down **nothing**, and
  **reports resume coordinates**; the durable per-recipient queue + drain-on-attach (§8.5) carry
  any Sends to the next session that attaches. Same loud-durable floor as the lead-SPOF (#41): a
  Send to an ended lead **waits, loud and durable, for the next `/whiteboard open`** — never lost,
  the operator never truly hung up on. It does not contradict the finite-session floor (#41); it
  hardens the approach to it so the exit is a **clean handoff**, not a silent hangup (#50).
- **[v9] Stale unacked Sends pile up at the queue head (no TTL — known gap, follow-up).** A Send
  has **no TTL**: it stays pending until its recipient acks `completedAt` (§8.5). So a Send that is
  never completed — an old instruction superseded by a newer one, or one whose recipient kept dying
  before draining — **accumulates at the front of the oldest-first queue** and **re-surfaces across
  sessions**, ahead of the live Send the operator actually wants worked. This is the v9 mechanism
  by which the lead kept being handed **old arch-redraw Sends instead of the live one** on each
  drain. **Recorded, not fixed this round** (#51): no TTL, expiry, or supersede semantics are
  designed here; the oldest-first drain (§8.5) is unchanged. See §10.
- **[v9.5] Silent sync-corruption from a malformed exec.** A schema-invalid record flips tldraw's
  **sticky** corruption flag inside `store.put` (no public reset, `Store.js:734-741`), after which
  `@tldraw/sync-core` (`TLSyncClient.js:175`) suppresses every outbound push while the socket stays
  connected, so later well-formed execs return `ok:true` and never reach the room. Mitigated in
  layers (§5, #56): a **validate-first store-guard** rejects the common poison before `put`
  (best-effort, not exhaustive for arbitrary blobs); the **honest `/exec` contract** makes `ok:true`
  mean **confirmed present in the room** (a per-exec server-side bounded wait on the room
  clock/shape-set plus the corruption boolean), so a severed write returns `ok:false` and this same
  check detects the corruption; and **server-owned recovery** (harvest→reload→put-back from the
  server, then an `/agent-message` + panel line naming what it put back) restores the board,
  **loop-guarded** at 2 reloads per incident plus a cooldown before it surfaces loudly instead of reload-looping.
  Residual: the guard cannot pre-empt every arbitrary-blob crash path (recovery is the floor, not the
  guard), and a canvas still corrupted after its reloads is bounded, not eliminated, by the loop-guard.

Seam = **§3 topology + §4 session/presence/author contract + §5 write rules + §6 perception + §8
persistence/message/queue/authorship/multi-board contracts**, fixed here. Parallel slices, then
integration by the main (headful) session.

1. **Server: durable queue, delivery, authorship plumbing, the parked flag** (`server/`) — **[v5]**
   replace the in-memory `messageQueue` with the **pending-projection over the message store**;
   `deliveredAt` on `/next-instruction`, `completedAt` on a new `POST /instruction-complete {id}`;
   drain oldest-first; persist state changes by rewriting the JSONL; add the board-wide parked flag (a lead is
   parked iff a live long-poll waiter exists) to `/canvas-status` and broadcast a `message-state`
   frame; thread the Send `id` through `/next-instruction` (already v4). Keep sync/persistence/
   presence from v3–v4. **[v6]** add a **`recipient` field** on the message model (default lead;
   named worker; `everyone`); make the pending projection **per-recipient** (a `per-recipient pending
   projection` over the one message log, not N physical queues); make the lease **per-recipient**;
   track **per-worker parked/status**; serve the **supervisor long-poll** (the merged-poll flag) that merges
   the lead's own queue with **revive directives** for any worker queue that has a pending Send and no
   live poller; fan an `everyone` Send to every recipient's projection. **[v7]** name the internal
   seam — a **Router** module (per-recipient projection, `/message` intake, `/next-instruction`
   handoff, `/instruction-complete`, `/exec` relay, broadcast fan-out) and a **lifecycle-monitor**
   module (per-agent parked/lease state, the `STALL_MS` sweep, raising `revive` directives), no
   behavior change (§3); add a **typed `AgentId`** validated at every recipient seam (`recipient` on
   `/message`, `for` on `/next-instruction` + `/instruction-complete`) against the registry
   (`{lead,everyone}` ∪ ever-registered `clientKey`s), **rejecting an unknown id with `400`**; have
   the `revive` directive **carry the exact verbatim `nudge` text** (fixed bootstrap template keyed
   only on the `AgentId`).
2. **App: author stamping + panel lifecycle** (`app/`) — **[v5]** `editor.sideEffects` create/change
   handlers stamping `meta.createdBy` / `meta.lastEditedBy`; a per-`/exec` author-context set around
   blob execution (agent surface) and the URL-passed human identity (human surface); panel renders a
   Send's lifecycle (queued / no-agent-listening / delivered / done) from `message-state` + the
   board-wide parked flag. Keep the v4 read-model, dedupe-by-`id`, and per-Send `idempotencyKey`. **[v6]**
   add a **recipient selector on the Send box** (lead / a named worker / `everyone`, default lead); a
   **per-agent status strip** with **per-worker lifecycle badges**; render **one shared attributed
   log** that shows each Send's **addressee** alongside its author. **[v7]** the recipient selector
   offers **only valid `AgentId`s** (the lead, `everyone`, and spawned workers from the `agents`
   array) so the panel never sends an id the seam would `400`; sharpen panel copy to the **agent /
   recipient** vocabulary (§4, decision #44) — no "peer" for an agent.
3. **Skill + reference** (`SKILL.md`, `references/`) — **[v5]** boot resolves + passes the operator
   author identity; **drain the backlog before parking**; the read-act loop calls
   `/instruction-complete`; the **re-arm discipline** paragraph; the "no agent parked" state is
   surfaced to the operator; `editor.sideEffects` pointers in the reference. **[v6]** document the
   **worker self-park loop** (`GET /next-instruction?for=<recipient id>`, drain then park), the
   **lead supervisor loop** (the merged-poll flag, three outcomes), the **revival nudge**
   (SendMessage-resume by id, fallback fresh-spawn, bare nudge, worker drains its own queue), and
   **scale/cap guidance** (design for 5, hard cap 20 concurrent subagents). **[v7]** rewrite the
   nudge step so the lead **sends the directive's verbatim `nudge` text** (never authoring it), state
   the **payload-vs-bootstrap test** (does the nudge vary with the instruction? under v7 it cannot),
   note the **`400` on an unknown recipient**, and adopt the **agent / recipient** vocabulary.
4. **Integration + acceptance** — main session wires it and runs the §2 scenario incl. the swarm,
   persistence, isolation, **[v5] durable-delivery, and authorship** checks; the headless
   integration test covers: **a Send with no waiter survives a server restart and is drained in
   order** on the next boot; **a delivered-but-not-completed Send re-drains** (mid-draw-crash
   simulation); **the board-wide parked flag flips** with/without a waiter; **a created shape carries
   `meta.createdBy`** and is filterable by author. **[v6]** also: **a Send addressed to worker-2
   reaches worker-2, not the lead**; **a worker stays reachable across turns** (self-park + re-arm on
   its own queue); **a Send to a dead worker is held and drained after the lead revives it** (via the
   supervisor long-poll → revival nudge); **the per-recipient lease/reclaim holds** (a stalled worker
   lease re-queues on that worker's queue); **an `everyone` broadcast reaches all** registered
   recipients. **[v7]** also: **an unknown recipient id is rejected `400`** at each seam (`/message`,
   `/next-instruction`, `/instruction-complete`) while `lead`/`everyone`/a live worker/a **dead but
   ever-registered** worker are all accepted; **the revive directive's `nudge` text is verbatim and
   invariant to the instruction** (the same `AgentId` yields byte-identical nudge text regardless of
   the pending Send's content); **the Router/lifecycle-monitor split is behavior-preserving** (the
   full v6 suite stays green).

**[v9] work routing (waiter mechanism is client-side).** The always-listening *waiter mechanism* is a
**client-side** change; the delivery seam is untouched. The lead's `/next-instruction`
runs as a **background waiter loop** (`run_in_background`, silent `204` re-arm, exit-on-real-Send →
harness wake, **[v9.2]** relaunched first on wake before the turn), the **stay-connected invariant** (never
disconnect at discretion; ask before disconnecting), **operator-confirmed-only `/done`** and
**forced-end board survival** with resume coordinates; workers keep the in-turn park (lead-scoped,
§8.5). The no-TTL stale-Send pileup is **recorded, not built** (#51).

**[v9.1] work routing (the build the swarm runs).** Polling is confirmed as the mechanism (Channels
deferred, #52), and this round is no longer server-free — it splits into four lanes across separate
files (so a swarm parallelizes cleanly without clobber):
1. **Skill lane** (`SKILL.md`, `references/`, the poller script) — the heaviest. Rewrite §1 boot,
   §2 read-act loop, and §6 teardown to the v9/v9.1 model: the **skill-owned Bash poller script**
   (`curl` hanging-GET, `204` re-open, `200` print+exit), launched via one `run_in_background`; the
   **three-part re-arm reliability** (unmissable final-step relaunch, **boot/attach poller-liveness
   check**, durable-queue floor); the **stay-connected invariant** and **operator-confirmed teardown**
   via the **teardown directive** on the supervisor poll (#53); **forced-end board survival** with
   resume coordinates. SKILL.md still describes the pre-v9 pull/blocking model and must be rewritten
   wholesale.
2. **Server lane** (`server/`) — two small, waiter-independent deltas: (a) the **`parseRecipient`
   hardening** — distinguish *absent* (→ default lead) from *present-but-invalid* (non-object / bad
   `kind`) and **`400`** the latter, extending #43 (index.ts:1360); (b) recognize the operator
   **teardown-request** and surface it to the lead's the merged-poll flag poll as a **teardown directive**
   (§8.2, #53).
3. **App lane** (`app/`) — the **explicit confirm-gated teardown affordance** in the drawer (posts the
   distinct teardown-request, #53), and honest always-listening status (the collaborators row reads the
   lead as *present* while a background waiter is parked, the board-wide parked flag continuous, §7).
4. **Acceptance lane** — the **spike proves the poll loop first** (an idle session is re-invoked on a
   `200` job-exit; the loop holds a waiter across a `204` without waking; a mid-act Send drains on
   relaunch, §2), then the full checks: **listen-while-interact**, **no-premature-hangup**,
   **forced-end**, **operator-teardown-affordance closes the session**, and **`parseRecipient` `400`s a
   malformed recipient** while a bare-omitted recipient still defaults to lead.

## 13. Decisions log

| # | Decision | Choice |
|---|---|---|
| 1 | Purpose | Staged: prove the experience now, own it later |
| 2 | Scope | Personal-local now, promotable to a shared team skill; not productized |
| 3 | Canvas stack | tldraw **5.4.2** (licensing waived), React 18/19 |
| 4 | Integration | Local HTTP + WebSocket bridge, driven by the skill; event-driven |
| 5 | **[v9] Trigger** | Text-area Send (+ selection) → the addressed recipient's `GET /next-instruction` long-poll (index.ts:1245–1249 drain / :1099 parked-waiter). **[v9]** The client keeps that waiter **parked continuously in a background job** (§8.5), so a Send is delivered **instantly** to a parked recipient — synchronously on `POST /message` (:1427–1433) — rather than after a ~240s *blocking foreground* poll; listening no longer occupies the session's foreground turn (a `204` re-arms, a real Send wakes the session via the harness). §8.5, §3 |
| 6 | Speech-to-text | Out of scope; a local dictation tool types into the box |
| 7 | Agent write | `/exec` JS, tolerant, prefer bindings; verify-after-write; reference = core + pointers |
| 8 | Perception | JSON + rendered screenshot, image+diff per turn |
| 9 | Deixis | Operator selection shipped with Send; agent points back by selecting |
| 10 | Agent voice | WS `agent-message` → panel log; may ask before drawing |
| 11 | Persistence | `.tldr`; **[v3] sync server owns it**; home `<scratch>/whiteboard/` |
| 12 | Discovery | Scratchpad home ∪ repo-wide `.tldr`, gitignore-bypassed |
| 13 | UI | Collapsible zen panel (pull-tab, unread dot, Cmd/Ctrl+\ , persisted) |
| 14 | **[v3] Collaboration** | **Multi-peer via tldraw sync** (`TLSocketRoom`, local) |
| 15 | **[v3] Agent peer** | **One shared render-canvas** (our app, headless **Playwright**), driven by the bridge; per-agent presence injected server-side |
| 16 | **[v3] Session model** | **Lead session + worker subagents**; human Send → lead; workers on disjoint regions |
| 17 | **[v3] Language** | **All application code is TypeScript**, strict |
| 18 | **[v3] Presence propagation** | Agent cursors injected **server-side** as N presence-only sync clients; §7 |
| 19 | **[v3] Idempotency** | `clientKey` on register, `idempotencyKey` on `/exec` + messages; retries never duplicate; §4 |
| 20 | **[v4] Message persistence** | **Model C: seam-capture store is the live source** (`/message` + `/agent-message`), JSONL sidecar per board, panel is a read model over `GET /messages`; §8.2 |
| 21 | **[v4] Message model** | Flat, ts-ordered; **`id` == message `idempotencyKey`**; author `{kind,name,sessionId?,color?}`; human `selection` rides the Send; panel dedupes by `id` |
| 22 | **[v4] Transcript role** | Source available as an **on-demand rebuild/audit backstop** (`transcriptPath` via `linkScanPath`); reconciler **specified, not built** |
| 23 | **[v4] Multi-board** | **One process per board**, OS-ephemeral port, `<name>.lock` = discovery + one-server guard (not a session limit); §8.3 |
| 24 | **[v4] Command semantics** | `open` attaches-or-boots; `new` errors if the board exists; app derives base URL from `window.location.origin` |
| 25 | **[v4] Legibility gate** | Verify-after-write is a **gate looped until legible** (bounded 3), run by a **blind critic** subagent (PNG + checklist only), distinct from a one-pass aesthetic cap; §5 |
| 26 | **[v5] No push to an unparked lead** | **Declined** the internal-UDS socket injection — couples to a CC internal, undesirable UX, cannot reach an ended lead. Robustness comes from a durable queue + loud signal + re-arm discipline + drain-on-open instead. **[v9] amended:** re-arm discipline is now **structural** (a never-lapsing background waiter, #48); this **removes the latency cost this decision accepted** (a Send to an unparked-but-alive lead waiting for its next poll) **without** reintroducing the push — no server/bridge/UDS change, so the decline stands unweakened; §3, §11 **[v9.11] Superseded by #64:** the lead is woken through its documented session inbox, as a fixed doorbell with the Send left on the pull. |
| 27 | **[v5] Durable queue** | The instruction queue is a **read-model projection over the message log** (one source of truth), not a second store; pending = a human Send with no `completedAt`; §8.5 |
| 28 | **[v5] Ack model** | **At-least-once, completion-acked** (`deliveredAt` on handoff, `completedAt` on `/instruction-complete`), a Send its recipient was served before and never completed is served again with `refetch: true` (the lead's by drain on open, a worker's by its delivery slot), and the consumer perceives the board and finishes it rather than drawing it again (§4; the `/exec` key guards a retry, never a re-drain); a mid-draw crash **re-drains**; drain oldest-first; §8.5 |
| 29 | **[v5] Loud "nobody parked"** | The panel shows a Send's lifecycle incl. **no-agent-listening**; `/canvas-status` exposes **the board-wide parked flag** — stranding is never silent; §8.6, §11 |
| 30 | **[v5] Authorship storage** | Per-shape **`meta.createdBy` (immutable once stamped, carried across every later local write; a local create of an id the client has never held is stamped with the acting author whatever the record carries, so a duplicate or a paste belongs to whoever made it, while a restore keeps its stamps; amended by #68) + `meta.lastEditedBy`**, which rides sync + `.tldr` natively; stamped by an `editor.sideEffects` handler (agent: serialized per-`/exec` author context; human: URL-passed identity), never by the `/exec` blob, which must not set `meta`; §8.6 |
| 31 | **[v5] Author identity + query** | Human identity resolved from `git config user.name` (fallback "Operator"); **no backfill** of old shapes; slicing is **client-side** for both consumers (no `?author=` endpoint); the human-facing canvas legend/highlight is a **fast-follow, not built**; §4, §6, §8.6 |
| 32 | **[v5.1] Lease / visibility timeout + honest signal** | A delivered Send is a **lease** renewed by any `sessionId`-bearing bridge call; a sweep reclaims it after `STALL_MS` silence and redelivers (to a present lead) — recovers a **lead-only crash while the bridge lives**, which the on-boot re-drain cannot. Server-authoritative **state** (`queued/working/stalled/done`); the no-agent banner keys on **waiting for a lead**, never on **working** (fixes the v5.0 false-banner-during-draw wart). Not auto-spawn (decision #26). **[v9]** With the always-listening background waiter (#48), "waiting for a lead" (the parked flag false) is reached only when the lead **session ends** — a lead that is talking or drawing still reads present — sharpening the banner's meaning; §8.5 |
| 33 | **[v6] Topology** | One **top-level agent (lead) + the worker subagents it spawns** — hub-and-spoke within one session tree; **multiple sessions / top-level agents on one board stays out of scope**; §10 (Out of scope) |
| 34 | **[v6] Addressable workers in scope** | Lifts the §10 "co-equal human-addressable sessions" exclusion, **scoped to one lead + its own subagents** (not co-equal peer sessions); a worker is directly addressable; §10 (Out of scope) |
| 35 | **[v6] Worker lifecycle** | Workers **self-park on their own durable per-recipient queue**; finite subagent lifetime is covered by the **durable queue + lead revival + drain-on-open**, not a long-lived idle worker; §9 (The skill), §8.5 (Durable instruction queue & delivery) |
| 36 | **[v6] Addressing / data model** | A **`recipient` field on human Sends** (default **lead**; a named **worker**; **`everyone`**), served by a **per-recipient pending projection over the one message log** (not N physical queues); the default recipient keeps the zero-worker case unchanged; §8.5 (Durable instruction queue & delivery), §4 (Multi-peer, sessions & presence) |
| 37 | **[v6] Revival wire** | The **lead is the sole lifecycle authority** (only an agent spawns/resumes; the bridge never does); revival via a merged **supervisor long-poll → SendMessage-resume by id (fallback fresh-spawn) → bare nudge → worker drains its own queue**; this is the **only** CC-messaging dependency and does **not** reintroduce the declined UDS push (#26); §9 (The skill), §3 (Architecture) |
| 38 | **[v6] Panel** | **One shared attributed log with addressee** + a **per-agent status strip**; the single the board-wide parked flag boolean generalizes to a **per-worker lifecycle badge** (queued / working / stalled / absent); §8.2 (Message persistence & the panel read model), §12 (Swarm work-breakdown) |
| 39 | **[v6] Clobber** | Stays a **convention made visible by authorship** (`meta.createdBy` / `meta.lastEditedBy`); a **soft region-lock is a fast-follow**, not built this round; §10 (Out of scope), §11 (Risks & mitigations) |
| 40 | **[v6] Scale** | Design for **5** workers; hard cap = the runtime **20** concurrent-subagent limit (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, ultracode-exempt); §11 (Risks & mitigations), §12 (Swarm work-breakdown) |
| 41 | **[v7] Lead-SPOF reconciled** | The design review's **supervisor-process that revives any agent (incl. the lead)** is **declined as not buildable** — only a CC agent can spawn/resume a subagent, never a Node process (#26, #37); the only reviver of a dead lead is a second top-level agent, which is out of scope (#33). v7 **accepts the lead-SPOF** and keeps v6's floor (a Send to an ended lead waits, loud + durable, for the next `/whiteboard open`); §3, §11 |
| 42 | **[v7] Bridge internal seam** | Name the bridge's two jobs as a **Router** (routing/projection) and a **lifecycle monitor** (health/lease-sweep/revive-directive) — a documentation + light module split, **no behavior change**; the monitor **signals, the lead acts**. "**Supervisor**" is reserved for the **lead's role** (the only actor that revives), never a bridge component; §3, §12 |
| 43 | **[v7] Typed `AgentId`** | A recipient id is a **typed, seam-validated `AgentId`**, not a bare string: valid = `{lead, everyone}` ∪ **every `clientKey` ever registered** (retained across worker death, since `clientKey` = the stable recipient id; **[v9.11 #66]** per board, and across a restart, in `<name>.recipients.json`). `recipient` (`/message`) and `for` (`/next-instruction`, `/instruction-complete`) are validated at the seam; **an unknown id is `400`**. Answers "convention vs constraint"; §3, §4 |
| 44 | **[v7] Naming sharpened, not collapsed** | Unify the **actor** term on **"agent"** (the lead and its workers are agents); keep **"recipient"** as the **routing target** (an agent, or the `everyone` broadcast — which a naive collapse to "agent"/"worker" would lose); **retire "peer"** where it meant an agent (it stays the tldraw-sync term for the operator browser + render-canvas). **"Lead = an elected role" is rejected**: within one session tree the lead **is** the parent structurally, not electable (election needs multiple top-level agents, out of scope #33); §4 |
| 45 | **[v7] Structural revival nudge** | The nudge is payload-free **by construction, not discipline**: the `revive` directive **carries the exact verbatim `nudge` text** — a **fixed bootstrap template keyed only on the recipient `AgentId`** (bridge URL, `clientKey`, "drain your queue"), identical on every revival. The lead **sends it as-is** and is **never handed the instruction**, so no field can hold a paraphrase. Fixes a real v6 lapse (the nudge paraphrased the instruction); §3, §4, §8.5 |
| 46 | **[v8] Runtime board-switch = attach, not steal** | The in-app switcher (`POST /board/open`, `POST /board/new`) honors the **one-server guard** at runtime, not only at boot: before an in-process room switch it checks for a **live foreign owner** (lock `pid` alive **and** its port answers `GET /canvas-status` for that board) and, if found, returns **`{attach:true, port}`** so the browser navigates to that owner's port — it never steals the lock. **[v9.11 #64]** The check is `claimLock`'s four-way probe: a board its owner is releasing, or whose owner does not answer, is waited for and then claimed or refused with a `409`, and the switch commits or changes nothing (§8.3). Only an unowned/stale-locked board is switched-to in-process, and **[v9.11 #65]** none while a server from before #64 runs on any board (a 409 naming it) (the common single-server case is unchanged). Fixes the **split-brain** an in-process steal caused (two processes on one board; a parked waiter and a Send never meet). The **minimal guard** was chosen over a full attach-or-boot rewrite (fix #1): it closes the bug where §8.3 already promises the guard bites, at a small blast radius. The **per-process message-store cache** footgun is **fixed by prevention** — the guard makes two-on-one unreachable in solo-POC use, apart from two claims at the same instant and a pre-#64 server's lock-less room, beside which a boot or a switch now refuses to run (§8.3, #65), so no cache re-read is added; §8.3 |
| 47 | **[v8] Drawer redesign + identity color** | The operator panel is recut to read like a room: **board switcher = button + popover** (removes the always-open list's header/row crunch); the per-agent status strip and recipient `<select>` **merge into one collaborators row of identity-colored avatars**, **tap-to-address** (default lead), keeping the **400-safe roster** (only real spawned agents + the `everyone` broadcast are tappable — #43); chat attribution in each agent's color; calm no-agent notice; a token system (4/8/12/16, 3-size type, one accent + semantic status, light/dark, focus rings, 44px targets, 150–200ms). **Agent cursors dropped from the UI** (agents draw via `/exec`; identity **color** added to the `agents[]` roster — server-side from presence, deterministic fallback — for the avatars). The server-side presence-**cursor** mechanism (§7) is now **suppressed by default** (`SHOW_AGENT_CURSORS = false` in `server/presence.ts`): no agent cursor is injected into the operator's view — the static injected cursor read as a stray "glowing cursor," and the collaborators row already carries who is present and their state; the session is still tracked (name/color/state) for the roster and message attribution, and the `PresenceClient` machinery is intact behind the flag. Human peers broadcast their own cursors through their own browsers and are unaffected. **[v8 re-skin]** the first cut read *too toy-like* to the operator; the visual language was recut to Airbnb/Linear/Raycast craft (a blind 4-lens critique swarm drove it): a neutral palette with **one refined indigo accent** (was a loud violet), **small flat solid avatars in labeled participant chips** (halo ring dropped; selection is a calm active-item background, not a ring), **chat attribution neutralized** (a small identity dot + a neutral name, not a big saturated word) with each turn a name-line over its body, a top scroll-fade so messages don't guillotine, a **real Send** (confident solid accent when composable, neutral-gray when empty — no pale-lavender-disabled look), the ⌘↵ hint moved out of the placeholder, and the raw board-`source` row tag ("HOME"/"REPO") removed. **Two axes are left OPEN for the operator to settle on the live render: warm vs cool neutrals** (Airbnb pulls warm; Linear/Raycast cool — shipped cool) **and dark vs light** as the primary surface (shipped light, matching the board canvas); §4, §7 |
| 48 | **[v9] Always-listening (background-parked waiter)** | The `/next-instruction` long-poll runs in a **background Claude Code job** (`run_in_background` Bash) that keeps a waiter **parked continuously**, silently re-arming on each 240s `204` (`LONGPOLL_MS`, index.ts:42) and **exiting only when a real Send is delivered** — the exit triggers the harness's standard **session wake / re-invoke**, whereupon the session acts (draw / spawn / revive), relaunches the poll, and hands the foreground turn back. The **server is unchanged and stays pull-based** (:1099/:1427–1433 deliver to a parked waiter as before); the client simply never lets the waiter lapse, so the board-wide parked flag (:927) stays true and delivery is instant while parked. This **removes the latency #26 accepted** (a Send to an unparked-but-alive recipient waiting for its next poll) **without adding any coupling**: no server/bridge push, so it does **not** reintroduce the declined UDS injection — fully consistent with #26, it only closes the gap #26 left open by keeping the recipient parked. To keep a single lease-renewer the background waiter runs only between turns (relaunched after `/instruction-complete`), never concurrently with the foreground; the only residual window is a Send arriving while the session is mid-turn acting, covered by the durable per-recipient queue (§8.5). **Lead-scoped** (workers keep the in-turn park). The **Monitor tool was considered and rejected**: it polls a status endpoint on an interval (reintroducing latency) and parks no waiter. **[v9.1] amended — poller form + re-arm reliability.** The poll loop lives in a **skill-owned Bash script** invoked by the one `run_in_background` Bash call (not fragile inline bash): a `curl --max-time` hanging-GET that swallows a `204` and re-opens, and on a `200` prints the delivered Send to stdout and exits (the wake). The relaunch is **not left to agent memory** — three guarantees stack: (1) relaunch is the **unmissable final step** of every read-act turn, after the ack; (2) **boot and attach verify a live poller** and start one if absent; (3) the **durable-queue floor** makes any missed re-arm loss-free (drained on the next poller return or `/whiteboard open`). A **`Stop` hook cannot own the listener**: a hook-spawned process does **not** receive CC's `run_in_background` wake-on-exit (only the agent's own Bash background job does), so the relaunch must be agent-driven, hardened by (1)-(3). **[v9.2] amended — relaunch-first + per-message leases.** The relaunch is no longer the final step after `/instruction-complete`; it is the **first action on wake, before acting** (immediate relaunch-on-receipt), so a fresh waiter is parked for the whole draw and a Send arriving mid-act is caught. The v9.1 "background waiter runs only between turns / relaunched after the ack, to keep a single lease-renewer" rationale is **superseded**: leases are **per-message** (the existing `inFlightByRecipient` Set, index.ts:822), so the lead can hold concurrent leases on m1 and m2, and a relaunched poll skips the in-flight (leased) Send via `nextPendingFor` (:923–928) — no serialization needed. Exception: a **teardown directive** relaunches nothing (§6). The one server change lands in the **`STALL_MS` sweep**, which now **spares a lease whose holder session has a live parked waiter** (`sessionHasWaiter(deliveredBy)`), keying "stalled/absent" on a genuinely **session-ended** state rather than an idle lease — **both** the false-"stepped away" fix and the deliberate-pause busy-loop fix. **Two choices recorded** (decided, not open): the `STALL_MS` remedy is **parked-waiter sparing in the sweep**, chosen over raising `STALL_MS` or a deliberation heartbeat; the lease model **stays per-message** (the existing Set — no migration to a separate per-Send lease token). "Never stop listening" is now a **hard requirement**; polling reaches **~99% not a literal 100%** (the wake still needs the poller to exit + the harness to re-invoke, and the mid-act relaunch window is a real gap the durable queue covers, not eliminates) — **Channels (#52) remains the zero-gap ceiling**, not reopened. §8.5, §3, §11 **[v9.11] Superseded by #64:** the lead no longer long-polls; it is rung and pulls `GET /pending`. The worker self-park is unaffected. |
| 52 | **[v9.1] Channels evaluated & deferred** | The delivery-wake was re-examined against Claude Code **Channels** (a custom MCP server that pushes events into a live session) as an alternative to the polling background-waiter (#48), and **deferred, not adopted**. Finding: the delivery **guarantee** (a Send reliably received, in order, loss-free, and acted on) lives in the **durable per-recipient queue** (§8.5), which **both** designs ride — the wake (channel push *or* background-job-exit) is a **best-effort nudge** either way (channel notifications are fire-and-forget and dropped silently if the channel is unloaded), so polling **matches Channels on reliability, consistency, and latency**. Channels' only genuine edge is a listener **decoupled from the CC turn cycle** (its persistent subprocess self-polls) — an elegance bought at a **research-preview cost**: an **experimental launch flag on every session** (`--channels …`, absent from `--help`, "syntax may change," **not persistable**), **plugin + marketplace packaging**, and an org **`channelsEnabled` / `allowedChannelPlugins`** gate to avoid the `--dangerously-load-development-channels` flag. For a solo, personal-account POC that cost is not worth the elegance. **Channels is the documented future upgrade** for when it leaves preview and gains a persistable opt-in. **Supersedes** the interim direction to rewrite delivery to a Channel; #48 stands, hardened (#48 amended, #53). §3, §8.5, §11 **[v9.11] Superseded by #64:** the observed failures contradicted "matches Channels on reliability"; the inbox doorbell replaced the poller, and Channels stays out for the launch-flag reasons above. |
| 53 | **[v9.1] Operator teardown affordance** | The operator "indicates the session can be closed" (#49/#50) through an **explicit, confirm-gated app affordance** — a "disconnect / close session" control in the drawer — which posts a **distinct teardown-request** the lead's poll surfaces as a **teardown directive** (a structural signal, not a natural-language interpretation). A natural-language Send ("we're done, you can disconnect") is honored as a **fallback**. On the directive the lead performs the graceful **`POST /done`** (render-canvas + sync server + `<name>.lock`). This is the **only** path to teardown at the operator's deliberate command; a **forced / auto** session end (autocompaction / context / `maxTurns`) still tears down **nothing** (#50 — the board process survives with resume coordinates). Extends #49/#50 with the concrete operator→lead close channel and the app↔skill seam that carries it. **[v9.6]** Hardened by #59: even holding a directive, the lead runs a pre-teardown gate (guest-refusal + unaccounted-peer re-confirm) and never infers a close from a file/migration/"switch" request; a guest never tears down at all (#57). §8.2, §9, §11 |
| 49 | **[v9] Stay-connected / no premature hangup** | Delivery is **pull-only**, so ceasing to listen == hanging up. A session **never disconnects at its own discretion** — neither by leaving the poll nor by tearing down. Default is **stay-connected**; when work looks done it **asks** ("can I disconnect?") and **keeps listening** until an explicit operator **yes**, and operator **silence keeps the line open**. Buildable because listening now runs in a **background job** (#48), so staying connected does not block the foreground. Makes the re-arm discipline (§9) a hard invariant covering the quieter hangups the `204` framing left open. Fixes the v9 incident (a lead ended its turn to ask and never received the next Send); §9, §6, §8.3 |
| 50 | **[v9] Forced-end board survival + operator-only teardown** | Teardown (`POST /done` — render-canvas + sync server + `<name>.lock`) fires **only on the operator's explicit confirmation**, never at agent discretion. On a **forced** CC-session end (autocompaction / context / `maxTurns`) the agent **leaves the board process running** (a separate Node process from the CC session, §3), **reports resume coordinates**, and **tears down nothing**; the **durable per-recipient queue + drain-on-attach** (§8.5) carry any Sends to the next session that attaches, so the operator is never truly hung up on. Consistent with the lead-SPOF floor (#41): a Send to an ended lead waits, **loud + durable**, for the next `/whiteboard open`; §6, §8.3, §11 **[v9.11] Amended by #64:** a board now lives and dies with its owning Claude process; after a session ends the board is down until the next `/whiteboard open`, content intact. |
| 51 | **[v9] No-TTL stale-Send pileup — known gap, follow-up** | Sends have **no TTL**: an unacked Send persists forever, oldest-first, and re-drains on boot (index.ts:879 is the sole pending filter). So a stale Send (a superseded instruction, or one whose recipient kept dying before draining) **pins the head of the oldest-first queue** and re-surfaces across sessions ahead of live work — the v9 mechanism by which the lead kept being handed old arch-redraw Sends instead of the live one. **Recorded, not fixed** this round: no TTL, expiry sweep, or operator-supersede is designed here (deferred follow-up); the oldest-first drain (§8.5) is unchanged; §8.5, §10, §11 |
| 54 | **[v9.1] Per-board browser-tab title carries the bound session name** | The operator tab's `document.title` is **`"Whiteboard: <bound session's semantic name>"`** (the app truncates for the tab), **not** the board/room name. The name is the driving CC session's `name`, resolved at boot from **`$CLAUDE_JOB_DIR/state.json`** — the same file §9 step 6 reads `linkScanPath` from for `transcriptPath` — e.g. `"my-repo: whiteboard session 10"`; **fallback** plain `"Whiteboard"` if unresolvable. The skill passes it to the operator browser as a **`session=<urlencoded>`** URL param (§9 step 5, alongside `author`/`authorKey`); the app reads and truncates it — **client-only, no new server field**. Room-identity language of #13/#47. **Caveat:** a board-switch today navigates the tab to a different board's port, so the title is **per-board-session** for now; a session that stays bound to the tab **across** board switches is deeper arch intent, recorded as **follow-on / out of scope** and not designed here; §9 |
| 55 | **[v9.3] Lead delivery reworked to liveness-driven, not lease-clocked** | **DECIDED and BUILT** (v9.3 landed test-first: board R in `integration.test.ts` is the "lead is never stalled while alive" regression, boards E and Q were re-cut off the removed lead `stalled`, and boards H/I proved the worker sweep independent; a new lead grace window, a lead-liveness flag on `/canvas-status` + a lead-liveness frame, the dead-lead sweep). **The proven problem (P6, reproduced live on/off against a running server):** the lead's `inFlightByRecipient` lease (index.ts:822) plus the `STALL_MS` sweep (index.ts:49–50, `sweepStalledLeases` ~1191) is a **Competing-Consumers visibility-timeout misapplied to a single consumer** whose liveness signal (a parked long-poll waiter) is **destroyed by the act of delivering it work**: the poller script exits on the 200 to wake the agent (the poller script:74–78), so the board-wide parked flag flips false the instant a Send lands, and during the whole wake→re-arm gap no waiter is parked, the v9.2 sweep-sparing (`sessionHasWaiter`, ~1183) cannot fire, and once silence passes `STALL_MS`=120s the un-acked lease is reclaimed to a **false `stalled`** (`subStateFor` ~975) and re-delivered (a busy-loop, plus the "stepped away" banner). The board-Q unit test (`integration.test.ts` ~523–564) passed only because it kept a **second, independent waiter parked** across the pause, a state the real single-poller never holds mid-turn, so the green test hid the bug. **The decision (the design review's option B, sharpened):** keep Guaranteed Delivery (the durable message log + completion ack are untouched); for the LEAD, delete the timed lease and the stall, and instead: (a) receipt/working is an **automatic, clockless, session-scoped delivered-marker** set on delivery (held by session S, not yet handled), replacing the timed lease for the lead; (b) completion is the agent's `/instruction-complete` meaning **HANDLED** (responded or acted on the board), not merely received, and is the sole durable retire; (c) redelivery is **liveness-driven, never clock-driven**, so a received-but-un-handled Send re-queues for the next lead only once its holder is confirmed not-listening (dead), with **no timer on the message**; (d) **Idempotent Receiver** (dedupe by the threaded message id) makes any accidental duplicate harmless, and a rare double-handle on crash-after-work-before-ack is inherent to at-least-once and acceptable for a whiteboard; (e) **liveness = an armed listener exists** (a parked waiter, never a bare heartbeat), and the unavoidable wake→re-arm gap is bridged by a **~2 min HEALTH-CHECK grace window** (the lead grace window) framed on the liveness concern, honest and separate, never a message state; on death-declaration the server runs `presence.unregister(deadSid)` and drops its markers so the next `/whiteboard open` registers a genuinely new sid (no stale rebind, `/session/register` ~713) and the re-queued Send drains cleanly to the new lead, while a same-process rebind that beats the grace keeps its session and in-flight work; the default (120s) sits above observed turn length because the grace does not only arbitrate genuine crashes — a live-but-slow turn that runs past it with no bridge call is itself declared dead, re-queuing and redrawing that lead's in-flight Send (visible, and **[v9.11 #64]** not idempotent: a redraw doubles the drawing, so a redelivered Send carries `refetch: true` and the lead finishes it, §4), an effect the larger default reduces but does not eliminate (§9); (f) the lead's Send states **lose `stalled` entirely** (`queued → working → handled`), and the banner debounce is the grace window (stop reading transient a false parked flag as "session ended", the state that forced `recipientNotListening`/absent at App.tsx ~1053/~1077 and `lifecycleLabel` ~91); (g) **P1 (relaunch-first on wake) stays but is load-bearing for liveness + latency, not a lease clock** (a slow re-arm now costs latency, not correctness, since the grace window + idempotency cover it); (h) **WORKERS keep their own `STALL_MS` reclaim** (genuine competing consumers, being many, revivable, with no takeover event), so lead and worker **diverge on purpose**. **Two cautions recorded (accepted from the design review):** do **not** over-correct into a rewrite, and refactor test-first off the existing P6 reproduction (`repro-p6.mjs`), writing "the lead is never stalled while its session is alive" as a failing test first and making the smallest change that passes it; and **prove the worker/revive path does not depend on the shared sweep** before removing the lead's timer, so a lead-only carve-out cannot break revival. **Supersedes the v9.2 clause of #48** (parked-waiter sparing in the sweep + the per-message timed lease) FOR THE LEAD; #48's always-listening background waiter otherwise stands. §8.5, §9, §7, §13 (supersedes #48 v9.2 clause) **[v9.11] Amended by #64:** "complete means handled" and at-least-once stand; the lead's receipt is per item, stamped by its own fetch, and redelivery happens on a new owner. |
| 56 | **[v9.5] A malformed exec can never silently sever sync** | **The proven problem:** an `/exec` blob that produces a schema-invalid record (the classic: a geo shape with a top-level `w`/`h` instead of under `props`) makes tldraw's editor call `store.markAsPossiblyCorrupted()` **inside** the failing `store.put`, before the JS throw reaches the exec handler's try/catch. The flag is **sticky with no public reset** (`@tldraw/store` `Store.js:734-741`); while set, `@tldraw/sync-core` (`TLSyncClient.js:175`) silently suppresses **every** outbound push though the socket stays connected, so later well-formed execs return `ok:true`, render locally, and **never reach the room** (the board freezes at the poison point, every signal still healthy). **The decision (a three-level fork):** (1) **prevention**, a best-effort **validate-first store-guard** that rejects a schema-invalid record (`ok:false` + the validation message) before it reaches the crashing `store.put`; it reduces recovery frequency, is not exhaustive for arbitrary blob JS, and so is **not** the guarantee; (2) **honest contract**, where `ok:true` means **confirmed present in the room**: the server bounds-waits for the room `documentClock`/shape-set to reflect the write and reads the corruption boolean, **per exec** (this same check **is** the detector), returning a distinct `sync-severed` `ok:false` on a severed write; the existing launch/navigate `verifyCanvasSynced` (a different boot race) is unchanged; (3) **recovery**, a **server-owned** auto **harvest→reload→reapply** (reload rebuilds the store, the only way to clear the sticky flag; reapply is an idempotent create-or-update keyed by shape id), then **notify** (an `/agent-message` + panel line naming the recovered shape count), **loop-guarded at max 2 attempts per incident + a short cooldown**, then stop and surface loudly. Harvest carries only valid records (the poison was rejected at `put` and never landed), so reapply does not re-poison in the normal case; the guard covers the pathological edge. **Rejected alternatives:** **silent-only recovery** (recover but say nothing), rejected because a severed board must be **announced**, not quietly patched, so the operator knows a draw was re-applied; **catch-and-reset the flag** (let it corrupt, then clear the boolean), **impossible** because the flag has **no public reset** (`Store.js:734-741`), which is exactly why recovery must rebuild the store via reload; **periodic-only detection** (a background sweep polling store health on an interval), rejected because it reintroduces latency and lets a severed write return a false `ok:true` in the meantime, whereas the **per-exec** check makes the contract honest at the moment of the write. **The sync-integrity invariant:** an `/exec` that returns `ok` has reached the room; a corrupted store is auto-recovered and announced, never silently dropped. **Local to this skill**, nothing upstreamed to tldraw. **Amended by #67:** a put-back from the server and a record-by-record success test replace the reapply through the canvas and the room-clock success test, and the invariant now names a corrupted store that a sync-health probe reads (a page too blocked to answer it gets a plain reload). §5, §1, §2, §11 |
| 57 | **[v9.6] Lockfile records the owning session** | **The proven problem (from the board-teardown incident):** the lock `{ port, pid, board, startedAt }` lets a second `/whiteboard` detect *a* live process but not *whose*, so a session that did not boot a board cannot tell it is a **guest** on a board another session drives — one input to the incident where a lead tore down a **shared, live** board. **The decision:** the process is handed its booting session's identity at boot via `WHITEBOARD_OWNER_SESSION` (the human-readable CC session name, the same value #54 uses for the tab title) and `WHITEBOARD_OWNER_SESSION_ID` (the **stable** `CLAUDE_CODE_SESSION_ID`), and writes both into the lock (`ownerSession?`, `ownerSessionId?`, both optional). `/canvas-status` echoes them. On boot/attach a second session compares the lock's `ownerSessionId` to its **own** session id: **match ⇒ owner**, **mismatch (or an owned board it did not boot) ⇒ guest**; a guest draws as a peer but performs **no destructive act** (`/done`, or stealing the lock) on a **live** board another session booted — **not even on an explicit operator close**, which is carried out from the **owning** session (#59). A guest reclaims a lock only when the board is **stale/dead** (the ordinary boot path). **Why the CC session id, not the whiteboard `sessionId`:** the comparison must be computable by the second session **before it registers**, and both sessions can read their own `$CLAUDE_JOB_DIR/state.json`; the whiteboard `sessionId` is assigned only at registration and would need a post-boot lock rewrite. **Backward-compatible:** every reader parses by field name (the lone in-process reader `readLock` still validates only `port`/`pid`), so the added fields break nothing; an ownerless lock is treated as foreign by any session that did not boot it. §8.3, §9, SKILL §1, §5 |
| 58 | **[v9.6] Client disconnection guard + teardown export-now broadcast — the root fix for silent loss** | **The proven problem:** `app/src/App.tsx` joins the room via `@tldraw/sync` `useSync({uri, assets})` with **no `persistenceKey` / no IndexedDB** (`localStorage` holds only UI prefs), so a tab whose server has died keeps accepting edits into an in-memory store that **syncs nowhere, with no warning** — the mechanism by which the incident's disconnected collaborator lost work. Fixes #57 and #59 prevent the *improper teardown*; this is the **defense-in-depth** that prevents *silent loss regardless of the disconnect's cause* (server crash, network, or a teardown). **The decision (both halves):** (a) a **client-side disconnection banner** — the human render (never the headless agent canvas) reads the `useSync` status wrapper (`store.status === 'synced-remote' && store.connectionStatus === 'online'`, the same expression the `sync-health` probe uses), and when the socket stays down past a short **debounce** (~2.5s, to ignore tldraw's normal brief auto-reconnects) shows an unmissable canvas-overlay "**disconnected — your changes are not being saved, export now**" alert; and (b) a **teardown broadcast** — `shutdown()` sends a new `server-closing` frame over the existing `broadcastToHumans` channel **before** the sockets close (with a ~150ms flush delay), which the client shows **immediately** (no debounce, it is definitive) as "**this board is closing — export now**." The banner is the load-bearing piece (it fires on any disconnect); the broadcast is the belt-and-suspenders for the graceful-teardown path. **Rejected:** relying on the SKILL.md prose fixes alone — the loss is **silent by design of the sync client**, not a server bug (`/done` correctly snapshots and closes; the loss is client-side), so the real protection must live in the client. **Requires an app rebuild** for both the browser and the headless render-canvas to pick it up. §8.1, §3, SKILL §5, §11 |
| 59 | **[v9.6] Teardown always requires an explicit operator close; copy-then-switch homing; pre-teardown gate** | **The proven problem:** the incident's `POST /done` was a **discretionary, unauthorized** teardown of a shared live board, reached by mis-reading a natural-language "switch us onto the moved file" (a *keep-working* instruction) as teardown authorization, and by using `git mv`+reboot to free the live file when the file could have been homed with the server untouched. **The decision (three clauses, all hardening #49/#50/#53):** (1) **absolute rule** — a lead performs `/done` **only** on an explicit operator instruction to close *this* board (the confirm-gated directive #53, or an unambiguous "we're done, you can disconnect"); it is **never** inferred from finished-looking work, a full board, a file/migration/"switch" request, or silence — when in doubt, **ASK and keep listening** (the symmetric twin of the #49 stay-connected invariant). (2) **Copy-then-switch homing** — a live board's `.tldr` is homed by `cp`-ing the ≤~2s-fresh snapshot to the tracked path **while the server stays live** and committing the copy; `git mv`+reboot is a teardown in disguise, reserved for an explicit operator teardown (§8.1). (3) **Pre-teardown safety gate** — before any `/done`, `GET /canvas-status`: **refuse** if the session is a **guest** (foreign `ownerSessionId`, #57), and **re-confirm on the board** if `humans` shows a peer it cannot account for (e.g. solo work but `humans > 1`), rather than closing silently; only an owner with accounted-for peers proceeds. The `/done` export-now broadcast (#58) then warns any remaining peer before the sockets drop. **Operator directive:** the human must **always** have explicitly instructed or approved the close — this is a hard invariant, not a heuristic. §6, §8.1, §8.3, §9, §11 (hardens #49/#50/#53) |
| 60 | **[v9.7] Lead delivery is acknowledged by consumer receipt, not by the server's write** | **DECIDED and BUILT** (test-first: a lost-wakeup test (retired with the poller by #64) reproduced the strand on demand with a raw frozen socket and asserts the restored invariant; boards P/Q/R in `integration.test.ts` and the poller's self-test were updated to the new ack contract and stay green). **The proven problem (2026-09-25 incident, reproduced on/off):** the lead's clockless delivered-marker (#55) is stamped in `markDelivered` on the server's **write** to a parked waiter (`serviceWaiters`/the `/next-instruction` drain), which is **not** proof the consumer received the bytes. The operator's laptop slept mid-poll, leaving the lead's parked socket **half-open** (peer gone, no FIN), so the server's `res.json` of the first Send `877c1f66` buffered into the kernel and was **lost** — but `deliveredAt`/`deliveredBy`+the lease were already committed. Because the lead lease is reclaimed **only on a confirmed-dead session** (the dead-lead sweep) and the session **re-armed and stayed alive**, the Send was stranded `working` forever and skipped by `nextPendingFor` on every later poll, so the operator had to send a **second** Send to get a response, and the UI showed a stuck `working` badge. Neither weaker option holds: **commit-on-flush** cannot detect a kernel-buffered write to a frozen peer (`finish` fires regardless); **redeliver-on-re-arm without an ack** busy-loops, because a well-behaved lead re-arms **before** completing, so "held + fresh waiter" is indistinguishable from a lost delivery. **The decision (the design review's lens: move the acknowledgment from the producer's transmission to the consumer's receipt — JMS client-ack, not auto-ack):** add a receipt-ack POST, which the poller script sends on a `200` **before it exits**, stamping a **`receivedAt`** third state between `deliveredAt` (written) and `completedAt` (handled); and at the lead's arm, **before the drain**, the lost-delivery reclaim reclaims and re-serves any held receipt that is **delivered-but-un-`receivedAt`-acked** and whose holder is **this re-arming session** (the single-poller re-arms only after its prior socket closed, so that socket is provably gone and never confirmed receipt). Still **liveness-driven, not clock-driven** (the re-arm is the liveness event); still **at-least-once**, never a strand; **lead-only** (workers keep the `STALL_MS` lease, which already reclaims a lost worker delivery on silence). A (re)delivery clears any prior `receivedAt` (`markDelivered`) so an earlier lead's ack cannot immunize a re-queued Send, and the ack carries a `deliveredAt` nonce so a stale ack for a superseded delivery is a no-op. **The ack is load-bearing, not best-effort:** it is the only guard against a re-arm re-serving a consumed Send, so a *persistent* ack failure would redeliver every Send (bounded to one per Send by completion), not a rare one — the poller script therefore prefers a `node` parse, falls back to POSIX grep/sed when `node` is off its PATH, and WARNs loudly rather than degrade silently (the SPOF a review flagged). A *transient* miss stays a bounded, idempotent double. **Amends #55** (the marker is set on write, but receipt is now consumer-confirmed for lost-delivery detection); #55's clockless-by-session model otherwise stands. §8.5, §9 (amends #55) **[v9.11] Amended by #64:** receipt is confirmed by the consumer's own `GET /pending` fetch; the poller's ack and the lost-delivery reclaim are retired with the poller. |
| 61 | **[v9.8] A failed render export never reads as a fresh frame** | **DECIDED and BUILT** (test-first: `render-stall.test.ts` reproduces the stale-200 on demand against a fake render-canvas on an ephemeral port and asserts the invariant; the toggle was proven by reverting the handler to the buggy resolve, which re-fails the regression). **The proven problem (2026-09-25, proven from code):** the rendered PNG has one producer — the headless render-canvas answering `export-image`. On a failed export (`editor.toImage` throws or yields no blob; leading suspect **WebGL/canvas context loss after a laptop suspend** — a live-but-degraded Chromium, not a dead socket) the app does **no upload** and answers `{type:'image', id, ok:false}` with **no `path`**. The bridge's `image`/`image-result` handler ignored the `ok` flag and called `resolveImage(msg.id, msg.path)`; with `msg.path` undefined, `resolveImage` did `w.resolve(resultPath || latestImagePath)` and handed the `/image` waiter the **stale last-good path**, so `GET /image` returned **HTTP 200 + a path whose PNG mtime/size/dims were frozen** while the live board had moved on. An agent that "verifies visually" then read an old board and drew a false conclusion (it corrupted a legibility gate). A second, latent hazard in the same function: `if (idx === -1 && imageWaiters.length) idx = 0` resolved the **oldest** waiter for an unmatched id, a second way a caller got a path meant for another request. `canvas-status` was structurally blind to export health (`connected` = WS open, `browserUp` = Playwright handle exists), so the stall showed every signal healthy. **The decision (bridge-side; the app already signals `ok:false`):** the image frame is **ok/err signalling only, never a resolve-with-path** — the fresh path arrives solely from `POST /image-upload`, which the app **awaits before** it sends the frame (so on success the waiter is already resolved and the frame is a no-op), and on `ok:false` the bridge **rejects** the waiter (`rejectImage`) so `GET /image` returns **503 with the export error, never a stale 200**. `resolveImage`/`rejectImage` match by **exact id only** (the idx=0 fallback is removed); an unmatched id resolves nothing and the waiter times out honestly. `canvas-status` gains `lastExportOk` / `lastExportError` / `lastExportAt` / `lastImageMtime` / `lastImageBytes`, so `lastExportOk:false` or a non-advancing `lastImageMtime` **is** the stall. **Rejected / deferred:** making the ack best-effort or resolving with an "explicit staleness signal" the caller must remember to check — a 503 is unmissable, a stale-but-flagged 200 is not; **render-canvas self-recovery after suspend** (reload the page on a detected context loss) is a separate concern **left out of scope** here pending its own decision. **Independent of #60:** bug #60 was a half-open socket on the *message* path; this is a *live* socket returning `ok:false` on the *image* path — a shared environmental trigger (suspend), separate mechanisms and fixes. **Bridge-only, no app rebuild** (the app already sends `ok:false`). §6.1, §5, §11 |
| 62 | **[v9.9] The whole-board export is size- and time-bounded, and the render-canvas silently self-heals** | **DECIDED and BUILT** (test-first: `render-cap.test.ts` proves region forwarding + the no-frame timeout health by toggle against a fake render-canvas on an ephemeral port, in its Phases A and B; **[v9.11 #64]** its Phases C to L prove the relaunch against the server's own real Chromium, after a renderer crash, a failed navigation, a switch during the relaunch, a relaunched renderer that stops answering, a switch during the boot launch, a renderer that stops answering during a switch's navigation, a switch to an empty board, a launch that succeeds after a give-up, with an `/image` parked when a switch navigates, perception during a frozen navigation and during a relaunch (§6.1), and what a failed `/exec` leaves: an answer that says the blob may have drawn after a throw, with a peer's edit kept, one the canvas did not answer run only once and drawing nothing after its answer, and a `503` rather than a false `ok:true` while the launcher runs a canvas for a board a switch left (§5); the app-side raster cap is not covered). **The proven problem:** the whole-board PNG export rasterized every shape at the bitmap default `pixelRatio` 2 (4× the pixels) with no size or time cap, so on the ~244-shape board in the degraded headless Chromium (software swiftshader, post-suspend) it hung/OOM'd the renderer — `GET /image` and every `/canvas-status` `lastExport*` field went `null` and the render-canvas Chromium died while `browserUp` still reported `true`; this is #61's explicitly deferred piece (render-canvas self-recovery after suspend). **The decision (five parts):** (1) **export scope** — a whole-board export **downscales to a bird's-eye**: compute the content (or requested) bounds, set scale so the raster's longest side ≤ `EXPORT_MAX_PX` (2200px), and pin `pixelRatio` to 1 (undoing the bitmap default 2); **all shapes stay visible**, only resolution drops, and an optional page-coordinate region — `GET /image?bounds=x,y,w,h`, forwarded verbatim on the export-image frame — renders a **full-detail crop** so the driving agent can zoom in on a piece of the diagram (malformed/non-positive bounds degrade to whole-board, never a 400; the `/image` JSON echoes the applied region as `{ path, bounds }` — `null` for whole-board — so a dropped/typo'd region is detectable, not a silent wrong frame [review amendment 2026-09-28]); (2) **client timeout** — the app wraps `toImage` in a **12s timeout** (below the bridge's 15s `WS_REQUEST_TIMEOUT_MS`, env-overridable via `WHITEBOARD_WS_TIMEOUT_MS`) so a hung render becomes a reported `{ok:false, error}` frame the bridge records as `lastExportError`, not a silent stall; (3) **server timeout health** — `requestImage` records `lastExportOk:false` / `lastExportError='export timed out (no frame from render-canvas)'` / `lastExportAt` when an export times out with **no frame at all** (a hang, or a page that is gone), where it previously recorded nothing — the exact all-`lastExport*`-null signature of this stall; (4) **supervised self-recovery** — `launchRenderCanvas` registers **identity-guarded** browser `disconnected` and page `crash` handlers (a stale browser's late event, e.g. from the intentional close of the corpse, can't tear down a recovered canvas) that null the browser/canvasPage handles (so `browserUp` stops lying) and relaunch the same room with a **bounded retry** (up to 3 attempts, backoff, post-launch liveness re-check for a crash during the verify window; a parked `/image` waiter is failed fast rather than left to the WS timeout), guarded against re-entry and against the graceful teardown path (`shutdown()` sets `shuttingDown` before closing the browser, so that close is not mistaken for a crash). Recovery is **silent** (server-log only, no panel message — a deliberate contrast with #61's corruption-recovery, which announces via `postSystemMessage`; a missed export beat is self-healing and not worth a chat line), **but an exhausted, unrecoverable self-heal is surfaced on `/canvas-status`** (`lastExportOk:false` + `lastExportError`) so a permanently dead canvas is attestable rather than a silent null [**review amendment 2026-09-28**, operator-approved: the original "silent" covered a routine blip; a one-shot relaunch that gave up terminally, or a crash-at-launch loop, would have made a permanent death or resource churn invisible, so the retry is bounded and the give-up speaks — still no chat-panel line]; (5) **decouple** — the redundant spontaneous post-exec app-side export is removed; `runExec` already issues its own tracked `/image` request (the single verify-after-write source), so the second full-board render was pure duplicated OOM pressure whose failures were invisible to health. **Rejected:** **region-only** (breaks see-the-whole-board), a **shape-count ceiling** (silently drops shapes), and an **announced restart** (a missed export beat is not worth a chat line). **Extends/amends #61** — delivers its deferred render-canvas self-recovery and adds the OOM cap the stale-frame fix did not address. §6.1, §5, §11 |
| 63 | **[v9.10] A lost log sink is never fatal, and shutdown always ends in an exit** | **DECIDED and BUILT** (reproduced live, then toggle-proven: `busy-loop.test.ts` boots a real render-canvas and fails 9 assertions against the pre-fix server, passing all 16 against the fix). **The proven problem (2026-09-25: twenty processes pinned a 16-core machine; 2026-10-19: five more, 21 days old, ~100% CPU each; a `sample` showed `uv__run_check → TriggerUncaughtException → FormatStackTrace`):** a board process outlives the session that booted it, as #50 intends, but when that session started it with stdout/stderr on a pipe, the session's end closes the pipe's read side. The process's **next log line**, any line (a render-canvas death and its self-heal write several, and so does a chat message or a room persist), fails `EPIPE`, which Node emits as an `'error'` event on `process.stdout`/`process.stderr` with **no listener**, so it became an `uncaughtException`. The handler logged it with `console.error` **to the same dead pipe**, raising the next `EPIPE` and the next `uncaughtException`: a self-sustaining fault loop. Its first pass called `shutdown(1)`, which set `shuttingDown` and then stalled at its first `await` (the 150ms broadcast flush), because the fault stream starved the timer it awaited (instrumented live: shutdown entered, never reached the snapshot); every later pass hit the `shuttingDown` guard and returned, so nothing could reach `process.exit`. The render-canvas death in the reports is a **trigger, not the cause**: a healthy canvas spins the same way on the first logged line, and pre-fix the loop also blocks the #62 self-heal, because `handleRenderCanvasDeath` returns early once `shuttingDown` is set. **The decision (three parts):** (1) **a lost log sink is never fatal**: the server attaches `'error'` listeners to `process.stdout` and `process.stderr` that swallow write errors, so with nobody reading, logs are dropped and the board **keeps serving** and self-heals, as #50 and #62 require; (2) **a hard exit deadline**: `shutdown()` arms a ref'd `SHUTDOWN_DEADLINE_MS` (5s) timer before its first `await`, which runs `flushFinalState()` (the synchronous final `.tldr` snapshot and lock removal, factored out of the graceful path and idempotent) and exits, so a teardown that hangs (a frozen Chromium never answering `page.close`) still ends; the graceful path is unchanged when it completes; (3) **a fault during shutdown exits at once**: an `uncaughtException` that arrives while `shuttingDown` runs `flushFinalState()` and `process.exit(1)` directly, never handing back to `shutdown()` (whose guard would swallow it) and never waiting on a timer (which a fault storm can starve). Playwright's own process-`exit` handler kills the launched browser, so a hard exit leaves no Chromium behind (asserted for both a killed and a frozen browser). **Rejected:** **treating render-canvas death as fatal** (shutting the server down when the canvas dies), because the canvas death is not the cause and the server spins with a healthy canvas, and because it would undo #62's self-heal and #50's survival of a session end; **a deadline alone**, because the fault loop starves timers, so the deadline cannot end the loop on its own, and the `EPIPE` must stop being an exception; **exiting on `EPIPE`**, because a board that lost its booting session's pipe is exactly the board #50 keeps alive for the next `/whiteboard open`. §11, §8.3, SKILL §5 (hardens #50) **[v9.11] Amended by #64:** the board no longer survives its session; the owner watch exits it with its parent, and this decision's stdio and deadline fixes let that exit complete. |
| 64 | **[v9.11] The lead is rung through its session inbox as a doorbell, pulls its work, and the board server lives and dies with its owning Claude process** | **DECIDED and BUILT** (architecture review 2026-10-19, operator-approved with every recommendation taken; test-first: `doorbell.test.ts` rings a fake inbox socket that accepts, drops, holds and deduplicates, and proves the pull, the receipt, coalescing, re-ring, not-heard, ENOENT/ECONNREFUSED, the canary, the owner watch, same-port restart from `<name>.port`, drain on open and the Origin/Host guard; `busy-loop.test.ts` gains the owner-death phase. Hardened in review before it shipped, in this order: the port sidecar, the process-based attach check, guests, the pinned fetch, the boot-shape check and the panel's held Sends; one hosted room with eviction on switch, the board-path check, `WHITEBOARD_PORT`, the guest/worker key refusals and the panel's ordered outbound queue; `claimLock` at boot and in the switch, the `/events` room guard, the `guest-` key prefix, atomic snapshot writes and the panel's retry while connected; `held` on `/canvas-status` with the four-way probe and its bounded wait, the three exit-3 lines, the transactional switch, the `clientKey` character check and the temp-file sweep; the relaunch into the active board, the switch's navigation standing aside and render-cap Phases C to E; the one launcher, the bound on every wait on a Chromium, the launch generation, `relaunching` on `/canvas-status` and render-cap Phases F to H; readiness as answering and connected on every launch and navigation, the perception wait on a switch, the withdrawn give-up, render-cap Phases I and J, the ring naming its skill, the teardown item's `at`, the canary logged by its kind and a switch commit that cannot throw; `refetch: true` on a Send drained on open, the refused create onto an existing id, `createdBy` carried across every later local write, the perception wait without its own bound and render-cap Phase K; a worker's redelivered Send marked `refetch`, an unanswered `/exec` answered `ok:false` and never re-run, the `/exec` stand-aside while the launcher runs for a board left, and render-cap Phase L; every `ok:false` from a blob saying it may have drawn and to write what is missing under a new key, in place of an earlier undo of a thrown blob, which reverted a peer's edit, and step (b) matching a `refetch` Send's work by `name`; the reload that ends a blob the canvas did not answer before the bridge answers, which stopped such a blob drawing a second copy of what the agent then wrote, under another agent's name, and an answer that names the stamps and covers an update or a delete that did not land; and a sync-health probe after every exec, so a peer's change in the confirmation window no longer hides a write a corrupted store cut off, which the reload would then have discarded, and an answer that tells the agent to leave what someone else has edited since). **Builds on #63.** **The proven problem:** between 2026-09-22 and 2026-10-14, eight of twelve observed delivery failures came from the background listener's lifecycle, not from the queue: a turn that ended with no parked listener (F1); a lease falsely reclaimed mid-turn (F3); a long turn that outran the 120 s lead grace window and was declared dead (F4); a forgotten relaunch that left a Send waiting 52 minutes despite the in-band re-arm reminder (F5); an attaching session that never armed its own listener because the board-wide parked flag was already true (F8); an orphaned poller Claude Code reported dead while it lived (F9); background commands killed at exactly two hours, 21 times across 16 sessions (F10); and a half-open socket after laptop sleep whose receipt-ack fix then caused a self-sustaining redelivery loop (F6/F7). Separately, orphaned board servers reparented to launchd and pinned CPUs (twenty on one 16-core machine on 2026-09-25; the busy-loop itself is #63). #52's premise, that polling "matches Channels on reliability", did not survive this evidence. **The decision (four parts):** (1) **A doorbell, not the Send's text.** The board server posts to the owning session's inbox socket (`$CLAUDE_CODE_MESSAGING_SOCKET`, token from its own environment, never over HTTP, never written to disk or logs) a fixed ring built only from validated fields — board slug, count pending, ring counter, newest item ref, the exact `GET /pending` fetch command — so no operator or HTTP-supplied text reaches the inbox. The skill fetches only the port it captured at boot, with its own session id, never a URL a message names: any session in the same permission mode can post a message in the ring's format, and what the fetch returns is the operator's words, so the fetch target must come from what the session already holds. Every inbox post reaches the model framed as from another session, "not typed by your user", with a standing refusal to edit settings, `CLAUDE.md` or config on a peer's request, which would block an operator's most legitimate Sends ("update SKILL.md", "commit it"); overriding that framing in SKILL.md would launder a peer into the user for every peer. A ring asks only for a read of the session's own board. (2) **The pull is the receipt, and absence is loud.** `GET /pending` answers at once with the canary, the lead's Sends, the teardown item and revive items, oldest first, and stamps `receivedAt` on each Send it returns. The inbox gives no receipt (it drops on its rate limit, identical bodies, a full queue, an expired hold, and a remote kill switch), so an unfetched item is re-rung at about 30 s, 2 min and 10 min with a new counter each time, and two minutes after the last is marked **not heard** in the panel; a failed post (ENOENT, ECONNREFUSED) marks it at once. Items coalesce into one ring. While the lead has unfetched items, every bridge response it calls while drawing carries `pending: [ids]`, because Claude Code shows an inbox message when the current tool call returns, never during one, so a ring cannot interrupt a draw but the `pending` field can. A fetch needs no ring (`/pending` checks only the sid): the skill also fetches when the operator says they Sent something and after a failed canary, and an empty fetch means the ring was already answered. At open, the first ring is a **canary** whose nonce only the ring carries; the open procedure must fetch it back before calling the board ready, proving server, inbox, model and fetch together. `/canary` answers `409` with `no inbox socket in the server's environment` or `not booted as this session's child`, `502` when the ring could not reach the inbox, `504` when none was attempted within 5 s, and `403` to any session but the lead. (3) **The board server is the session's own child and exits with it** (2 to 1; the Claude Code expert dissented in favour of a per-session relay that keeps the board up between sessions). The skill boots it as the foreground of a `run_in_background` job with exactly `exec bash <skill dir>/scripts/whiteboard.sh start --board '<absolute path to <name>.tldr>'`, whose last step is `exec node --import tsx index.ts` (Port decisions, §9), verified at build to leave the Claude process as its direct parent with no process between, and holding nothing that can fail before `exec`. The server resolves its owner from the environment it inherits (`WHITEBOARD_OWNER_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, else `$CLAUDE_JOB_DIR/state.json`'s `id` or `sessionId`; `WHITEBOARD_OWNER_SESSION`, else that file's `name`), exits 1 at boot unless a set `WHITEBOARD_BOARD` is an absolute `.tldr` path whose directory exists (`[bridge] WHITEBOARD_BOARD must be the board's absolute .tldr path (got <value>)`), and records `ownerIsClaude` (`process.ppid === CLAUDE_PID`, `null` when `CLAUDE_PID` is unset) on the lock and `/canvas-status`; its `npm start` refuses and exits 1; the inbox then verifies every ring as the session's own child, which is what lets it through without an approval hold in bypass sessions. The server records its parent pid and checks it every 2 s; when the parent dies or changes it writes the snapshot, removes its lock (only when the lock names its own pid) and exits. That reaps orphans and keeps a server from ringing a dead session's socket path, which a later session reusing the pid could own. The board's port is a separate fact with the board's lifetime: `<name>.port` records it after `listen`, the next boot takes it unless `WHITEBOARD_PORT` overrides it (falling back to an ephemeral port, rewritten, when it is taken; `PORT` is never read, so a value inherited from the operator's shell cannot move the board), and only `/done` removes it (when it names this server), so a new owner boots from the snapshot on the same port and an open tab reconnects. The server hosts one room, the one its lock names: one `hosts(room)` check refuses a `/sync/<room>` upgrade or an operator tab's `/events` upgrade (`404`), and a `POST /message` or `POST /request-teardown` (`409` `this server is hosting a different board`), naming any other room, so `humans` on `/canvas-status` counts only tabs on the hosted board and the skill opens a tab only when none is there. An in-app switch is a transaction inside `runExclusive` that commits or changes nothing: it claims the target's lock and loads the board in a `try` (a `409` when a release wait runs out, a `422` when the snapshot cannot load, each releasing what it claimed), commits, releases the board it leaves at once (its sync sockets and operator event sockets closed, any in-flight save awaited, flushed once, dropped from memory with its cached Send log, leases and teardown flag, then its lock removed), answers `200` with the new `room`, and only then navigates the render-canvas, recording a failure as `lastNavError` and handing off to the render-canvas launcher, the only one: the boot launch and every relaunch go through it, the switch's navigation stands aside while it runs, and `/canvas-status` then reads `relaunching: true`. It always ends, because every wait on a Chromium in it is bounded (a call at 15 s, a launch or navigation at 30 s, the old browser's close at 3 s), and each attempt at 120 s; a canvas that does not answer, or does not connect its bridge socket, counts as a failed attempt, and after three it records `self-heal failed`, which a later launch that succeeds withdraws. A switch's navigation ends on the same readiness, an empty board included, and `/image` and `/shapes` wait for it, so they answer for the new board, or `503` with `relaunching: true` while the launcher runs. It comes up on the board that is active when it finishes, relaunching there at no attempt cost if the board changes meanwhile; a launch generation, bumped by every attempt and every close, keeps an attempt given up on from acting on a newer canvas; one Chromium serves the canvas, plus at most one being closed, which Playwright kills within 30 s; and a successful relaunch clears `lastNavError`. The exit flush writes and unlocks every board the process holds, after awaiting any save in flight; every snapshot write goes to a temporary file renamed into place, so no exit leaves a torn `.tldr`, and a boot deletes the temporary files a dead pid left. So a stale tab never opens a second copy of its board, nor stores a Send or a close, on another board's server; a switched-away board is held for milliseconds and stays in `held` until its lock goes, so a claim waits for its release rather than taking it; and switching back reloads it from disk. One `claimLock` helper makes the one-server check where the lock is written, with nothing awaited between its last check and the write. It asks the lock's process what the lock means: `/canvas-status` reports `pid` and `held` (every board whose lock names that process), and the probe answers `active`, `releasing`, `unknown` (a live pid whose probe timed out or failed with any error other than a refused connection, never read as gone) or `stale`, and only `stale` is claimed. An `active` owner is refused at once; the claim re-probes while the answer is `releasing` or `unknown`, for up to `RELEASE_WAIT_MS` (10 s, `WHITEBOARD_RELEASE_WAIT_MS`), then refuses. At boot this runs before `listen`, with a waiting line that names the state (`is being released by` or `which is not answering`), and a refused boot exits 3 with one of three lines, `already served`, `still being released` or `which does not answer` (§8.3): on the first the skill returns to its step 2 once and attaches, and on the others it reports the line and does not retry, adding for `which does not answer` what `ps -p <pid> -o comm=` shows. Inside the switch's exclusive section an `active` owner answers `attach`, so a switch queued behind an `/exec` never takes the lock of a server that booted its target meanwhile. The only remaining window is two claims within the same instant, accepted for a solo POC, which only an `O_EXCL` lock create would close. Every operator Send, held or new, and the close request leave the panel through one ordered outbound queue: one POST at a time in the order typed, each timing out after about 10 s, the in-flight line reading "sending" and a line behind a POST that has not failed reading "waiting to send". A Send typed while the board is down is never stored: the drain stops, that line and every line behind it read `unsent` ("not sent: sends when the board is back"), and they are re-posted in order under their own ids on a new Send, after each successful POST, on every reconnect and, while the events socket stays open, on a retry backing off at 2 s, 5 s, then every 10 s (`/message` dedupes on the id); a `4xx` reads `failed` ("not sent (<status>)"), is never retried, and lets the drain continue. Uncompleted lead Sends are unfetched again for the new owner (drain on open). Rings go to the owner only; an attaching session becomes owner only when the server is gone (#33). Ownership is the process, not the session id: an attaching session is the lead only when the live lock's `parentPid` is its own Claude process (`${CLAUDE_PID:-$PPID}`), since two processes can share a session id; any other is a guest, registered with `guest: true` on its own key (`guest-${CLAUDE_PID:-$PPID}`, unique per Claude process; a guest's key must start `guest-` and a worker's must not, each a `400` otherwise, so the two never collide, across a restart included, and a key holding `$`, `{` or `}`, a template that reached the server unexpanded, is a `400`), shown for its presence, excluded from recipients, revival and broadcasts (a Send to it is a `400`), and never rung. A live lock with no `parentPid` was written by a server from before this decision, which never exits with its session and may ignore SIGTERM; a boot or an in-app switch refuses while one runs on any board, and the skill stops it only on the operator's go-ahead, SIGTERM and then SIGKILL after 5 s, and boots (#65). (4) **Direct cutover, and every route guarded.** Retired with no fallback: the background poller script and its self-test, the in-band re-arm reminder, the lead grace window, the board-wide parked and lead-liveness signals, the lead's merged long-poll, the receipt-ack route and the lost-delivery reclaim, and the lead's clockless receipt marker; liveness is per item (rung / fetched / completed / not heard). **The worker self-park is not part of the retired concept and stays**: each worker long-polls its own queue, with its lease, revival and nudge unchanged, except that a revive is raised only for a quiet worker holding no live lease on any of its pending Sends; `/next-instruction` now serves workers only. Because the pull now stamps the receipt, every HTTP and WebSocket route checks Origin and Host (loopback Host on the board's port, Origin absent or the board's own, `Sec-Fetch-Site` absent, same-origin, none, or same-site on a top-level navigation), so a web page cannot fire a no-cors GET at `/pending` and strand a Send, nor post a teardown. **Rejected:** Send content in the inbox post with a receipt-driven re-post (lost on the framing, and it saves no tool call); a per-session relay (the dissent; a second process with its own reaper and a stale-subscription failure); `crossSessionInbound: accept` in user settings (would let any steered session reach every bypass session); forging a bypass envelope field; a skill-scoped Stop hook backstop; raising `BASH_MAX_TIMEOUT_MS`; a polling fallback (it would keep the lifecycle this removes). **Supersedes #26** (which declined socket injection as coupling to an internal: the inbox is a documented per-session feature, used here only as a doorbell), **#48** (the always-listening background waiter and its re-arm guarantees) and **#52** (polling as the settled mechanism, Channels as the only upgrade). **Amends #50**: a board's lifetime is now its owning Claude process's, not independent of it; after a session ends the board is down until the next `/whiteboard open`, content and port intact, and a `/tasks` stop of the board's job takes it down the same way. **Amends #55**: the lead keeps "complete means handled" and at-least-once redelivery, but its receipt is per item and redelivery happens on a new owner, not on a grace window. **Amends #60**: receipt is still consumer-confirmed, now by the consumer's own fetch rather than a transport's ack. **Amends #63**'s stance that the board survives its session (kept for #50): the owner watch exits the server with its parent, and #63's swallowed stdio errors and 5 s hard-exit deadline are what let that exit complete on a dead pipe. **Live dry run, 2026-10-19** (Claude Code 2.1.292, a bypass-permissions session): the server's direct parent was the Claude process; the canary rang and was fetched back; an idle Send rang with no approval hold and was drawn; a mid-draw "stop" was caught on the first `/exec`'s `pending` field; an "edit SKILL.md" Send was acted on; a spawned worker drained a Send queued before it parked, and a Send to the finished worker rang the lead, which revived it; the operator's close tore the board down cleanly. The run surfaced a revive raised for a worker that was alive and drawing but not parked, a second revive while the resumed worker was still re-registering, and a revived worker returning in a new cursor color; all three are fixed here (`REVIVE_QUIET_MS`, a 60s `REVIVE_GRACE_MS`, and a per-key color). Not yet exercised live: the canary failing under `crossSessionInbound: hold`, a same-port restart reconnecting the operator's own browser, and a Send held as `unsent` across a restart. §1, §2, §3, §4, §6.1, §7, §8.2, §8.3, §8.5, §9, §11 (supersedes #26, #48, #52; amends #50, #55, #60, #63; amended by #65) |
| 65 | **[v9.11] A live server from before #64, on any board, refuses every boot and every in-app switch** | **DECIDED and BUILT** (operator decision 2026-10-20, extended the same day to the in-app switch; test-first: `doorbell.test.ts` `[pre64]` starts a live node process answering `/canvas-status` as a pre-#64 server does, behind a lock with `pid` and `port` and no `parentPid`, and proves that a boot of another board exits 4 with one line naming its pid, port and board and writes no lock, port record or board file; that one on the booted board itself exits 4, not 3; that two, one of which accepts and never answers, are named on one line; that a lock with a dead `pid`, a live `pid` with nothing on its port, or a live `parentPid` does not refuse; and that once the process exits, its lock left on disk, the boot proceeds; `[pre64-switch]` starts such a process after a current server has booted, and proves that `/board/open` and `/board/new` then answer `409` naming its pid, port and board, with the server still hosting and holding only its board and the target given no lock or port record, and that once the process exits the switch proceeds. Against the server before each change, 12 of `[pre64]`'s checks fail, the other-board boots listening and claiming their board and the same-board boot exiting 3, and 12 of `[pre64-switch]`'s, each switch answering `200` and moving the server). **Builds on #64.** **The proven problem:** a server from before #64 never exits with its session, may ignore SIGTERM (#63), and after an in-app switch keeps the board it left in memory with no lock; such a server saves every dirty room it has loaded every 2 s and writes all of them again on exit. The skill looked for one only on the board it was opening, and a switch only at its target's lock, so a boot or a switch onto that lock-less board found nothing to probe, and two servers could then save the same `.tldr`, the old one's exit flush overwriting the new one's edits, and diverge on its cached Send log (#46). Every server started from code older than this decision is one. **The decision:** one check, `findPre64Servers`, reads every lock in `<scratch>/whiteboard/` and counts each with no `parentPid` whose `pid` is alive and whose port answers `/canvas-status` as a board server from before `pid` (`activeRoom`, no `pid`) or does not answer within 1 s; a refused port or any other answer is a reused pid. The boot runs it before any claim and, if any count, exits 4 before binding or writing anything, with one stderr line naming each pid, port and board. The in-app switch runs it first in its prepare step and, if any count, answers `409` with an `error` naming each one, which the panel shows in the switcher, and `oldServers`, claiming and releasing nothing. On exit 4 the skill asks the operator, who alone decides whether to stop it, because another session may be using it: on their go-ahead `kill <pid>`, then `kill -9 <pid>` if it is alive 5 s later, and boot again; if they decline, the skill neither boots nor attaches and tells them why; a switch the panel refuses is stopped the same way when the operator asks. The check runs in the server, not the skill, so no boot or switch can skip it, and it covers the booted board too, which folds the skill's former same-board check (step 2) into the one exit-4 rule. A port that does not answer counts, failing closed like `claimLock`'s `unknown`, because a server in #63's `EPIPE` loop accepts connections and never answers; `ps -p <pid> -o comm=` lets the operator see what the pid is before agreeing. **Rejected:** a skill-side scan before every boot (an instruction the agent can skip, where the server's check cannot be); counting a live `pid` alone (a reused pid would refuse every boot and put an unrelated process up for a kill); checking only the board being opened (the lock-less room this exists for); guarding the boot alone (a pre-#64 server started after a current one booted would stay invisible to that server's switch). **Amends #46** (the switch refuses while a pre-#64 server runs) **and #64** (the operator-confirmed stop now follows the boot's exit 4 or the switch's `409`, for a server on any board, and a decline offers no other board, since none can boot). §8.3, §9 (amends #46, #64) |
| 66 | **[v9.11] A Send is taken or retired only by the session registered as its recipient, and a board remembers its recipients across a restart** | **DECIDED and BUILT** (operator decision 2026-10-20; test-first: `integration.test.ts` board `wbtest_sid` fails 18 checks on the code before it and passes on this change; its restart checks (a Send to a worker that has not re-registered, and to one that was never sent anything) and the in-process switch on board O (a live worker carries over, a dead one registered only on the board left does not) fail 5 checks with the registry in memory and pass with it durable and per board; every existing call to `/next-instruction` and `/instruction-complete` in `integration.test.ts` and `doorbell.test.ts` that is meant to reach a queue now carries a registered session, and a worker succeeding another on one key registers after its predecessor unregisters). **Builds on #64.** **The proven problem:** `GET /next-instruction?for=<worker>` handed over a Send and stamped `deliveredAt`/`deliveredBy` and a lease for whatever `sessionId` the query named, a made-up one or none, and `POST /instruction-complete` stamped a permanent `completedAt` for any caller. Against a web page in the operator's browser the only defence was #64's Fetch Metadata check, and from any local process there was none: a fetch that is not the worker's leaves the Send `working` under a lease no live worker holds until the sweep reclaims it, and a completion that is not the recipient's retires the Send so it is never served or rung again. Separately, the recipient registry lived only in memory, against §3's "every `clientKey` ever registered": a restart forgot every worker key, so a worker's next fetch was a `400 unknown recipient id`, which reads as a bug rather than a lost registration, and the operator's Send to that worker was a `400` until it re-registered. **The decision:** (1) `GET /next-instruction` requires `sessionId`; missing is a `400`, a session this process does not hold (never registered, unregistered, keyless, or issued before a restart) is a `403` that says to re-register, and a session registered as another recipient is a `403`. Neither delivers, parks or stamps anything. `for=lead` or no `for` stays a `400`, and the Origin/Host/Fetch-Metadata check stays as the first layer. (2) `POST /instruction-complete` carries the same requirement, because completion changes delivery state for a recipient and does so permanently: the session must be registered as the Send's recipient, or on a broadcast as `for`, so the lead now passes its own `sessionId` as well. (3) The unregistered `403` is checked before the unknown-recipient `400`, so a worker whose registration is gone is always told to re-register; it re-registers on its `clientKey` (idempotent) and resumes, and the oldest Send that waited is served first. The revival nudge names the `sessionId` on both calls and the `403` recovery, still keyed on the `AgentId` alone. (4) The registry is per board and durable: `<name>.recipients.json` records each worker key the first time it registers on the board, and loading the board rebuilds the set from it and from the worker recipients on the Send log, the one board state that already survives a restart and names recipients, though only those that were sent something. A restart therefore forgets sessions but not recipients. **Rejected:** keeping the Fetch Metadata check as the only guard (it covers a browser, not a local process, and the 403 cannot tell a worker its registration is gone); scoping the check to `/next-instruction` alone (a forged completion strands a Send more surely than a forged fetch, which the sweep at least reclaims); rebuilding the registry from the Send log alone (it misses a worker that registered and was never sent anything); recording registrations in the Send log (every reader of the panel's chat log would have to skip them); keeping them in `<name>.port` (that record has the port's lifetime, and `/done` removes it). **Amends #43** (the registry is per board and survives a restart). **[Amended in review]** `for` left out of a completion defaulted to `lead`, so a worker completing its copy of a broadcast without it got a `403` naming its own key, and the nudge and `references/workers.md` read every `403` as a lost registration: the worker re-registered, got the same `sessionId` back, and was refused again. `for` now defaults to the key the session registered on, the only one the check accepts (a given `for` is still validated, `400` when unknown), and the nudge and the reference send a worker to re-register only on the `403` that says its session is not registered (`integration.test.ts` board `wbtest_sid` and the verbatim-nudge checks, 3 of which fail before this). §3, §8.3, §8.5, §9 (builds on #64; amends #43) |
| 67 | **[v9.11] Recovery writes the cut-off write back from the server, keeps a peer's newer edit, and counts success only when the room holds it** | **DECIDED and BUILT** (root-caused in review against the running server; test-first: `sync-corruption.test.ts` Boards P, U, H and D drive a fake render-canvas built on a real tldraw store and sync client, and Boards R and R6 drive the real render-canvas and app with a headless operator; of the 60 checks the suite held at this change, 20 fail at `825f571b`; settles the two open questions on recovery raised 2026-10-20). **Amends #56.** **The proven problem:** recovery reapplied every harvested shape through the canvas as an exec stamped `Claude`. It then counted itself recovered when the room's document clock had moved past where it stood before the reload. On a healthy board the reapply did reach the room, restamping every shape. The clock, though, was read about 100 ms before it got there: the reapply's exec answers once the blob has run, and the sync client sends its push on a later animation frame. In every measured run the clock stood still at the check and moved within 100 ms after it, on both attempts. So a throw inside `editor.run`, bare or the create guard's refusal, ended "Manual recovery needed" with every shape in place. Holding the check 500 ms reported the same throw recovered, in the one run made. The reapply's push reached the room more than 600 ms after the answer, so a recovery could report before it delivered. That timing broke recovery in six measured ways: (a) a peer's edit moving the clock let a recovery pass whose cut-off update never landed, measured with a canvas whose writes after the reload did not land; (b) a harvest the corrupted canvas did not answer reported "recovered" with nothing put back; (c) a cut-off delete was never put back, and the shape returned on the reload; (d) the reapply, a whole-record put of what was harvested before the reload, reverted an edit the operator made during the reload; (e) it restamped every shape's `lastEditedBy` as `Claude` at recovery time, so a worker read its own updates as someone else's; (f) being an exec, it sat on the canvas's undo stack, so `editor.undo()` at the top of the next blob reverted it. **The decision:** (1) **The put-back is the server's own write into the room.** After the reload, one `room.storage.transaction` writes, whole and validated against the room's schema, each harvested shape the room lacks or holds a different copy of. In the same transaction it removes each shape still in the room on the harvested page that the canvas no longer held, with the bindings to it. A client receives the transaction as a remote change, so no surface stamps it, it is on no undo stack, and it reaches the room at once rather than on a canvas's next frame. (2) **The room's newer version stands.** The harvest records the room clock the corrupted canvas had caught up to: its sync client's `lastServerClock`, read before the shapes, so every change the shapes may lack is later. A shape the room changed after that clock is left as the room holds it. A corrupted store still applies the room's changes, so a later change is one the canvas never saw. (3) **The success test compares records, not clocks.** Recovered means the canvas's store probes clean and the room holds, record for record, everything recovery meant to write and nothing it meant to remove. A harvest that fails, a record the schema refuses, or a room write that throws is NOT recovered. (4) **The loop-guard counts reloads.** The harvest and the put-back happen once per incident, and the put-back runs whether or not the canvas came back clean. **Rejected alternatives:** **counting success when every harvested id is in the room**, because a cut-off update changes a shape whose id is already there, and a cut-off delete leaves no id to find; **waiting longer for the clock**, which a peer's change still passes and which keeps the restamping and the revert; **reapplying through the canvas with no author**, which keeps the stamps but leaves the revert, the undo and the late push, and leaves the clock test unable to pass on a healthy board; **reapplying only what differs, through the canvas**, because the canvas's write still reaches the room a frame after the canvas read it, so an edit landing in between is overwritten. **The sync-integrity invariant**, restated: an `/exec` that returns `ok` has reached the room, a corrupted store that a sync-health probe reads is auto-recovered, and the panel says recovered only when the room holds what the corrupted canvas never sent. **[Amended in review]** As first built, the harvest was the canvas's current page's shapes, and the success test checked only what was harvested, so the panel said recovered while a record was lost: a cut-off arrow came back without its bindings, a cut-off create on another page was never put back, and after a cut-off `moveShapesToPage` and a return to the first page the removal pass read the moved shape as one the canvas deleted and removed it from the room. Each was reproduced on the real render-canvas. The harvest is now every document record on every page (pages, assets, shapes and bindings), asked for with `get-shapes` `records: true`, so `/shapes` is unchanged; the put-back writes them parents first, removes any of those kinds the canvas no longer held, and leaves to a peer's change a record whose page, parent or bound shape the room lacks, keeping a page or shape under a record that stays; the success test covers every record it meant to write or remove, and the panel line counts records by kind. `sync-corruption.test.ts` Board B drives the three cases and fails 5 of its checks before this; Board G covers a peer's change on other pages; and Board B fails if the render-canvas stops exposing `window.tlsync`, whose `lastServerClock` is the harvest's clock. **[Amended in review]** Four corrections. (1) The `/exec` answer carries the outcome as `recovery: { recovered, text, missing? }`. An agent had been told to read it from `GET /messages?since=<ms>` with a send time it was never asked to note, and the line lands a few milliseconds before the answer, so a time taken on reading the answer missed it. (2) A binding the operator made during the reload, to a shape the cut-off write deleted, was removed with that shape while the panel said it kept the change. A record the canvas removed now stays while a record staying in the room needs it, which replaces the binding cascade; the panel line counts the records left to a peer's change apart from the removed records kept for one that needs them, and says `put back nothing` rather than `the room was missing nothing` when it left a record to a peer. (3) An image's `assetId` is a reference the put-back checks and the removal keeps. (4) The whole-document harvest carried every inline image, and at 108 MiB the answer was more than one websocket message to the bridge may carry (100 MiB), so the harvest timed out where the earlier current-page harvest would have delivered. The app now sends each asset's data as its digest, and the bridge asks whole, one at a time, for the assets the room does not hold the same. `sync-corruption.test.ts` Boards M, K and L, and new checks on Boards X, H, G and B, fail 16 checks before this. **[Amended in review]** Four corrections. (1) A blob that corrupted the store and then outlived the ws timeout was ended by a plain reload, which discarded what it had drawn, with no recovery and no panel line, though this invariant and `references/exec-failures.md` said a corrupted store is recovered. On a timeout the bridge now probes the store, and when the probe reads it corrupted it runs recovery in place of the plain reload; recovery's reload ends the blob too, and a recovery that does not report recovered is followed by the plain reload, so the blob is still ended before the answer. A canvas that does not answer the probe (its page blocked) gets the plain reload alone, so the invariant now names a corrupted store that a sync-health probe reads. (2) One asset the canvas could not send whole failed the whole harvest, losing every cut-off record with it, and a per-asset answer without records read as the canvas having deleted the asset. Either now leaves that asset unread: the rest is delivered, the room keeps its own copy, and the outcome is not recovered. The per-asset answer no longer carries the page's shapes. (3) A record needing one the room refused was filed with the records left to a peer's change and named nowhere. It is now held back and named in `missing`, as is a record needing an unread asset, and one held back for either. (4) The answer carries `kept`, the records recovery left as the room holds them, which the panel line only counted, and every answer from a sent blob carries `sentAt`, the time `exec-failures.md` compares author stamps with, which the agent had never been asked to note. A test-only fault, `WHITEBOARD_TEST_RECOVERY_THROW`, pins the answer to a recovery that throws. `sync-corruption.test.ts` Boards N, E and T and new checks on Boards M and K, and new checks in `render-cap.test.ts` Phase L, fail 19 checks before this, 4 of them on the error's new wording. **[Amended in review]** Five corrections. (1) A page that stopped answering part-way through a recovery on the timeout path made the harvest wait out each asset it had not read in turn, then the recovery's reload its full time, then the plain reload its own: with three assets the answer took 120 s, and its line asked for a restart of a canvas the server had already relaunched. A recovery now runs within one deadline, `RECOVERY_DEADLINE_MS` (30 s, the time a reload may take, counted from the timeout on that path), so that answer takes no longer than the plain reload made it before the previous correction. A canvas that leaves one asset unanswered is not asked for the rest, a read whose bridge socket closed fails at once, and a page whose reload fails or does not finish in time is handed to the launcher; the line then says the server is relaunching the canvas, and where it only reloaded, it counts the reloads it began. (2) An asset the canvas removed between the harvest's list and its own fetch read as one the canvas had deleted, so an image could go back pointing at nothing under "Recovered". The room's copy is now taken when the room holds one; otherwise the asset is held back with what needs it, and named in `missing`. (3) A recovered answer could come a few milliseconds before the reloaded canvas showed the put-back, so a `/shapes` read made on it missed it; the success test now includes the canvas having caught up. (4) The answer's `why` gives each unread asset in `missing` its cause, so an agent can tell whether sending it again would fail the same way. (5) `WHITEBOARD_TEST_RECOVERY_THROW` is armed only by `1`, and the boot warns when a `WHITEBOARD_TEST_*` hook or `WHITEBOARD_FAIL_NAV` is armed. `sync-corruption.test.ts` Boards S, V, C and E0, Board N's new `toolarge` mode and new checks on Boards N, D, E and T, and `render-cap.test.ts` Phase M and a new Phase L check, fail 22 checks before this. **[Amended in review]** Four corrections. (1) The relaunch line named a cause the code had not established: a recovery whose time ran out on a page that answered slowly said the canvas had stopped answering, and a crash during the recovery's reload read as a canvas still corrupted, with a call to restart the whiteboard while the server relaunched it. The line now names what happened (a reload that did not finish in the time left, no time left for one, a reload that failed, or a canvas that went down), and a canvas already in the launcher's hands gets the relaunch line. (2) Where no reload could begin and the server owns no page, the line said "tried 0 times"; it now says the recovery's time ran out. (3) The line for a canvas that had not shown the put-back asked for a redraw on a read that can lag the room; it now asks for a second read first. (4) The bridge marks a socket closed on an oversized message by `ws`'s error alone; on such a message the close event carries 1006, not the 1009 the code also looked for. `render-cap.test.ts` Phases N and O and a Phase M check, and `sync-corruption.test.ts` Board Q0 and a Board C check, fail 7 checks before this. **[Amended in review]** Five corrections. (1) A renderer that crashed while the harvest waited on its last read left the recovery reloading a dead page. Chromium's late reply to that reload failed an assertion in Playwright's message dispatch, which reached the server's `uncaughtException` handler and shut the board down a millisecond after its answer said the canvas was being relaunched. An uncaught fault whose whole stack is Playwright's dispatch of Chromium's messages is now the canvas's, and the launcher has the canvas; any other still shuts the server down. (2) After a crash part-way through the harvest, the relaunched canvas was asked for the assets left to read, had never held them, and they came back `gone`, which the reference reads as a deletion. The harvest now reads only the canvas it began on, and an asset it could not read from it has `no answer`. (3) After a crash that followed the recovery's reload, with a relaunch slower than the recovery, the answer said recovered while `/shapes` answered `503`. Recovered now also waits for the launcher to finish, and a line given while a launcher run that began during the recovery is still running says the server is relaunching the canvas. (4) A reload given under 50 ms read "0.0 s"; a time under a second is now in milliseconds. (5) The cause "already being relaunched … when the recovery began" was also given for a launcher run that began during the recovery, and called the boot launch a relaunch. `render-cap.test.ts` Phases P, Q, R and S fail 7 checks before this, and Phase O's cause and its single relaunch are pinned. **[Amended in review]** Three corrections. (1) A driver fault names no browser, and one the launcher has replaced can still be dispatching Chromium's messages, yet such a fault with no launcher running relaunched the current canvas, closing one that answered and ending the blob running on it. A fault now hands the canvas to the launcher only when the launcher is not running and the current canvas does not answer. (2) The line saying the put-back fell short, given while a launcher run that began during the recovery was still running, opened "the canvas was reloaded", though the canvas may have gone down before the reload; it now opens "in the recovery after <reason>". (3) The reference said an answer without `missing` has nothing missing, which a line saying the last write may be missing contradicted; it now says `missing` covers only what recovery read from the canvas. The launcher's log names that cause `driver faulted`. `render-cap.test.ts` Phase T and a Phase Q check fail 5 checks before this. **[Amended in review]** Two corrections. (1) A driver fault that came while the current canvas was navigating, as a page reloading itself does, met the check that it answers on the document the navigation dropped, and Playwright's rejection of that evaluate read the canvas dead, so a canvas that answered was relaunched. The check now asks the new document again within the same 15 s, and every other rejection still reads the canvas dead when it comes. (2) The reference named one way a write falls outside every list; it now also names a write on a canvas that went down while a relaunch was already under way as the recovery began, which recovery may not have read. `render-cap.test.ts` Phase U fails 2 checks before this, and Phase Q now also pins the line's opening `the canvas was reloaded after <reason>, but` and Phase T a fault on a canvas that does not answer, which is relaunched once. **[Amended in review]** Two corrections. (1) A page that crashed, closed or lost its browser while the check waited on the document a navigation brought in got no rejection from Playwright, so the check read it dead only at its 15 s deadline. In the launcher's verify of a fresh canvas, where the crash hook defers to the running launcher, that held the attempt about 10 s. The check now watches the page and its browser, and a page that crashes or closes, or whose browser disconnects, reads dead when that happens. (2) The check asked again, and logged, each time the page navigated: a page reloading itself at the start of every document was asked again about 1,400 times in 7 s, with a line each time. It now pauses 250 ms before each ask again, so it asks again at most 60 times in its 15 s, and writes one line when it ends, with how often it asked again and how the check ended. `render-cap.test.ts` Phases V and W fail 4 checks before this, and Phase U, whose match moved to that line, 1. **[Amended in review]** Two corrections to that line. (1) It counted the asks a navigation dropped as the page's navigations: a check in which the page started about 1,600 documents was logged as navigating 22 times. It now says the page navigated, how often it was asked again, and how the check ended. (2) Playwright closes a dead browser's pages before it reports the browser gone, so a browser killed during the check was logged `it closed`. A close now names its cause one `setImmediate` later, from whether the browser is still connected: `its browser disconnected` when the browser was killed, since Playwright then reports its page closes and its own close together; a browser that quits still read `it closed`. Phase W now holds the check to one ask again per 250 ms of the time it ran, which a 120 ms pause fails. `render-cap.test.ts`, now 250 checks, fails 2 before this: Phase U's match, and Phase V's browser leg. **[Amended in review]** A browser that quits, on a signal (SIGTERM, which `kill <pid>` sends, SIGINT or SIGHUP) or on `close()`, closes its pages milliseconds before it disconnects, so in the launcher's verify of a fresh canvas the line read `it closed` and the attempt's record lost its cause. A close is now named when the browser disconnects or 50 ms pass, whichever comes first: a browser that disconnects within those 50 ms reads `its browser disconnected`, as every browser killed or quit in the review did, within 12 ms of its page close and under load too; a page that closes with its browser up, or a browser slower than 50 ms to disconnect, reads `it closed`. Phase V gains a leg that sends the browser SIGTERM. `render-cap.test.ts`, now 255 checks, fails 1 before this: that leg's line. §5, §8.6, §10, §11 |
| 68 | **[v9.11] A duplicated or pasted shape belongs to whoever made the copy** | **DECIDED and BUILT** (operator decision 2026-10-20, settling the open question of who owns a duplicated shape, raised in review; test-first: `sync-corruption.test.ts` Board A runs the real render-canvas with a headless operator peer and a real operator tab. It proves that a blob's `duplicateShapes`, and its paste through tldraw's own paste handler, are stamped with the blob's agent whoever drew the original; that the operator tab's keyboard duplicate and copy-and-paste stamp every copy as the operator's, agents' shapes included; that the originals keep their stamps; and that a shape restored by undo, by redo or by `moveShapesToPage` keeps its own stamps, including one the canvas held when it loaded. Against the code before this decision, 10 of its 30 checks fail). **The proven problem:** tldraw's duplicate and paste copy a shape's record whole, `meta` included, under a fresh id. The create handler stamped `createdBy` only when a record arrived without one, so a copy kept the original's author: a copy the operator made of an agent's box read as the agent's, and a copy an agent made of the operator's shape read as the operator's. Agents read `createdBy` to tell their own shapes from everyone else's ("select what you drew", and a redelivered Send's work so far, `references/interrupted-work.md`), so both readings were wrong. Every local create also rewrote `lastEditedBy`, so an undo that brought back a deleted shape named the undoer. **The decision:** each client keeps the set of shape ids it has held: the ids in its store at mount, plus every id an after-create handler records being created since, from any source. A local create of an id outside the set is a new shape, and `createdBy` and `lastEditedBy` are stamped with the acting author, replacing what the record carried. A local create of an id inside the set is a restore (undo, redo, `moveShapesToPage`), which keeps its stamps and fills in only a missing one. Remote changes are never stamped, recovery's put-back included (#67). A `meta.createdBy` a blob passes when it creates a new shape is replaced; no instruction relied on keeping it, since SPEC §5 and `references/tldraw-editor-api.md` already say a blob never sets `meta`. A cut and paste gives the pasted shape to the paster, because a paste takes fresh ids. **Rejected:** keeping the original's author on a copy and recording that as intended (the question's other option); telling a copy from a restore by comparing its `meta` with the original's (a duplicate and a restore carry the same `meta`; only whether the client has held the id tells them apart). **Amends #30.** §5, §8.6 |
| 69 | **[v9.11] The whiteboard is a self-contained skill** | **DECIDED** (operator decision 2026-10-20; documentation only). **The problem:** the source repository's toolchain convention keeps a runtime's compiler, test runner and their configuration in one shared tools folder, with each skill's source beneath it, and the whiteboard's `server/` (a Node bridge run through `tsx`) and `app/` (a tldraw React app built with `tsc` and `vite`) are TypeScript builds with their own installs. The skill is meant to be ported, whole, to a separate skills repository, and a skill that builds on a shared tools folder cannot leave without taking that folder with it. **The decision:** the whiteboard keeps its source and its own dependency installs (`server/package.json`, `app/package.json`) in its own folder, and its boot command (SKILL §1 step 3, #64) is unchanged. It depends on no other skill. What a port must change is everything it reaches outside its folder: the board home at the git root, the operator's identity and the legibility critic's posture. This port's answers are §9's Port decisions (the boards folder from `WHITEBOARD_HOME`, the operator from `git config user.name`, the critic's brief written out rather than linked), and its suites and this spec live outside the skill's folder so installers never copy them. **[Amended in review]** This row first called the board home a dependency on a `scratchpad` skill. It is not: the server writes the boards folder itself. **Rejected:** moving the source into the shared tools folder (it couples the skill to one repository); a whiteboard-only exception (the reason is portability, which applies to any skill meant to be ported). §9 |
