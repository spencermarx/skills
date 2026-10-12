# Whiteboard spec (v9.9, built on v9.8: **[v9.9]** whole-board export OOM/hang fix from the 2026-09-28 investigation — the uncapped whole-board PNG export rasterized every shape at the bitmap default `pixelRatio` 2 with no size or time cap, so on a ~244-shape board in a degraded headless Chromium (software swiftshader, post-suspend) it hung/OOM'd the renderer, leaving `GET /image` and every `/canvas-status` `lastExport*` field `null` while `browserUp` still read true, and v9.9 **size-bounds** the export to a downscaled bird's-eye (content/requested bounds scaled so the raster's longest side ≤ `EXPORT_MAX_PX` 2200, `pixelRatio` pinned to 1, every shape still visible) with an optional `GET /image?bounds=` full-detail region-zoom crop, **time-bounds** it on both sides (a 12s client `toImage` timeout below the 15s `WS_REQUEST_TIMEOUT_MS`, and `requestImage` recording `lastExportError` on a no-frame timeout), and makes the render-canvas **silently self-heal** on a Chromium disconnect/crash (nulling the handles so `browserUp` stops lying, then relaunching the room) — delivering the render-canvas self-recovery #61 deferred (decision #62). Built on v9.7: **[v9.8]** render-canvas stale-frame fix from the 2026-09-25 investigation — when the headless render-canvas's image export **fails** (a live-but-degraded Chromium, suspected WebGL/canvas context loss after a laptop suspend), the app uploads nothing and answers `export-image` with `{ok:false}`, but the bridge ignored the `ok` flag and resolved `GET /image` with the **stale last-good PNG path**, returning HTTP 200 + a frozen frame that an agent "verifying visually" read as current (decision #61). The fix is bridge-side: the image frame is ok/err **signalling only** (the fresh path comes solely from `POST /image-upload`, which the app awaits before signalling), a failed export **rejects** the waiter so `/image` returns **503, never a stale 200**, the `resolveImage` idx=0 fallback that could hand a waiter another request's path is removed, and `/canvas-status` gains export-health fields (`lastExportOk`/`lastExportError`/`lastExportAt`/`lastImageMtime`/`lastImageBytes`) so the stall is observable. Independent of #60 (that was a half-open socket on the message path; this is a live socket failing on the image path — same suspend trigger, separate mechanisms). Built on v9.6: **[v9.7]** lost-wakeup receipt-ack fix from the 2026-09-25 incident — the lead's delivered-marker was set on the server's **write** to a parked waiter, not on the consumer's **receipt** of the bytes; a Send handed to a **half-open socket** (the operator's laptop slept mid-poll, so no FIN reached the server and `req.on('close')` never fired) was stamped `deliveredAt`/`deliveredBy`+leased but never reached the lead, and because the lead lease is reclaimed only when the **session** is confirmed dead — the session re-armed and stayed alive — the Send was stranded `working` forever and skipped on every later poll, so the operator had to send a **second** message to get a response (decision #60). The fix adds a **consumer receipt ack**: `poll.sh` POSTs `/instruction-received {id}` on a 200 **before it exits**, so a receipt that was **delivered but never receipt-acked**, whose holder **re-arms a fresh listener**, is *provably* lost (the poller re-arms only after its prior socket closed) and is **reclaimed and re-served** to that poll; a genuinely received Send (ack present) is spared, so no busy-loop. This inserts **receipt (consumer-confirmed)** between **delivery (write)** and **completion (handled)** in the lead's clockless model — still liveness-driven (the re-arm is a liveness event, not a timer), still at-least-once (never a strand — a *transient* missed ack costs a bounded redelivery, one and idempotent, terminated by completion), and lead-only (workers keep the `STALL_MS` lease). Because the ack is **load-bearing** (it, not just a nice-to-have, is what stops a re-arm re-serving an already-consumed Send — a *persistent* miss would redeliver every Send), `poll.sh` does not rest it on a single tool: it prefers a `node` JSON parse and falls back to a POSIX grep/sed extraction when `node` is unreachable, and WARNs loudly rather than degrade silently. Built on v9.5: **[v9.6]** teardown-guard hardening from the board-teardown incident — a discretionary `POST /done` on a **shared, live** board disconnected a collaborator whose unsynced edits were lost, because the client keeps **no local persistence**. Four fixes: teardown **always** requires an explicit operator close and is never inferred from a file/migration/"switch" request (decision #59); the lockfile records the **owning session** (`ownerSession`/`ownerSessionId`) so a guest session can tell it did not boot the board and must not tear it down (#57); a live board's file is homed by **copy-then-switch** while the server stays up, never `git mv`+reboot (#59, §8.1); and the **root fix** — a client **disconnection banner** plus a `/done` **"server closing — export now"** broadcast make a disconnect loss **surfaced, never silent**: the client always warns before edits can be lost, regardless of why a disconnect happens (#58). Built on v9.4: every delivered Send leads with a fixed `reArmFirst` reminder that restates relaunch-first in-band, polling ~99% with Channels the zero-gap ceiling; **[v9.5]** a malformed `/exec` can no longer silently sever sync: a validate-first store-guard rejects a schema-invalid record before the crashing `store.put`, `ok:true` now means confirmed-present-in-the-room, and a server-owned harvest→reload→reapply auto-recovers a corrupted store and announces it)

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

**[v7]** folds in a design review (Martin Fowler) of the v6 hub-and-spoke as five
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
**fixed by prevention** — the guard makes two-on-one unreachable in solo-POC use.
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
terminal, never both, and the moment it left the poll to converse, `agentParked`
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
model must emit), so v9.4 puts the reminder **in-band**: `instructionPayload` stamps a fixed `reArmFirst`
directive as the **first field of every delivered Send** (index.ts, the `Instruction` type), so "re-arm
before acting" is the first thing read on every drained-Send wake. It is a **nudge, not a new guarantee**
— it lowers the odds of a missed re-arm but adds no new lossless floor; the durable queue (guarantee 3)
remains the only thing that makes a miss cost latency rather than a lost Send. The directive is
**content-free** (no Send text flows in) and **recipient-classed**, exactly like the revive nudge (#45):
byte-identical for the lead (relaunch `poll.sh`) and byte-identical for a worker (re-arm its own
long-poll), so no paraphrase of the message can ride it. It rides only the drained-Send payload, and the
other two wakes are deliberately out of its scope for different reasons: a **teardown** directive carries
no `reArmFirst` and needs none (it skips the re-arm, §2), while a **revive** directive carries none *yet
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
(3) **server-owned recovery**, an automatic harvest→reload→reapply of the render-canvas that clears
the sticky flag by rebuilding the store, then **announces** what it did (an `/agent-message` and a
panel line naming the recovered shape count), bounded by a **loop-guard** (max 2 attempts per
incident plus a short cooldown, then it stops and surfaces loudly rather than reload-looping).
Because the guard rejects the poison at `put`, a harvest reads only valid records, so reapply does
not re-poison in the normal case; the loop-guard covers the pathological edge. The launch/navigate
`verifyCanvasSynced` (a different, known boot race) is unchanged. The **sync-integrity invariant**:
an `/exec` that returns `ok` has reached the room; a corrupted store is auto-recovered and
announced, never silently dropped. Local to this skill; nothing is upstreamed to tldraw. Changes new in v9.5 are marked
**[v9.5]**.

The motivating failure (v5): a real operator Send was **silently stranded** — the
operator↔agent wake was pull-only (HTTP long-poll), the instruction queue was
in-memory, and when the sole consumer stopped re-arming the long-poll, nothing drained
the queue and nothing told anyone. v5 is the fix.

## 1. What this must prove

The proof-target is **the architecture**. By the end we can watch, live, on one branch:

1. The operator draws on a real tldraw canvas in their browser.
2. The operator **selects** the shapes they mean, types/dictates an instruction, and Sends.
3. Send is delivered instantly to the lead's **continuously-parked background waiter**,
   whose exit **wakes the foreground session** (a harness re-invoke) — an event, not a
   timer poll, and **[v9]** not a bridge push (the waiter is client-side, §8.5).
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
    lead is on the board. When **no lead is parked**, the panel says so plainly and
    `/canvas-status` exposes an `agentParked` flag — the failure is loud, never silent.
    **[v9]** With the always-listening background waiter (§8.5), `agentParked:false` now
    means the lead **session has ended**, not merely that it is mid-conversation — a live
    lead keeps a waiter parked even while it talks with the operator.
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
    worker's per-recipient pending projection. The lead's **supervisor long-poll** returns a
    "revive worker-N" directive, the lead resumes the worker by ID (fallback fresh-spawn) with a
    **revival nudge**, and the worker **drains its own queue in order**. Nothing addressed to a
    worker is lost.
16. **[v9] The lead listens while it talks, and never hangs up on its own.** The operator can
    Send **while actively chatting with the lead in the CC terminal** and it lands instantly (a
    background waiter stays parked, §8.5); the lead never stops listening or tears down at its
    own discretion (it **asks** before disconnecting, #49); and a **forced** session end
    (autocompaction / context) leaves the board **process** up with resume coordinates, so the
    Send waits durably and drains on re-attach — the operator is never hung up on (#50).
17. **[v9.5] A malformed `/exec` can never silently sever sync.** A poison exec (the classic being
    a geo shape with a top-level `w`/`h`) is rejected by the **validate-first store-guard** before it
    can trip tldraw's sticky corruption flag, returning `ok:false` with the reason. If a store does
    corrupt anyway, the **honest contract** catches it: `ok:true` means the write is **confirmed
    present in the room** (a per-exec server-side bounded wait on the room clock/shape-set plus the
    corruption boolean), so a severed write returns `ok:false`, and **server-owned recovery**
    (harvest→reload→reapply, loop-guarded, then announced) restores the board and names the recovered
    shape count. The sync-integrity invariant holds: an `/exec` that returns `ok` has reached the
    room; a corrupted store is auto-recovered and announced, never silently dropped (#56).

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
> **[v5] Durable-delivery check:** the operator Sends while **no lead is parked** (the lead
> has ended). The panel shows the Send **queued** with a plain "no agent is listening" state
> and `/canvas-status` reports `agentParked:false`. On the next `/whiteboard open <board>`, the
> lead **drains the pending Send in order** and acts on it — nothing was lost, nothing was
> silent.
> **[v5] Authorship check:** after the operator and one agent have each drawn, the operator
> types "select everything you drew, not what I drew"; the agent filters shapes by
> `meta.createdBy` and selects exactly its own, naming the count — answered from the data, no
> guessing.
> **[v6] Addressable-worker check:** with workers running, the operator sets the **recipient**
> to **"Claude-2"** and types **"redo the left subsystem"**; only **Claude-2's** cursor acts,
> while **Claude-3** keeps working the right concurrently. The operator then sets the recipient
> to **`everyone`** and Sends, and all workers act. Finally the operator addresses a worker that
> has **ended**; the Send is **held** in that worker's per-recipient pending projection and,
> when the lead's supervisor long-poll gets the revive directive and resumes the worker with a
> **revival nudge**, is **drained in order** and acted on — nothing addressed to it was lost.
> **[v9] Listen-while-interact check:** while the operator and the lead are **mid-conversation
> in the CC terminal** (the lead has asked a question and handed the turn back), the operator
> Sends again; it lands **instantly** — a background waiter is parked the whole time — and the
> lead acts on it without the operator having to re-launch anything. **[v9] No-premature-hangup
> check:** when the lead thinks the work is done it **asks** "can I disconnect?" and keeps
> listening; it never `/done`s on its own. **[v9] Forced-end check:** autocompaction ends the
> lead mid-session; the board **process stays up**, the operator's next Send **waits durably**,
> and the next `/whiteboard open` **attaches** to the still-live board and drains it — no
> teardown, no loss.
> **[v9.1] Poll-loop check (proven by the spike first):** the background Bash poller holds a waiter
> across a 240s `204` **without waking** the session, and **wakes it on a real Send** (`200` job-exit
> → harness re-invoke) even while the session sits idle mid-conversation; a Send arriving while the
> lead is mid-act **is caught by the waiter the poller re-parks at the start of the turn** (**[v9.2]**
> relaunch-first, #48) — nothing lost, nothing requiring the operator to re-launch. **[v9.1] Operator-teardown check:** the operator presses the
> drawer's confirm-gated **close-session** control; the lead's supervisor poll surfaces the **teardown
> directive**, the lead posts a closing note and performs the graceful `POST /done` — the *only*
> agent-side teardown, and never fired without that explicit operator signal. **[v9.1] Recipient-guard
> check:** a `POST /message` with a **malformed** `recipient` (a bare string / bad `kind`) is rejected
> **`400`**, while an **omitted** recipient still defaults to the lead.
> **[v9.5] Sync-integrity check (a malformed exec can never silently sever sync):** the operator (or a
> test) sends a **poison** `/exec` (a geo shape with a top-level `w`), then a well-formed one. The
> poison returns **`ok:false`** with the validation reason and the store is **not** left corrupted; the
> well-formed exec **reaches the room** (its shape appears in the operator's browser and the persisted
> `.tldr` grows) and returns `ok:true` only once **confirmed present in the room**. If a store does
> corrupt, recovery **harvests, reloads, and reapplies** the valid shapes, posts a panel line **naming
> the recovered shape count**, and the board resumes; a re-corruption past the loop-guard cap stops and
> surfaces a loud "manual recovery needed" rather than reload-looping. At no point does a later exec
> return `ok:true` while its shape is missing from the room.

**Real-time bar.** *Agent write → pixels on the operator's screen* is near-instant (sync).
*Operator Send → agent's first shapes* is dominated by the model's own turn, so the honest
bar is **"first shapes within a few seconds,"** not ≤2s. **[v9]** A Send to a **live** lead
lands **immediately** — a waiter is always parked (the background job, §8.5), even while the
foreground is talking with the operator; only the lead's turn to *act* on it is serialized
after the current draw (the natural serialization of a coworker finishing a stroke). The
pre-v9 "after the current draw turn if mid-draw" window shrinks to just that acting interval,
covered by the durable per-recipient queue.

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
the lead is **not** in the per-message path. The lead also long-polls, with `supervise=1` (§4).
One session tree per board.

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
   └─────────────────┘   │                          │  - agentParked flag  │ │
                         │  writes <name>.lock [v4]  │  - /boards discovery │ │
                         └───────────────────────────┴─────────▲──────────┘ │
                                                                │ HTTP        │
                                per-recipient long-poll ────────┤
              ┌──────────────────┬───────────────────┬──────────┘
              ▼                  ▼                   ▼
   ┌────────────────────┐  ┌────────────────┐  ┌────────────────┐
   │ LEAD [v6]          │  │ worker-1 [v6]  │  │ worker-N [v6]  │
   │ drawing agent,     │  │ GET /next-     │  │ GET /next-     │
   │ default recipient  │  │  instruction   │  │  instruction   │
   │ + supervisor:      │  │  ?recipient=   │  │  ?recipient=   │
   │ GET /next-instr    │  │  worker-1      │  │  worker-N      │
   │  ?supervise=1      │  │ (own queue)    │  │ (own queue)    │
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
- **Bridge** multiplexes: **[v6] a per-recipient long-poll** (the lead, plus one per worker,
  each draining its own durable queue), the `/exec` relay, screenshot export, agent voice,
  discovery, per-session presence injection, **[v4]** the message store + `GET /messages`,
  **[v5]** the durable instruction queue (a projection over the message log) and the
  `agentParked` state (**[v6]** now one pending projection per recipient, §4/§8.5), and it
  **launches the render-canvas** on boot and **writes the board's `<name>.lock`**.

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
(no Node process can — §11), so it only *raises* the revive directive that the lead's
supervisor long-poll returns (§4, §8.5). "**Supervisor**" therefore names the **lead's
role**, the one actor that revives, and is **not** a bridge component — the bridge's
health half is the **lifecycle monitor**. (This answers Fowler's "bridge = two jobs"
without a process split, which the CC runtime forbids; §11, decision #42.)

**[v7] Recipient ids are a typed, seam-validated `AgentId`, not a bare string.** The
registry of valid ids is `{ lead, everyone }` ∪ **every `clientKey` ever registered**
(§4). Because a worker's `clientKey` **is** its recipient id and is stable across death
and revival (§4, §9), an id stays valid after the worker dies — that is what lets a Send
wait for a dead worker (§8.5). Every seam that takes a recipient — `recipient` on
`POST /message`, `for` on `GET /next-instruction` and `POST /instruction-complete` —
**validates it against the registry and rejects an unknown id with `400`**. The panel
only offers spawned agents (§4, §7), so a `400` is a bug or a stale panel, never normal
flow — which is exactly the constraint worth catching. (Answers Fowler's "convention vs
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
touches CC messaging is reviving a dead worker: the lead `SendMessage`-resumes the worker by its
session id (fallback: a fresh spawn) with a bare **revival nudge**, and the revived worker then
drains its own durable queue (§4). This does **not** reintroduce the declined UDS coupling
described next. The nudge is sent by the **lead, an agent using a supported tool**, not by the
Node bridge, and it carries no payload (the queue stays the source of truth). The bridge still
never pushes to any session.

**[v9] The lead's own wake is the harness re-invoke of a background job, not a bridge push.**
v9 adds a second, sanctioned CC-runtime touch on the **lead** side: its `/next-instruction`
long-poll runs in a **background job** (`run_in_background` Bash), and the harness's standard
**wake-on-exit** re-invokes the lead's foreground when that job exits on a real Send (§8.5,
decision #48). This is client-side and uses supported harness behavior — the **bridge still
never pushes**, and no UDS/internal socket is touched (the "only *bridge→agent* messaging
dependency" claim above stands). It is fully consistent with the UDS decline (#26) below; it
only removes the latency that decision accepted.

**[v5] Why the bridge does not push to an unparked lead (settled, deliberately declined).** The
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
on the next open**. **[v9]** This closes the latency #26 accepted **without** adding coupling.
See §11.

## 4. Multi-peer, sessions & presence [v3]

- **Lead + workers.** The operator talks to a **lead session** (the `/whiteboard` run); the lead
  is itself a drawing agent and the **default recipient**. For parallel work the lead **spawns
  worker subagents**; each registers with the bridge, drives the **shared** render-canvas, and
  **[v6] long-polls its own per-worker queue**, a co-equal addressable session rather than a
  fan-out burst the lead relays.
- **Per-session identity.** `POST /session/register {name, color?, clientKey?, transcriptPath?}`
  → `{ sessionId }`. The bridge injects a presence record into the room for that session (a named,
  colored cursor), so every human peer sees each agent distinctly. `/exec` and `/agent-message`
  carry the `sessionId`; the bridge attributes the cursor's motion/state to it. **[v5]** The
  `sessionId` (with the registered `name` + `color`) is also the **author identity** stamped onto
  shapes an agent's `/exec` creates (§8.6).
  **[v4] `transcriptPath`** is the caller's Claude Code transcript file (from
  `$CLAUDE_JOB_DIR/state.json.linkScanPath`, or built from `CLAUDE_CODE_SESSION_ID` + the recorded
  launch cwd). Recorded for attribution and the on-demand reconciler (§8); optional, never blocks.
- **[v5] Human author identity.** The operator is a native sync peer and does **not**
  `/session/register`. Their author identity (name + a stable `authorKey`) is resolved by the skill
  from `git config user.name` (falling back to `"Operator"`)
  and passed to their browser in the URL, so their locally-drawn shapes are stamped (§8.6). No bridge
  registration and no injected cursor is added for the human — tldraw already gives them a peer cursor.
- **Routing [v6].** A human Send now carries a **recipient**: the **lead** (the default), a
  **named worker**, or **`everyone`**. The bridge routes the Send into that recipient's
  **per-recipient pending projection** and hands it over at that recipient's own
  `GET /next-instruction`; `everyone` fans one copy into each live recipient's projection. Every
  recipient, lead or worker, drains its **own** queue, so the lead is no longer the single
  long-poll consumer and no longer relays human input to workers. (This is the co-equal
  human-addressable routing that v3 held out of scope in §10; **[v6]** supersedes that note.)

**[v6] Worker lifecycle.** A worker **self-parks** on its own durable per-worker queue (§8.5),
long-polling `GET /next-instruction` for its recipient just as the lead does. A subagent is
**finite**: its lifetime is undocumented and it ends on `maxTurns` or compaction, so a worker can
die with Sends still pending on its queue. Those Sends are not lost. They sit in the worker's
durable projection (each a `Message` with no `completedAt`, keyed to that recipient), and the
**lead revives the worker** to drain them. The dead worker's own queue is the single source of
truth; revival carries no message content.

**[v6] Supervisor.** The lead wears two hats: an **addressable drawing agent** (the default
recipient) and the **supervisor**. Only an agent can spawn or resume a subagent; no external
process, the bridge included, can. So the lead is the **sole lifecycle authority** for workers.
The lead runs a **merged supervisor long-poll**: one `GET /next-instruction?supervise=1` that
returns its **own Send**, a **`revive worker-N` directive** (raised by the **lifecycle
monitor**, §3, when a Send is pending for a worker that is not currently parked), or a
**timeout** (re-arm). On a revive directive the lead **`SendMessage`-resumes the worker by its
session id** (fallback: a fresh spawn) with a **revival nudge**; the revived worker then drains
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
the instruction?* Under v7 it cannot — it varies only with the `AgentId`. (Answers Fowler's
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
    Deterministic shape ids make a write upsert-safe. **[v5]** These two together are what make the
    durable queue's at-least-once redelivery (§8.5) safe: a re-drained instruction redraws onto the
    same shape ids and dedupes rather than doubling.
  - *Messages:* `/message` and `/agent-message` accept an `idempotencyKey`. **[v4] For messages
    the key doubles as the message `id`** (§8): a repeat drops the duplicate (no double-post, no
    double-wake, no double-store), and the panel dedupes its optimistic echo by that same `id`.

## 5. Agent write mechanism — `/exec`

The session writes JS run against the render-canvas's live `editor` (unchanged from v2):

- **Tolerant execution.** Guard missing ids (a shape moved/deleted between read and write) —
  no-op, never throw the whole blob; return `{ok:false,error}` so the caller can retry.
- **Prefer bindings / relative placement** over absolute coordinates captured earlier, so a
  nudged box drags its arrow. (Bound arrows also auto-route on every peer's screen.)
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
  about it.
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
  the store's corruption boolean (the server already holds the room, so no extra browser round-trip).
  If the write is not reflected within the bounded timeout, or the store is corrupt, the exec returns
  **`ok:false`** with a distinct `sync-severed` error, never a false success. This per-exec check
  **is** the detector; the existing launch/navigate `verifyCanvasSynced` (a different, known boot
  race) stays.
- **Recovery: server-owned harvest→reload→reapply, then announce.** On a severed/corrupt result the
  server harvests the render-canvas's valid shapes, reloads the page to rebuild the store (the only
  way to clear the sticky flag), and reapplies the harvested shapes through the same exec relay so
  they push cleanly to the room; a create-or-update blob keyed by shape id keeps reapply idempotent.
  It then **notifies** — an `/agent-message` and a panel line naming the recovered shape count, so the
  failure is visible, never silent. A **loop-guard caps recovery at 2 attempts per incident plus a
  short cooldown**; past the cap it stops and surfaces a loud "manual recovery needed" rather than
  reload-looping. Because the guard rejects the poison at `put`, a harvest carries only valid records
  and reapply does not re-poison in the normal case; the loop-guard covers the pathological edge.

The **sync-integrity invariant**: an `/exec` that returns `ok` has reached the room; a corrupted
store is auto-recovered and announced, never silently dropped. See decision #56 and §11.

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
self-corrects on the next successful export.

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
same room with a **bounded retry** (up to 3 attempts, backoff, re-entry- and teardown-guarded; a
parked `/image` waiter is failed fast rather than left to time out). Recovery is **silent**
(server-log only, no panel line — a missed export beat is not worth a chat line), but an
**exhausted, unrecoverable** self-heal is **surfaced on `/canvas-status`** (`lastExportOk:false` +
`lastExportError`), the one deliberate break from pure silence [operator decision 2026-09-28,
amends #62: silent for a blip, attestable for a permanent death].
`render-stall.test.mjs` proves the invariants against a fake render-canvas on an ephemeral
port (never the live board): a failed export returns 503 (not a stale 200), recovery returns a fresh
200, a mismatched-id frame resolves no parked waiter, two concurrent waiters each resolve to their own
frame, and an empty-board `ok:false` returns 503 without flipping health false. **[v9.9]**
`render-cap.test.mjs` covers the **region forwarding** (a `?bounds=` crop forwarded verbatim on the
export-image frame) and the **no-frame timeout health** (an export that returns no frame records
`lastExportOk:false` with a timeout error), both by toggle against a fake render-canvas on an ephemeral
port; the app-side raster cap and the Playwright disconnect/crash auto-restart run in a **real browser**,
outside that Node/fake harness's reach.

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
the *listening* signal. In v5.1 "is a lead parked?" was one boolean `agentParked` (§8.5) meaning
*any* waiter exists. Under hub-and-spoke that question is now asked **per agent**: is **this**
worker listening? So the bridge exposes a **per-session status** for the lead and every worker,
each carrying that session's **per-recipient parked** signal and its **per-recipient lifecycle
state** (§8.5). The panel renders these as a **per-agent status strip**, one row per agent, each
with a lifecycle badge:

- **queued** — the agent has pending Sends but is not yet leasing one.
- **working** — a Send is leased to this agent and it is live.
- **stalled** — this agent held a lease and went silent past `STALL_MS`; its Send re-queued.
- **absent** — no live session for this agent: never spawned, or dead. This is the state revival
  (§8.5) acts on. **[v9]** For the **lead**, "absent / not-parked" now means the **session has
  ended**: its background waiter (§8.5) keeps it parked continuously while alive, so a lead that
  is merely talking with the operator or mid-draw still reads present/listening, never absent.

A spawned, parked agent with an empty per-recipient queue reads as idle/listening — present, not
absent. The strip is driven by the bridge status signal, distinct from the sync cursors: cursors
show *where* an agent is on the board, the strip shows *whether* each agent is listening and what
it is doing.

## 8. Persistence & discovery

### 8.1 Board persistence (`.tldr`)

- **Format:** `.tldr` (native `RoomSnapshot`), reloadable into a room.
- **[v3] The sync server owns it:** `onDataChange` flags the room dirty; a ~2s interval writes
  `room.getCurrentSnapshot()` to the board's `.tldr`; a synchronous flush runs on shutdown.
  **[v5]** Shape `meta` is inside the snapshot, so authorship persists and reloads with the board.
  **[v9.9]** Only a room that changed since its last write is written, always to a temp file in the
  board's folder renamed over the board, so a crash never leaves a truncated board.
- **Home:** `.scratchpad/whiteboard/` (git-ignored; boards are runtime artifacts). Screenshots
  land here as `<room>.png` **[v9.9]** (§8.3). Path overridable.
- **[v9.6] Homing a live board's file is a copy, not a move (decision #59).** Because the ~2s
  interval keeps the scratchpad `.tldr` **≤~2s-fresh**, a live board's file is homed into tracked
  storage by **`cp`-ing that snapshot to the destination while the server stays up** and committing
  the copy — the process, its port, its lock, and every peer are untouched. **[v9.9]** The copy is a
  board of its own (its own room, §8.3); to keep working on it, the operator picks it in the panel's
  board switcher, which moves the server and their browser together. A `git mv` of the live
  file plus a reboot-onto-new-path is a **teardown in disguise** (it drops every peer's unsynced
  edits) and is reserved for an **explicit operator teardown**. This is the fix for the v9.6 incident,
  where a move-then-reboot was used to free a live file and disconnected a collaborator (SKILL §6, §11).

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
  human-readable sidecar `.scratchpad/whiteboard/<name>.messages.jsonl`, reloaded into memory on
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
  log or a recipient queue. The bridge holds a per-room **teardown-requested** flag and surfaces it to
  the **lead's `supervise=1` poll as a teardown directive** (§9) — the same signal-not-act pattern as a
  revive directive: the bridge raises it, the **lead** performs the graceful `POST /done` (§8.3). It is
  the structural counterpart to a natural-language "you can disconnect" Send, which the lead still
  honors as a fallback.

### 8.5 Durable instruction queue & delivery [v5; lease/visibility-timeout v5.1]

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
- **[v6] Each recipient drains its own pending, oldest-first, over its own long-poll.** `POST
  /next-instruction?for=<recipient>` hands the caller the oldest pending Send **for that recipient**
  and stamps `deliveredAt`/`deliveredBy`. The lead adds **`&supervise=1`** — the **supervisor
  long-poll**, which also surfaces revival directives (below). The recipient does its read-act turn,
  then `POST /instruction-complete {id}` (for a broadcast, scoped to the calling recipient) stamps
  completion. If a recipient **ends mid-draw** (a crash, or autocompaction firing during a turn),
  its Send is never completed, so it re-drains — the exact class of loss this exists to kill. Redraw
  is safe because `/exec` is idempotency-keyed and shape ids are deterministic (§4): a re-run
  upserts, never doubles.
- **[v9.3] The lead's receipt is a clockless delivered-marker, not a timed lease.** On delivery the server sets an automatic, session-scoped **delivered-marker** on the lead's Send ("held by session S, not yet handled"). It stops session S re-grabbing the same un-handled Send, and it carries **no clock**. This separates **receipt** from **completion**: the marker is receipt/working, and `POST /instruction-complete` is the sole durable retire, posted **only when the lead has actually handled** the message (responded, or acted on the board), never merely to clear its plate. Complete means handled, not received. The marker replaces the v9.2 `inFlightByRecipient` timed lease **for the lead**.
- **[v9.3] The lead's redelivery is liveness-driven, never clock-driven.** A received-but-un-handled lead Send returns to `queued` (for the next lead) **only when its holder is confirmed not-listening (dead)**, per the liveness and grace-window rules in §9. No timer runs on the message. An **Idempotent Receiver** dedupes any accidental duplicate by the threaded message id, so at-least-once delivery stays harmless: a rare double-handling on crash-after-work-before-ack is inherent to at-least-once and acceptable for a whiteboard (a rare double-draw, which `/exec` idempotency and deterministic shape ids already absorb, §4).
- **[v9.7 #60] Receipt is consumer-confirmed, and a re-arm without it is a lost delivery.** The v9.3 delivered-marker above is stamped by the server's **write** to the waiter (`markDelivered`), which is *not* proof the consumer received the bytes: a **half-open socket** (a suspended client, no FIN, so `req.on('close')` never fires) takes the write into the kernel buffer and drops it, yet the marker + lease are already committed. So the lead now sends a **consumer receipt ack**: on a `200`, **before it exits** (the exit is the wake), `poll.sh` POSTs `POST /instruction-received {id}` (§8.5, the poller contract), which stamps a **`receivedAt`** on the marker — a third state **between `deliveredAt` (written) and `completedAt` (handled)**. This adds one clause to the liveness-driven redelivery above: a held lead receipt that is **delivered but never `receivedAt`-acked**, whose holder **re-arms a fresh listener** (a new `GET /next-instruction` on the same session), is **provably lost** — the single-poller re-arms only after its prior socket closed, so that delivering socket is gone and never confirmed receipt — and is **reclaimed to `queued` and re-served to that very poll** (`reclaimLostLeadDeliveries`, run at the arm before the drain). This is still **liveness-driven, not clock-driven**: the trigger is the re-arm event, not a timer. A receipt that *was* acked (the normal turn: the lead received the Send, acked it, then re-armed) is **never reclaimed**, so a re-arm does not re-serve a Send the lead already consumed (no busy-loop). The ack is **lead-only and load-bearing**, not merely best-effort: it is the sole guard that stops a re-arm re-serving an already-consumed Send, so a *persistent* failure to ack would redeliver **every** Send (bounded to one per Send, since completion drops the lease and closes the reclaim), not a rare one. `poll.sh` therefore does not rest the ack on one tool — it prefers a `node` JSON parse (correct for any id) and falls back to a POSIX grep/sed extraction when `node` is unreachable (the poller's PATH need not match the bridge's), and WARNs loudly if neither can build the ack rather than degrade silently. A *transient* miss (or an older poller that never acks) is still safe: the receipt reads un-acked and the next re-arm redelivers — a **bounded double** the Idempotent Receiver absorbs, never a strand, which is the safe direction. A (re)delivery clears any prior `receivedAt` (`markDelivered`), so a Send re-queued from an earlier lead must be re-acked by whoever next receives it. Workers are unaffected: they keep the `STALL_MS` visibility timeout, which already reclaims a lost worker delivery once the worker goes silent.
- **[v9.3] Workers keep the per-recipient `STALL_MS` visibility timeout and its `stalled` state, on purpose.** Workers are closer to genuine competing consumers (many, revivable, no takeover event), so a delivered worker Send stays a **lease** held by `deliveredBy` and renewed by every bridge call carrying that worker's `sessionId`. A periodic sweep reclaims any worker lease whose holder has been silent past `STALL_MS` (120s default, so a normal draw turn never trips it): the Send returns to pending for that worker, redelivered if it is parked or surfaced as *stalled* if it is not, which is exactly what the lead's supervisor poll reads back as a revive directive. Lead and worker diverge deliberately. **Caution (Fowler):** before the lead's timer is deleted, prove the worker/revive path does not depend on the shared sweep in a way a lead-only carve-out breaks.
- **[v9.3] Lifecycle states are computed per recipient, and the lead drops `stalled`.** For a **worker**, states are unchanged: **queued** (awaiting it) → **working** (leased to that live worker) → **done** (completed); or **stalled** (its lease expired, re-queued for that worker). For the **lead** there is **no `stalled`**: the lead's lifecycle is **queued → working (received, being handled) → handled (done)**. The panel renders `state` directly (it never re-derives from timestamps), keyed by recipient, and `GET /messages` carries it so the per-agent status strip (§7) seeds correctly on load. For the lead the "being handled / delivered" signal shows while it is alive, and "no one on the board, reopen `/whiteboard open <board>` to resume" is reserved for a **confirmed-dead** lead (grace elapsed, §9); transient `agentParked === false` is no longer read as "session ended." A "waiting for this recipient" badge (a worker queued or stalled while not parked, or a lead queued while confirmed dead) never fires on *working*, so a Send an agent is actively drawing never falsely reads as stranded.
- **[v6] Revival is done by the lead, never the bridge.** The bridge cannot spawn or wake a
  subagent; only an agent can. So when a **worker has a pending Send but is not parked** (no live
  long-poll for it), the bridge surfaces this to the lead's **supervisor long-poll** as a
  **"revive worker-N"** directive. **[v7]** That directive **carries the exact `nudge` text** the
  lead must send — a fixed bootstrap template keyed only on the recipient `AgentId` (§4), so the
  lead relays a **verbatim** string and has no instruction to paraphrase. The lead revives that
  worker — **SendMessage-resume by its id**, falling back to a **fresh spawn** if the session is
  gone — with that **revival nudge** (no instruction content; just wake and self-park). The
  revived worker then opens its own
  `/next-instruction?for=<worker>` and **drains its own pending**. The bridge still never
  resurrects a session; it only signals, and an agent (the lead) acts. This is consistent with the
  **No push to an unparked lead** decision (hold + signal, never auto-resurrect): what changes is
  that the signal now travels to the lead, who has the one capability the bridge lacks.
- **[v6] Broadcast (`everyone`) is one Message projected to N recipients.** Chosen over N
  recipient-stamped copies because it best preserves single-source-of-truth: there is exactly
  **one `Message` in the log** for the operator's one Send, and the per-recipient pending
  projection makes it appear in **every** worker's view. Per-recipient delivery, lease, and
  completion are tracked in a small **per-recipient delivery map** on that one Message (rewritten
  in place, as v5 already rewrites delivery state, §8.2). Each recipient **leases and completes its
  own entry independently** via `/next-instruction?for=<worker>` and `/instruction-complete {id}`.
  The broadcast reads **done only when every current recipient has completed** its entry; until
  then it is *working* (some in flight) or *queued* (some still waiting), and a worker that must be
  revived to reach its copy is surfaced the same way as any other unparked recipient.
- **[v6] Drain in order on open, per recipient.** On boot/attach, and on every
  `/next-instruction?for=<recipient>`, the bridge serves that recipient's pending Sends
  **oldest-first by `ts`**, so a backlog accumulated while that recipient was off the board is
  worked through in the order the operator sent it.
- **Live delivery unchanged for a parked recipient.** When a recipient is long-polling, a fresh
  Send addressed to it is handed over immediately (the waiter path), then follows the same
  complete-ack lifecycle.
- **[v9] Always-listening: the parked waiter is client-persistent.** The server's delivery is
  pull-only and stays that way — a Send reaches a recipient only inside that recipient's own `GET
  /next-instruction` long-poll, either drained on entry (`nextPendingFor` → `markDelivered` →
  `res.json`, index.ts:1245–1249) or handed to an already-parked waiter (`serviceWaiters`,
  :1098–1099, reached from `deliverInstruction` at :1128 and from `POST /message` at :1427–1433).
  Nothing pushes. What v9 changes is entirely **client-side**: the skill runs that long-poll in a
  **background Claude Code job** (`run_in_background` Bash) that keeps a waiter **parked
  continuously**, so the server's existing instant parked-waiter delivery now applies without gaps.
  - **Background park, not a foreground blocking poll.** Before v9 the recipient held
    `/next-instruction` open on its **foreground turn**, so it could not both listen and talk to
    the operator, and leaving the poll to converse dropped its waiter — flipping `agentParked`
    (:927) false and leaving a later Send to sit pending at unbounded latency. Under v9 the poll
    lives in the background job; the foreground turn ends normally, so operator and session keep
    conversing in the terminal while a waiter stays parked the whole time.
  - **Silent re-arm on `204`.** The background job treats every `LONGPOLL_MS` timeout (240s, :42)
    `204` as a **re-arm, not an exit** (the §9 re-arm discipline, now enforced by the job rather
    than left to the loop): it immediately re-opens `/next-instruction?…` so the waiter is
    re-registered (:1266–1279) with no visible turn. The waiter never lapses; `agentParked` stays
    true continuously.
  - **Exit only on a real Send → harness wake.** The job **exits only when a real Send is
    delivered** (a `200` from the drain or waiter path, :1249/:1099, never a `204`). That exit
    triggers the harness's standard **session wake / re-invoke**. The woken session runs the
    read-act turn (or, for the lead, spawns/revives per the supervisor directive), **relaunches the
    background poll**, and hands the foreground turn back.
  - **[v9.3] Immediate relaunch, for liveness and latency, not a lease clock.** The poller is relaunched as the **first action on wake**, before the read-act turn, concurrent with the ensuing foreground draw. Under v9.3 this is load-bearing for **liveness** (an armed listener is the lead's liveness signal itself, §9) and for **latency** (a waiter is parked before the draw begins, so a Send arriving mid-act is delivered at once), not for renewing a lease. The lead's receipt is the clockless delivered-marker above, so `nextPendingFor` hands the relaunched poll the next un-handled Send and never the lead's own in-flight one, with the idempotent receiver covering any overlap. A slow re-arm now costs latency, not correctness (the grace window plus idempotency cover the gap). (The v9.1/v9.2 per-message timed-lease framing is superseded for the lead; workers keep their lease, above.)
  - **[v9.4] In-band re-arm reminder — the drained-Send-wake arm of guarantee (1).** Because a Send delivery IS the poller's exit, the woken session's listener is already down when it reads the body; the relaunch (guarantee 1) is the one re-arm guarantee that rides **agent memory**. So `instructionPayload` stamps a fixed `reArmFirst` directive as the **first field of every delivered Send**, restating "relaunch before acting" in-band at the top of the wake body. It is content-free and recipient-classed like the revive nudge (#45) — the lead is told to relaunch `poll.sh`, a worker to re-arm its own long-poll — so no message text can ride it. It rides only the drained-Send payload: a **teardown** wake needs no re-arm (it skips §2 step (a′)), and a **revive** wake — which also exits the poller and *does* still need the relaunch — carries no `reArmFirst` by design and relies on the SKILL prose alone, so it, not the wake this nudge covers, is the likelier remaining miss. This is a **nudge that lowers the odds of a missed re-arm, not a fourth guarantee**: the durable-queue floor stays the only thing that makes a miss lossless.
  - **[v9.3] No lead sweep: liveness decides, not silence.** The v9.2 "sweep spares a listening holder" clause is withdrawn for the lead. With no timed lease on the lead's Send there is nothing for `STALL_MS` silence to reclaim, so the false "collaborator stepped away" flash and the reclaim/redeliver busy-loop it guarded against cannot arise. A lead Send re-queues only on a **confirmed-dead** holder (no armed listener and no bridge call carrying the lead sid across the ~2 min grace window, §9), never on silence while the poller is armed. The sweep and `STALL_MS` stay in force **for workers only** (above), where a genuinely ended worker (no waiter, silent past `STALL_MS`) reclaims to *stalled* and, with no waiter, surfaces to the lead's supervisor poll as a revive directive.
  - **[v9.2] Latency property (precise).** Delivery is **instant while the recipient is parked** —
    now nearly the whole time, since the poller is relaunched as the first action on wake and a
    waiter is re-parked before the draw begins — because `POST /message` services the parked waiter
    synchronously in the same request (:1427–1433 → :1099). The **only** remaining gap shrinks from
    the whole turn to the **~ms-to-seconds between one poller exiting** (having consumed a Send) and
    the next turn's **relaunch** re-parking a waiter. A Send arriving in that sliver is not
    stranded: it sits in the per-recipient pending projection above and is drained the instant the
    relaunched poll arms (:1245–1249) — the lead still reads **present** (its `/exec`/GET heartbeats
    keep `lastSeenBySession` fresh), never **absent**. This is the durable queue doing its job, not
    a new failure mode. Polling therefore reaches **~99%, not a literal 100%**: the wake still needs
    the poller to exit and the harness to re-invoke, and this relaunch window is a real gap the
    durable queue **covers rather than eliminates** — **Channels (#52) is the zero-gap ceiling**
    (a listener decoupled from the turn cycle needs no relaunch), documented as the future upgrade,
    not reopened here.
  - **[v9.3] The waiter mechanism is unchanged; the lead's bookkeeping is a real server change.** The pull
    model and the per-recipient projection stand, and a Send still reaches a recipient only inside its own
    long-poll. What v9.3 changes on the server is the lead's *bookkeeping*, not the transport: the timed
    lease and the `STALL_MS` sweep are replaced, for the lead, by the clockless delivered-marker and
    liveness-driven redelivery (§8.5), with death declared on the ~2 min grace window and
    `presence.unregister(deadSid)` on a confirmed-dead lead (§9). The `STALL_MS`/`SWEEP_MS` sweep stays for
    **workers**. (**[v9.1]** the server also carries two small, unrelated deltas: the `parseRecipient`
    hardening (§4, #43) and recognizing the operator **teardown-request** (§8.2, #53); neither touches the
    pull/waiter path.) The
    background-waiter pattern is **lead-scoped** — the lead is the only agent that converses with
    the operator in the CC terminal, so only it needs to listen-while-interact. **Workers keep the
    in-turn blocking self-park** (§9): they do not talk to the operator, subagent background-wake
    semantics are unverified, and worker resilience is already covered by the durable queue + lead
    revival. A background job that dies without re-arming is just a silent recipient, recovered by
    the same sweep and drain-on-open as any ended session — the durable floor is unchanged.
  - **[v9.1] The poller is a skill-owned Bash script, and its re-arm is reliable by construction, not
    by memory.** The loop is a **skill-owned Bash script** invoked by the one `run_in_background` Bash
    call — never fragile inline bash: a `curl --max-time` (~250s, just over `LONGPOLL_MS`) hanging-GET
    on `/next-instruction?…` that on a `204`/timeout **re-opens** and on a `200` **prints the delivered
    Send to stdout and exits** (the wake). Because a missed relaunch is the exact class of the v9 hangup,
    it does **not** rest on agent discipline alone — **three guarantees stack**: (1) **[v9.2]** relaunch
    is the **unmissable first action on wake**, before the read-act turn (it moved from the end of
    the turn to the front, so a waiter is parked through the whole draw); (2) **boot and attach
    verify a live poller** (`/canvas-status` `agentParked`) and start one if absent; (3) the
    **durable-queue floor** makes any missed re-arm **loss-free** — the Send waits, loud, and drains on
    the next poller return or `/whiteboard open`. A **`Stop` hook cannot own the listener**: a
    hook-spawned process does **not** get CC's `run_in_background` wake-on-exit (only the agent's own
    Bash background job does, verified last session), so the listener must be agent-launched, hardened
    by (1)-(3). The **spike proves this loop end-to-end before the swarm builds on it** (§2, §12). This
    polling design was chosen over **Channels** (an MCP event-push): both ride this same durable queue,
    so polling matches it on reliability/consistency/latency, and Channels' research-preview cost is not
    worth its lone edge (a turn-cycle-decoupled listener) for a solo POC (decision #52).

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
    unambiguous. The blob never touches `meta` (§5).
  - **Human shapes** are stamped on the **operator's own browser**. Its `editor.sideEffects` handler
    stamps `createdBy` / `lastEditedBy` from the human author identity the skill passed in the URL
    (§4). No `/exec` and no bridge round-trip — the operator draws directly.
- **`createdBy` is immutable** (stamped once, never overwritten); `lastEditedBy` is rewritten on
  every content edit by whichever peer made it.
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
  process bound to `127.0.0.1:0`; it reads the **actually-assigned** port off the listening socket.
- **[v9.9] One identity per board file.** A board is its `.tldr` file's canonical (realpath)
  path. Its room id is `<slug of the name>-<hash of the path>` (`server/boards.mjs`), so two files
  that share a name are two rooms; the base name is display only. Every board's lock, chat log,
  render and server log live in the boards folder, `<scratch>/whiteboard/`, named by that room id,
  wherever the `.tldr` itself is; nothing but the board is ever written into a tracked folder.
  `whiteboard.sh locate --board <file>` prints a board's room id, sidecar paths and live lock.
  Board paths a request names must be `.tldr` files inside the repository or the boards folder.
- **Lockfile = discovery + one-server guard.** On boot the process writes
  `<scratch>/whiteboard/<room>.lock` = `{ port, pid, board (the room id), path, name, startedAt,
  ownerSession?, ownerSessionId? }`. Its jobs: (1) the next `/whiteboard` for that board reads it to find the
  running port and **attach**; (2) it stops a **second server process** from hosting the same board;
  **[v9.6]** (3) it records **whose** session booted the board, so a second session can tell it is a
  guest (below). It is **not** a session limit — any number of agent sessions and human browsers
  still share the one process.
- **[v9.6] Owner identity in the lock (decision #57).** `ownerSession` (the human-readable CC
  session name) and `ownerSessionId` (the stable `CLAUDE_CODE_SESSION_ID`) are supplied to the
  process at boot via `WHITEBOARD_OWNER_SESSION` / `WHITEBOARD_OWNER_SESSION_ID` and written into the
  lock (both optional — omitted when unresolvable). `/canvas-status` echoes them. A second
  `/whiteboard` compares the lock's `ownerSessionId` to its **own** session id: a **match** means it
  booted the board (owner); a **mismatch, or an owned board it did not boot,** means it is a
  **guest**. A guest attaches and draws freely but must **never** perform a **destructive** act — no
  `POST /done`, no lock reclaim — on a board another session drives (SKILL §1 step 2, §6, decision
  #59). Every reader parses the lock **by field name**, so the added fields are backward-compatible
  (the sole in-process reader, `readLock`, still gates only on `port`/`pid`).
- **Attach vs boot.** Before booting, the skill reads `<name>.lock`; if the `pid` is alive **and**
  the port answers `GET /canvas-status`, it **attaches**. A stale lock (dead pid or silent port) is
  reclaimed and a fresh instance boots. The lock is removed on graceful `/done`. **[v9]** `/done`
  is **operator-confirmed only** (#50); a **forced** CC-session end (autocompaction / context /
  `maxTurns`) removes **nothing** — the board's Node process, its port, and its `<name>.lock` all
  survive the session that launched them, so the next `/whiteboard open` **attaches** to the
  still-live owner rather than reclaiming a stale lock (§6 of SKILL).
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
- **[v8] Defect fixed by prevention: the per-board message store (`<name>.messages.jsonl`) is
  cached per-process and never re-read**, so two processes on one board would silently diverge (a
  full-file `rewriteMessages` on one clobbers the other's appends). The one-server guard makes
  two-processes-on-one-board unreachable in solo-POC use, so the cache stays correct without a
  re-read mechanism; a re-read would guard a state the guard already prevents.
- **[v9.9] The boot path honors it too.** `whiteboard.sh start` and the server's own boot both
  refuse (exit 4) a board whose lock has a live foreign owner, so a second `start` never steals the
  lock. The server also refuses to boot onto a board outside the repository, or one it cannot load.
- **[v9.9] A board file the server cannot load is refused, never replaced.** Unparseable JSON,
  tldraw.com's own `{tldrawFileFormatVersion, records}` format, or anything `TLSocketRoom` cannot
  construct from is a 4xx on the HTTP routes and a refused `/sync/` upgrade; the room is not cached
  and so never persisted. Only rooms that changed are written, by temp file and rename.
- **Race caveat (accepted for a solo POC):** two *simultaneous* launches of the same board could
  both boot (the guard's liveness check has a TOCTOU window a single operator does not hit); a
  single operator does not race themselves.

### 8.4 Board discovery

- **Discovery sources:** union of **(1)** `.scratchpad/whiteboard/*.tldr` (always) and **(2)** a
  repo-wide `*.tldr` scan (excluding `node_modules`, `.git`). A live board is one whose `.lock`
  points at a reachable port.
- **Gitignore trap (must handle):** grep here is ugrep and obeys `.gitignore`, and `.scratchpad/`
  is git-ignored, so a naive recursive scan **skips every scratchpad board**. Use a direct glob /
  gitignore-bypassed walk for the home.
- **Opening a board** loads that `.tldr` into the process's room; the render-canvas and operator
  browser join it.

## 9. The skill

`/whiteboard [new <name> | open <name-or-path>]`

**Boot (lead session):**
1. Install deps if needed. Resolve the board → `<name>.tldr`.
2. **[v4] Read `<name>.lock`.** If a live instance is found, **attach**: skip to step 6 against
   that port. `new` on an existing board errors here.
3. Otherwise **start the Node process** bound to `127.0.0.1:0`; read the assigned port; write
   `<name>.lock`.
4. The bridge **launches the headless render-canvas** (Playwright Chromium running the app,
   joined to the room, `role=agent`). Wait until it reports connected.
5. **[v5] Resolve the operator's author identity** (from `git config user.name`;
   else `"Operator"`) and **open the operator's browser** on
   `http://127.0.0.1:<port>/?role=human&room=<board>&author=<name>&authorKey=<stable>&session=<name>`.
   **[v9.1]** The `session=<urlencoded>` param carries the **bound CC session's semantic name** — the
   driving session's `name`, resolved at boot from `$CLAUDE_JOB_DIR/state.json` (the same file step 6
   reads `linkScanPath` from for `transcriptPath`), e.g. `"my-repo: whiteboard session 10"`;
   fallback plain `"Whiteboard"` if unresolvable. On load the app sets `document.title` to
   `"Whiteboard: " + truncate(session)` (the app truncates for the tab), so each tab names the session
   bound to it rather than reading a generic `"Whiteboard"` — a tab-identity affordance in the
   drawer's room-identity language (#13, #47), client-only with no new server field (#54).
6. Register the lead session (`POST /session/register` **[v4] with its `transcriptPath`**) → its
   cursor and author identity.
7. **[v5] Drain any pending backlog first,** then enter the loop. On attach/boot there
   may be Sends queued while no lead was on the board (§8.5); work them oldest-first before parking.
   **[v6]** The backlog drained here is the lead's **own** queue (`recipient` = lead). Each worker
   drains its own queue when it opens (below). **[v9]** The lead does not park by **blocking its
   foreground turn**; it launches the `/next-instruction` long-poll as a **background job** that
   parks a waiter continuously and wakes the foreground only on a real Send (§8.5, #48), so the
   foreground stays free to converse with the operator between turns. **[v9.1]** That job runs a
   **skill-owned Bash poller script** (§8.5), and boot/attach **verifies a live poller is parked**
   (`/canvas-status` `agentParked:true`) before handing the turn back — if none is, it launches one.
   The poller-liveness check is one of the three guarantees that keep the listener alive without
   relying on agent memory (#48 amended).

**The read-act turn (shared discipline, lead and worker).** Whichever queue it waited on, a session
runs the same turn: **[v9.2]** relaunch the background poller **first** (the lead's first action on
wake, before it perceives or acts, so a fresh waiter is parked for the whole turn — §8.5, #48; the
one exception is a **teardown directive**, which relaunches nothing and goes to §6) → `GET /shapes`
+ `Read` the screenshot → (ask via `/agent-message` if ambiguous) → `/exec` → verify screenshot +
one correction → select touched shapes + summarize via `/agent-message` → **[v5] `POST
/instruction-complete {id}`** to ack the turn (this is what marks the instruction done; skipping it
leaves it pending and it re-drains). There is **no end-of-turn relaunch** — it moved to the front,
so a Send arriving mid-draw meets an already-parked waiter. **[v6]** Lead and worker differ only in
**which queue they wait on** and, for the lead, in **supervising worker lifecycle**; a worker keeps
the **in-turn blocking self-park** (§8.5), re-arming by re-polling its own queue at the turn's end
rather than through a background job.

**[v6] Worker loop (self-park on its own queue).** A spawned worker first `POST /session/register`
for its cursor + author identity, then **self-parks by long-polling its own queue**:
`GET /next-instruction?for=<its recipient id>` (payload carries the Send's `id` + selection). It
**drains its backlog oldest-first** before parking (a Send may have been held for it while it was
absent, §8.5), then runs the read-act turn, points back, calls `/instruction-complete`, and re-arms.
Same read-act discipline as the lead, on its **own** queue, never the lead's. A `204` is a re-arm,
not an exit.

**[v6] Lead-as-supervisor loop.** The lead's wait is a **supervisor long-poll**:
`GET /next-instruction?supervise=1` over its own (lead) queue. One wait returns **one of four [v9.1]**:
its own Send (`recipient` = lead), a **"revive worker-N" directive** (a Send is waiting for a worker whose
queue has no live poller), a **[v9.1] teardown directive** (the operator pressed the close affordance,
§8.2, #53), or a **timeout** (re-arm). On its own Send it runs the read-act turn. On a
revive directive it issues a **revival nudge**: **SendMessage-resume that worker by id** (fallback:
fresh-spawn a replacement bound to the same recipient id) with a **bare nudge**; the woken worker then
drains its own queue and acts. **[v9.1]** On a **teardown directive** — the operator's *only* deliberate
close signal — the lead finishes any in-flight turn, posts a brief closing `/agent-message`, and performs
the graceful **`POST /done`** (§8.3); this is the operator-confirmed teardown of #50, now carried by a
structural signal rather than natural-language interpretation. The lead **spawns workers when the work
splits** (or when the operator asks). The operator addresses only workers the lead **has already
spawned**; typing a new name into the recipient box does **not** conjure a worker (§4).

**[v5] Re-arm discipline, generalized per recipient [v6].** A `204` is a **re-arm, not an exit**: the
session polls again on its **own** queue. **[v9.2]** For the lead this re-arm is **front-loaded** —
it relaunches the background poller as the **first action on wake, before the read-act turn**, not
as a post-ack final step, so a waiter is parked through the whole draw and a mid-act Send is caught
(§8.5, #48); a **teardown directive** is the one wake that relaunches nothing (§6). Every session is
finite (autocompaction fires ~76–84%, a
non-tool turn ends the job), so none parks forever; **[v9]** when one must end it ends **cleanly**
by exactly one of two exits — an **operator-confirmed `/done`** (§6), or, on a **forced** end
(autocompaction / context / `maxTurns`), **leaving the board process up and reporting resume
coordinates** (§6, decision #50), never tearing down at its own discretion — and the **durable
per-recipient queue + drain-on-open** (§8.5) carry any later Send to the next session on that
queue: the lead revived from its own queue on the next `/whiteboard open`, a worker revived by the
lead. A session must **never** treat a `204` as a reason to stop looping while it is still alive
and cheap. That specific mistake is what stranded a Send and motivated v5.

**[v9] Stay-connected invariant — no premature hangup.** The re-arm discipline above is now a
**hard invariant**, widened past the `204`. Delivery is **pull-only**: the only "listening" state
is the long-poll, so **ceasing to listen and hanging up are the same act** — the moment a session
leaves the poll to talk, think, end a turn, or stop, its `agentParked` flips false and a later
operator Send sits undelivered at unbounded latency (the revive path excludes the lead, so a
silent lead never self-heals). Therefore **a session never disconnects at its own discretion** —
neither by ceasing to listen nor by tearing down (§6, §8.3). Default is **stay-connected**.
Because listening now runs in a **background job** (§8.5, #48), staying connected does **not**
block the foreground: the lead can ask the operator a question **and** keep the line open at the
same time — the two are no longer a choice. When the work **looks** done the session **asks**
("are we done — can I disconnect?") and **keeps listening** until the operator answers **yes**;
operator **silence means keep the line open**, never close it. The motivating v9 incident was the
inverse: a lead ended its turn to ask a question, stopped listening, and the operator's next Send
was never received — a premature hangup (#49). **[v9.3]** "Never stop listening" stays a **hard requirement**, and staying armed is now the lead's **liveness signal itself**, not a lease renewer: the poller is relaunched as the **first action on wake**, before the lead perceives or acts, so a Send arriving mid-draw reaches the already-parked waiter rather than waiting for the turn to end (the teardown directive is the sole exception, it relaunches nothing, §6). **P1 relaunch-first stays load-bearing, now for liveness and latency, not a lease clock.** The **delivery-latency** gap between one poller's exit and the next arm is only sub-second-to-seconds and is covered by the durable queue; the lead never shows `stalled` across it, and this is the gap the ~99% figure is about. The separate, longer **liveness** gap — a whole turn's tool calls, which a live dogfood measured well past a minute — is what the **grace window** bridges (§9 below); do not conflate the two. Polling therefore reaches **~99%, not a literal 100%**, with **Channels (#52) the zero-gap ceiling**.

**[v9.3] Liveness for the lead; lease heartbeat for workers.** For the **lead**, liveness is not a lease clock but a single fact: **an armed listener exists** (a parked long-poll waiter for the lead). A bare heartbeat does **not** count as liveness unless the poller is still listening, since an agent that heartbeats with a dead poller silently drops messages. The unavoidable re-arm gap (the listener must tear down to wake the agent, because the harness wakes only on the background job's exit) is bridged by a **HEALTH-CHECK grace window** (default ~2 min, `LEAD_GRACE_MS`) on the liveness concern, honest and separate, and **never a message state**. A live dogfood corrected the earlier assumption that immediate re-arm (P1) leaves this window "almost never consulted": in a real Claude Code session the wake→re-arm gap is harness re-invocation latency **plus the lead's own tool calls across a turn**, which routinely ran past the original 75s and twice tripped a (correct-by-signal, wrong-in-fact) death-declaration in one session. So the window is consulted in normal operation, not only for genuine crashes; it arbitrates whether a lead that has gone quiet mid-turn is alive or dead. A larger default trades slower crash-recovery for fewer false death-declarations — and the trade is not merely latency: when the window is shorter than a real turn, a **still-alive** lead is declared dead, so its in-flight Send is re-queued, its sid unregistered, and the Send redelivered and **redrawn** to the fresh lead (idempotent via `/exec` + deterministic shape ids, hence safe, but visible). That is why 120s is chosen to sit above observed turn length. It reduces but does not eliminate the effect: a turn longer than the window still trips it. **Death is declared** only after no armed listener **and** no bridge call carrying the lead sid across that window. On death-declaration the server runs `presence.unregister(deadSid)` and **drops the lead's markers**, so the next `/whiteboard open` registers a genuinely new sid (not a stale rebind onto the dead sid) and the re-queued Send drains cleanly to the new lead; a same-process rebind that beats the grace window keeps its session and in-flight work, so a live lead's handling is never dropped. The lead therefore **never shows `stalled`**, and the banner debounce is this grace window. For a **worker**, the v5.1/v6 machinery stands unchanged: a delivered Send is a lease, every `sessionId`-bearing call renews it, and the sweep reclaims a lease whose holder is silent past `STALL_MS`, re-queuing it on that same worker and surfacing *stalled* to the lead's supervisor poll as a revive directive.

**[v3] Spawning workers:** when a task splits, the lead spawns tracked subagents; each
`POST /session/register {name, transcriptPath}` for its own cursor and a **recipient id [v6]**, works
a **disjoint region**, drives the shared render-canvas via `/exec` carrying its `sessionId`, and
**self-parks on its own queue** (above). Workers are tracked subagents (they die with the run; no
detached scouts).

**Keep the loop cheap:** bounded per session; small per-turn payload (image + diff); **re-read
`references/tldraw-editor-api.md` after any autocompaction**.

Layout (all under the skill, which owns its scripts):

```
.claude/skills/whiteboard/
  SKILL.md
  SPEC.md
  references/tldraw-editor-api.md      # verified core + pointers (§5)
  references/legibility-checklist.md   # the gate + blind-critic contract (§5)
  app/                                  # Vite + React + <Tldraw> + useSync + panel + presence + PNG export + [v5] author stamping + [v6] recipient selector + per-agent status strip + [v7] valid-AgentId-only selector
  server/                               # Node: bridge (HTTP+WS) + TLSocketRoom sync + Playwright launcher
                                        #   + snapshot IO + message store + [v5] durable queue projection + agentParked
                                        #   + [v6] per-recipient projection + per-recipient lease + supervisor long-poll
                                        #   + [v7] Router / lifecycle-monitor seam + typed AgentId (400) + verbatim revive nudge
```

## 10. Out of scope

Speech-to-text (operator's local Handy types into the box); tldraw licensing/watermark;
packaging as a distributable; a structured/validated write-API; Obsidian/`.excalidraw.md` interop;
productization. **[v6] Now in scope (was out): addressable workers** — realized as **one top-level
agent (the lead) + the worker subagents it spawns**, a hub-and-spoke within **one session tree**.
**Still out of scope: multiple top-level agents / sessions on one board** (co-equal peer sessions);
the in-scope shape is strictly one lead plus its own subagents. **[v4] Explicitly rejected:** "one
server, many boards". **[v4] Specified but not built:** the transcript→message reconciler (§8.2).
**[v5] Explicitly declined:** a bridge→lead **push** over the internal UDS messaging socket — it
couples to a Claude Code internal, is undesirable UX, and cannot reach an ended lead anyway (§3,
§11). **[v9] Still declined, and not reintroduced:** v9's always-listening is a **client-side
background waiter + the harness wake-on-exit** (§8.5, #48), **not** a bridge push — the UDS
socket is untouched and #26 stands; v9 only removes the latency #26 accepted. **[v9.1] Evaluated and
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
**[v9.1] Specified but not built this round: an adherence eval for the skill's LLM behavior.** Our
evals system (`harness-eval` / `.evals/`) covers **routing** (which skill fires) and **glob reach**
today; the **adherence tier** — "was the convention obeyed" — is **not built**. The behavior worth
hardening here is the lead's invariant-adherence (re-arm the poller every turn, stay-connected /
ask-before-disconnect, teardown only on the operator signal, handle the four supervisor outcomes),
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
  crash **re-drains** rather than loses, and **loud** when no lead is parked (§8.6/`agentParked`).
  The lead's **re-arm discipline** (§9) stops the specific mistake (treating `204` as exit).
- **[v5] Coupling to CC internals — avoided by decision; [v9] its latency cost now removed without
  coupling.** The one true event-push (UDS socket injection) stays **declined** (§3, #26): the
  design adds **no** dependency on undocumented Claude Code internals, and the bridge still never
  pushes to any session. **[v9]** The latency #26 accepted — a Send to an unparked-but-alive
  recipient waiting until its next poll — is now **removed on the client side, not the server**:
  the lead keeps its `/next-instruction` waiter **parked continuously via a background job** (§8.5,
  #48), so the server's existing instant parked-waiter delivery (index.ts:1099/:1427–1433) applies
  without gaps and `agentParked` (:927) stays true. This is **not a push** and reintroduces no
  UDS/bridge coupling — it only stops the client dropping its own waiter. A Send to an **ended**
  recipient still waits for the next open (loud + durable, never lost); the sole residual gap is
  the brief mid-turn-acting window, carried by the durable queue. #26 stands, its accepted cost
  retired without weakening it. **[v9.1]** The **sanctioned** event-push that did *not* exist at #26
  — Claude Code **Channels** — was later evaluated head-to-head and **deferred** (#52): it would not
  improve the delivery *guarantee* (both it and polling ride the same durable queue; a channel push is
  itself best-effort), and its research-preview cost (a non-persistable experimental launch flag every
  session, plugin/marketplace packaging, an org gate) is not worth its lone edge for a solo POC.
  Channels is the documented **future upgrade**; today's mechanism stays the background-poll waiter.
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
- **[v4] Stale lockfile / same-board race.** Liveness is pid + `/canvas-status`; a stale lock is
  reclaimed. Two simultaneous same-board launches accepted.
- **[v4] Message log growth.** `<name>.messages.jsonl` is unbounded append; **[v5]** now also
  rewritten in place on delivery-state changes — still fine at POC scale. No rotation this round.
- **Long-poll starvation.** ~240–250s max-time; the durable queue holds a no-waiter Send (§8.5).
  **[v9]** The lead's background waiter **re-arms on every 240s `204`**, so a no-waiter window for
  a *live* lead effectively vanishes; the durable-queue hold now covers only the ended-lead /
  forced-end case and the brief mid-turn-acting window (§8.5).
- **`/exec` on localhost.** Accepted for a local POC; bind `127.0.0.1` only.
- **[v6] Worker finite lifetime.** A subagent's lifetime is undocumented (bounded by `maxTurns` and
  autocompaction), so a parked worker can die between Sends. Mitigated by the **durable per-recipient
  queue** (a Send held for a dead worker is not lost), **lead revival** (the supervisor long-poll
  surfaces a revive directive), and **drain-on-open** (the revived worker works its backlog
  oldest-first before re-parking); §8.5, §9.
- **[v6] Lead is a single point of lifecycle authority.** Only the lead spawns and revives workers,
  so if the **lead** dies, worker revival pauses until `/whiteboard open` re-drains everything and a
  fresh lead resumes supervising. This is the **same failure floor as v5** (a Send waits for the next
  open: loud, durable, never lost), now applied per queue; §9, §8.5.
- **[v7] The lead-SPOF is a reconciled non-goal, not an unaddressed gap.** Fowler's review proposed
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
  plus the lead's supervisor long-poll), never agent-to-agent; §9.
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
  the **durable-queue floor** (#48 amended, §8.5); (2) **operator-confirmed-only teardown** (§6, §8.3),
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
  check detects the corruption; and **server-owned recovery** (harvest→reload→reapply, then an
  `/agent-message` + panel line naming the recovered shape count) restores the board, **loop-guarded**
  at 2 attempts per incident plus a cooldown before it surfaces loudly instead of reload-looping.
  Residual: the guard cannot pre-empt every arbitrary-blob crash path (recovery is the floor, not the
  guard), and the pathological re-poison case is bounded, not eliminated, by the loop-guard.

Seam = **§3 topology + §4 session/presence/author contract + §5 write rules + §6 perception + §8
persistence/message/queue/authorship/multi-board contracts**, fixed here. Parallel slices, then
integration by the main (headful) session.

1. **Server: durable queue, delivery, authorship plumbing, agentParked** (`server/`) — **[v5]**
   replace the in-memory `messageQueue` with the **pending-projection over the message store**;
   `deliveredAt` on `/next-instruction`, `completedAt` on a new `POST /instruction-complete {id}`;
   drain oldest-first; persist state changes by rewriting the JSONL; add `agentParked` (a lead is
   parked iff a live long-poll waiter exists) to `/canvas-status` and broadcast a `message-state`
   frame; thread the Send `id` through `/next-instruction` (already v4). Keep sync/persistence/
   presence from v3–v4. **[v6]** add a **`recipient` field** on the message model (default lead;
   named worker; `everyone`); make the pending projection **per-recipient** (a `per-recipient pending
   projection` over the one message log, not N physical queues); make the lease **per-recipient**;
   track **per-worker parked/status**; serve the **supervisor long-poll** (`supervise=1`) that merges
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
   `agentParked` flag. Keep the v4 read-model, dedupe-by-`id`, and per-Send `idempotencyKey`. **[v6]**
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
   **lead supervisor loop** (`supervise=1`, three outcomes), the **revival nudge**
   (SendMessage-resume by id, fallback fresh-spawn, bare nudge, worker drains its own queue), and
   **scale/cap guidance** (design for 5, hard cap 20 concurrent subagents). **[v7]** rewrite the
   nudge step so the lead **sends the directive's verbatim `nudge` text** (never authoring it), state
   the **payload-vs-bootstrap test** (does the nudge vary with the instruction? under v7 it cannot),
   note the **`400` on an unknown recipient**, and adopt the **agent / recipient** vocabulary.
4. **Integration + acceptance** — main session wires it and runs the §2 scenario incl. the swarm,
   persistence, isolation, **[v5] durable-delivery, and authorship** checks; the headless
   integration test covers: **a Send with no waiter survives a server restart and is drained in
   order** on the next boot; **a delivered-but-not-completed Send re-drains** (mid-draw-crash
   simulation); **`agentParked` flips** with/without a waiter; **a created shape carries
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
   **teardown-request** and surface it to the lead's `supervise=1` poll as a **teardown directive**
   (§8.2, #53).
3. **App lane** (`app/`) — the **explicit confirm-gated teardown affordance** in the drawer (posts the
   distinct teardown-request, #53), and honest always-listening status (the collaborators row reads the
   lead as *present* while a background waiter is parked, `agentParked` continuous, §7).
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
| 6 | Speech-to-text | Out of scope; operator's local Handy types into the box |
| 7 | Agent write | `/exec` JS, tolerant, prefer bindings; verify-after-write; reference = core + pointers |
| 8 | Perception | JSON + rendered screenshot, image+diff per turn |
| 9 | Deixis | Operator selection shipped with Send; agent points back by selecting |
| 10 | Agent voice | WS `agent-message` → panel log; may ask before drawing |
| 11 | Persistence | `.tldr`; **[v3] sync server owns it**; home `.scratchpad/whiteboard/` |
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
| 26 | **[v5] No push to an unparked lead** | **Declined** the internal-UDS socket injection — couples to a CC internal, undesirable UX, cannot reach an ended lead. Robustness comes from a durable queue + loud signal + re-arm discipline + drain-on-open instead. **[v9] amended:** re-arm discipline is now **structural** (a never-lapsing background waiter, #48); this **removes the latency cost this decision accepted** (a Send to an unparked-but-alive lead waiting for its next poll) **without** reintroducing the push — no server/bridge/UDS change, so the decline stands unweakened; §3, §11 |
| 27 | **[v5] Durable queue** | The instruction queue is a **read-model projection over the message log** (one source of truth), not a second store; pending = a human Send with no `completedAt`; §8.5 |
| 28 | **[v5] Ack model** | **At-least-once, completion-acked** (`deliveredAt` on handoff, `completedAt` on `/instruction-complete`), idempotent consumer via `/exec` key + deterministic ids; a mid-draw crash **re-drains**; drain oldest-first; §8.5 |
| 29 | **[v5] Loud "nobody parked"** | The panel shows a Send's lifecycle incl. **no-agent-listening**; `/canvas-status` exposes **`agentParked`** — stranding is never silent; §8.6, §11 |
| 30 | **[v5] Authorship storage** | Per-shape **`meta.createdBy` (immutable) + `meta.lastEditedBy`** — rides sync + `.tldr` natively; stamped by an `editor.sideEffects` handler (agent: serialized per-`/exec` author context; human: URL-passed identity), never by the `/exec` blob; §8.6 |
| 31 | **[v5] Author identity + query** | Human identity resolved from `git config user.name` (fallback "Operator"); **no backfill** of old shapes; slicing is **client-side** for both consumers (no `?author=` endpoint); the human-facing canvas legend/highlight is a **fast-follow, not built**; §4, §6, §8.6 |
| 32 | **[v5.1] Lease / visibility timeout + honest signal** | A delivered Send is a **lease** renewed by any `sessionId`-bearing bridge call; a sweep reclaims it after `STALL_MS` silence and redelivers (to a present lead) — recovers a **lead-only crash while the bridge lives**, which the on-boot re-drain cannot. Server-authoritative **state** (`queued/working/stalled/done`); the no-agent banner keys on **waiting for a lead**, never on **working** (fixes the v5.0 false-banner-during-draw wart). Not auto-spawn (decision #26). **[v9]** With the always-listening background waiter (#48), "waiting for a lead" (`agentParked:false`) is reached only when the lead **session ends** — a lead that is talking or drawing still reads present — sharpening the banner's meaning; §8.5 |
| 33 | **[v6] Topology** | One **top-level agent (lead) + the worker subagents it spawns** — hub-and-spoke within one session tree; **multiple sessions / top-level agents on one board stays out of scope**; §10 (Out of scope) |
| 34 | **[v6] Addressable workers in scope** | Lifts the §10 "co-equal human-addressable sessions" exclusion, **scoped to one lead + its own subagents** (not co-equal peer sessions); a worker is directly addressable; §10 (Out of scope) |
| 35 | **[v6] Worker lifecycle** | Workers **self-park on their own durable per-recipient queue**; finite subagent lifetime is covered by the **durable queue + lead revival + drain-on-open**, not a long-lived idle worker; §9 (The skill), §8.5 (Durable instruction queue & delivery) |
| 36 | **[v6] Addressing / data model** | A **`recipient` field on human Sends** (default **lead**; a named **worker**; **`everyone`**), served by a **per-recipient pending projection over the one message log** (not N physical queues); the default recipient keeps the zero-worker case unchanged; §8.5 (Durable instruction queue & delivery), §4 (Multi-peer, sessions & presence) |
| 37 | **[v6] Revival wire** | The **lead is the sole lifecycle authority** (only an agent spawns/resumes; the bridge never does); revival via a merged **supervisor long-poll → SendMessage-resume by id (fallback fresh-spawn) → bare nudge → worker drains its own queue**; this is the **only** CC-messaging dependency and does **not** reintroduce the declined UDS push (#26); §9 (The skill), §3 (Architecture) |
| 38 | **[v6] Panel** | **One shared attributed log with addressee** + a **per-agent status strip**; the single `agentParked` boolean generalizes to a **per-worker lifecycle badge** (queued / working / stalled / absent); §8.2 (Message persistence & the panel read model), §12 (Swarm work-breakdown) |
| 39 | **[v6] Clobber** | Stays a **convention made visible by authorship** (`meta.createdBy` / `meta.lastEditedBy`); a **soft region-lock is a fast-follow**, not built this round; §10 (Out of scope), §11 (Risks & mitigations) |
| 40 | **[v6] Scale** | Design for **5** workers; hard cap = the runtime **20** concurrent-subagent limit (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, ultracode-exempt); §11 (Risks & mitigations), §12 (Swarm work-breakdown) |
| 41 | **[v7] Lead-SPOF reconciled** | Fowler's **supervisor-process that revives any agent (incl. the lead)** is **declined as not buildable** — only a CC agent can spawn/resume a subagent, never a Node process (#26, #37); the only reviver of a dead lead is a second top-level agent, which is out of scope (#33). v7 **accepts the lead-SPOF** and keeps v6's floor (a Send to an ended lead waits, loud + durable, for the next `/whiteboard open`); §3, §11 |
| 42 | **[v7] Bridge internal seam** | Name the bridge's two jobs as a **Router** (routing/projection) and a **lifecycle monitor** (health/lease-sweep/revive-directive) — a documentation + light module split, **no behavior change**; the monitor **signals, the lead acts**. "**Supervisor**" is reserved for the **lead's role** (the only actor that revives), never a bridge component; §3, §12 |
| 43 | **[v7] Typed `AgentId`** | A recipient id is a **typed, seam-validated `AgentId`**, not a bare string: valid = `{lead, everyone}` ∪ **every `clientKey` ever registered** (retained across worker death, since `clientKey` = the stable recipient id). `recipient` (`/message`) and `for` (`/next-instruction`, `/instruction-complete`) are validated at the seam; **an unknown id is `400`**. Answers "convention vs constraint"; §3, §4 |
| 44 | **[v7] Naming sharpened, not collapsed** | Unify the **actor** term on **"agent"** (the lead and its workers are agents); keep **"recipient"** as the **routing target** (an agent, or the `everyone` broadcast — which a naive collapse to "agent"/"worker" would lose); **retire "peer"** where it meant an agent (it stays the tldraw-sync term for the operator browser + render-canvas). **"Lead = an elected role" is rejected**: within one session tree the lead **is** the parent structurally, not electable (election needs multiple top-level agents, out of scope #33); §4 |
| 45 | **[v7] Structural revival nudge** | The nudge is payload-free **by construction, not discipline**: the `revive` directive **carries the exact verbatim `nudge` text** — a **fixed bootstrap template keyed only on the recipient `AgentId`** (bridge URL, `clientKey`, "drain your queue"), identical on every revival. The lead **sends it as-is** and is **never handed the instruction**, so no field can hold a paraphrase. Fixes a real v6 lapse (the nudge paraphrased the instruction); §3, §4, §8.5 |
| 46 | **[v8] Runtime board-switch = attach, not steal** | The in-app switcher (`POST /board/open`, `POST /board/new`) honors the **one-server guard** at runtime, not only at boot: before an in-process room switch it checks for a **live foreign owner** (lock `pid` alive **and** its port answers `GET /canvas-status` for that board) and, if found, returns **`{attach:true, port}`** so the browser navigates to that owner's port — it never steals the lock. Only an unowned/stale-locked board is switched-to in-process (the common single-server case is unchanged). Fixes the **split-brain** an in-process steal caused (two processes on one board; a parked waiter and a Send never meet). The **minimal guard** was chosen over a full attach-or-boot rewrite (fix #1): it closes the bug where §8.3 already promises the guard bites, at a small blast radius. The **per-process message-store cache** footgun is **fixed by prevention** — the guard makes two-on-one unreachable in solo-POC use, so no cache re-read is added; §8.3 |
| 47 | **[v8] Drawer redesign + identity color** | The operator panel is recut to read like a room: **board switcher = button + popover** (removes the always-open list's header/row crunch); the per-agent status strip and recipient `<select>` **merge into one collaborators row of identity-colored avatars**, **tap-to-address** (default lead), keeping the **400-safe roster** (only real spawned agents + the `everyone` broadcast are tappable — #43); chat attribution in each agent's color; calm no-agent notice; a token system (4/8/12/16, 3-size type, one accent + semantic status, light/dark, focus rings, 44px targets, 150–200ms). **Agent cursors dropped from the UI** (agents draw via `/exec`; identity **color** added to the `agents[]` roster — server-side from presence, deterministic fallback — for the avatars). The server-side presence-**cursor** mechanism (§7) is now **suppressed by default** (`SHOW_AGENT_CURSORS = false` in `server/presence.ts`): no agent cursor is injected into the operator's view — the static injected cursor read as a stray "glowing cursor," and the collaborators row already carries who is present and their state; the session is still tracked (name/color/state) for the roster and message attribution, and the `PresenceClient` machinery is intact behind the flag. Human peers broadcast their own cursors through their own browsers and are unaffected. **[v8 re-skin]** the first cut read *too toy-like* to the operator; the visual language was recut to Airbnb/Linear/Raycast craft (a blind 4-lens critique swarm drove it): a neutral palette with **one refined indigo accent** (was a loud violet), **small flat solid avatars in labeled participant chips** (halo ring dropped; selection is a calm active-item background, not a ring), **chat attribution neutralized** (a small identity dot + a neutral name, not a big saturated word) with each turn a name-line over its body, a top scroll-fade so messages don't guillotine, a **real Send** (confident solid accent when composable, neutral-gray when empty — no pale-lavender-disabled look), the ⌘↵ hint moved out of the placeholder, and the raw board-`source` row tag ("HOME"/"REPO") removed. **Two axes are left OPEN for the operator to settle on the live render: warm vs cool neutrals** (Airbnb pulls warm; Linear/Raycast cool — shipped cool) **and dark vs light** as the primary surface (shipped light, matching the board canvas); §4, §7 |
| 48 | **[v9] Always-listening (background-parked waiter)** | The `/next-instruction` long-poll runs in a **background Claude Code job** (`run_in_background` Bash) that keeps a waiter **parked continuously**, silently re-arming on each 240s `204` (`LONGPOLL_MS`, index.ts:42) and **exiting only when a real Send is delivered** — the exit triggers the harness's standard **session wake / re-invoke**, whereupon the session acts (draw / spawn / revive), relaunches the poll, and hands the foreground turn back. The **server is unchanged and stays pull-based** (:1099/:1427–1433 deliver to a parked waiter as before); the client simply never lets the waiter lapse, so `agentParked` (:927) stays true and delivery is instant while parked. This **removes the latency #26 accepted** (a Send to an unparked-but-alive recipient waiting for its next poll) **without adding any coupling**: no server/bridge push, so it does **not** reintroduce the declined UDS injection — fully consistent with #26, it only closes the gap #26 left open by keeping the recipient parked. To keep a single lease-renewer the background waiter runs only between turns (relaunched after `/instruction-complete`), never concurrently with the foreground; the only residual window is a Send arriving while the session is mid-turn acting, covered by the durable per-recipient queue (§8.5). **Lead-scoped** (workers keep the in-turn park). The **Monitor tool was considered and rejected**: it polls a status endpoint on an interval (reintroducing latency) and parks no waiter. **[v9.1] amended — poller form + re-arm reliability.** The poll loop lives in a **skill-owned Bash script** invoked by the one `run_in_background` Bash call (not fragile inline bash): a `curl --max-time` hanging-GET that swallows a `204` and re-opens, and on a `200` prints the delivered Send to stdout and exits (the wake). The relaunch is **not left to agent memory** — three guarantees stack: (1) relaunch is the **unmissable final step** of every read-act turn, after the ack; (2) **boot and attach verify a live poller** and start one if absent; (3) the **durable-queue floor** makes any missed re-arm loss-free (drained on the next poller return or `/whiteboard open`). A **`Stop` hook cannot own the listener**: a hook-spawned process does **not** receive CC's `run_in_background` wake-on-exit (only the agent's own Bash background job does), so the relaunch must be agent-driven, hardened by (1)-(3). **[v9.2] amended — relaunch-first + per-message leases.** The relaunch is no longer the final step after `/instruction-complete`; it is the **first action on wake, before acting** (immediate relaunch-on-receipt), so a fresh waiter is parked for the whole draw and a Send arriving mid-act is caught. The v9.1 "background waiter runs only between turns / relaunched after the ack, to keep a single lease-renewer" rationale is **superseded**: leases are **per-message** (the existing `inFlightByRecipient` Set, index.ts:822), so the lead can hold concurrent leases on m1 and m2, and a relaunched poll skips the in-flight (leased) Send via `nextPendingFor` (:923–928) — no serialization needed. Exception: a **teardown directive** relaunches nothing (§6). The one server change lands in the **`STALL_MS` sweep**, which now **spares a lease whose holder session has a live parked waiter** (`sessionHasWaiter(deliveredBy)`), keying "stalled/absent" on a genuinely **session-ended** state rather than an idle lease — **both** the false-"stepped away" fix and the deliberate-pause busy-loop fix. **Two choices recorded** (decided, not open): the `STALL_MS` remedy is **parked-waiter sparing in the sweep**, chosen over raising `STALL_MS` or a deliberation heartbeat; the lease model **stays per-message** (the existing Set — no migration to a separate per-Send lease token). "Never stop listening" is now a **hard requirement**; polling reaches **~99% not a literal 100%** (the wake still needs the poller to exit + the harness to re-invoke, and the mid-act relaunch window is a real gap the durable queue covers, not eliminates) — **Channels (#52) remains the zero-gap ceiling**, not reopened. §8.5, §3, §11 |
| 52 | **[v9.1] Channels evaluated & deferred** | The delivery-wake was re-examined against Claude Code **Channels** (a custom MCP server that pushes events into a live session) as an alternative to the polling background-waiter (#48), and **deferred, not adopted**. Finding: the delivery **guarantee** (a Send reliably received, in order, loss-free, and acted on) lives in the **durable per-recipient queue** (§8.5), which **both** designs ride — the wake (channel push *or* background-job-exit) is a **best-effort nudge** either way (channel notifications are fire-and-forget and dropped silently if the channel is unloaded), so polling **matches Channels on reliability, consistency, and latency**. Channels' only genuine edge is a listener **decoupled from the CC turn cycle** (its persistent subprocess self-polls) — an elegance bought at a **research-preview cost**: an **experimental launch flag on every session** (`--channels …`, absent from `--help`, "syntax may change," **not persistable**), **plugin + marketplace packaging**, and an org **`channelsEnabled` / `allowedChannelPlugins`** gate to avoid the `--dangerously-load-development-channels` flag. For a solo, personal-account POC that cost is not worth the elegance. **Channels is the documented future upgrade** for when it leaves preview and gains a persistable opt-in. **Supersedes** the interim direction to rewrite delivery to a Channel; #48 stands, hardened (#48 amended, #53). §3, §8.5, §11 |
| 53 | **[v9.1] Operator teardown affordance** | The operator "indicates the session can be closed" (#49/#50) through an **explicit, confirm-gated app affordance** — a "disconnect / close session" control in the drawer — which posts a **distinct teardown-request** the lead's poll surfaces as a **teardown directive** (a structural signal, not a natural-language interpretation). A natural-language Send ("we're done, you can disconnect") is honored as a **fallback**. On the directive the lead performs the graceful **`POST /done`** (render-canvas + sync server + `<name>.lock`). This is the **only** path to teardown at the operator's deliberate command; a **forced / auto** session end (autocompaction / context / `maxTurns`) still tears down **nothing** (#50 — the board process survives with resume coordinates). Extends #49/#50 with the concrete operator→lead close channel and the app↔skill seam that carries it. **[v9.6]** Hardened by #59: even holding a directive, the lead runs a pre-teardown gate (guest-refusal + unaccounted-peer re-confirm) and never infers a close from a file/migration/"switch" request; a guest never tears down at all (#57). §8.2, §9, §11 |
| 49 | **[v9] Stay-connected / no premature hangup** | Delivery is **pull-only**, so ceasing to listen == hanging up. A session **never disconnects at its own discretion** — neither by leaving the poll nor by tearing down. Default is **stay-connected**; when work looks done it **asks** ("can I disconnect?") and **keeps listening** until an explicit operator **yes**, and operator **silence keeps the line open**. Buildable because listening now runs in a **background job** (#48), so staying connected does not block the foreground. Makes the re-arm discipline (§9) a hard invariant covering the quieter hangups the `204` framing left open. Fixes the v9 incident (a lead ended its turn to ask and never received the next Send); §9, §6, §8.3 |
| 50 | **[v9] Forced-end board survival + operator-only teardown** | Teardown (`POST /done` — render-canvas + sync server + `<name>.lock`) fires **only on the operator's explicit confirmation**, never at agent discretion. On a **forced** CC-session end (autocompaction / context / `maxTurns`) the agent **leaves the board process running** (a separate Node process from the CC session, §3), **reports resume coordinates**, and **tears down nothing**; the **durable per-recipient queue + drain-on-attach** (§8.5) carry any Sends to the next session that attaches, so the operator is never truly hung up on. Consistent with the lead-SPOF floor (#41): a Send to an ended lead waits, **loud + durable**, for the next `/whiteboard open`; §6, §8.3, §11 |
| 51 | **[v9] No-TTL stale-Send pileup — known gap, follow-up** | Sends have **no TTL**: an unacked Send persists forever, oldest-first, and re-drains on boot (index.ts:879 is the sole pending filter). So a stale Send (a superseded instruction, or one whose recipient kept dying before draining) **pins the head of the oldest-first queue** and re-surfaces across sessions ahead of live work — the v9 mechanism by which the lead kept being handed old arch-redraw Sends instead of the live one. **Recorded, not fixed** this round: no TTL, expiry sweep, or operator-supersede is designed here (deferred follow-up); the oldest-first drain (§8.5) is unchanged; §8.5, §10, §11 |
| 54 | **[v9.1] Per-board browser-tab title carries the bound session name** | The operator tab's `document.title` is **`"Whiteboard: <bound session's semantic name>"`** (the app truncates for the tab), **not** the board/room name. The name is the driving CC session's `name`, resolved at boot from **`$CLAUDE_JOB_DIR/state.json`** — the same file §9 step 6 reads `linkScanPath` from for `transcriptPath` — e.g. `"my-repo: whiteboard session 10"`; **fallback** plain `"Whiteboard"` if unresolvable. The skill passes it to the operator browser as a **`session=<urlencoded>`** URL param (§9 step 5, alongside `author`/`authorKey`); the app reads and truncates it — **client-only, no new server field**. Room-identity language of #13/#47. **Caveat:** a board-switch today navigates the tab to a different board's port, so the title is **per-board-session** for now; a session that stays bound to the tab **across** board switches is deeper arch intent, recorded as **follow-on / out of scope** and not designed here; §9 |
| 55 | **[v9.3] Lead delivery reworked to liveness-driven, not lease-clocked** | **DECIDED and BUILT** (v9.3 landed test-first: board R in `integration.test.mjs` is the "lead is never stalled while alive" regression, boards E and Q were re-cut off the removed lead `stalled`, and boards H/I proved the worker sweep independent; new `LEAD_GRACE_MS`, `leadAlive` on `/canvas-status` + a `lead-alive` frame, `sweepDeadLead`). **The proven problem (P6, reproduced live on/off against a running server):** the lead's `inFlightByRecipient` lease (index.ts:822) plus the `STALL_MS` sweep (index.ts:49–50, `sweepStalledLeases` ~1191) is a **Competing-Consumers visibility-timeout misapplied to a single consumer** whose liveness signal (a parked long-poll waiter) is **destroyed by the act of delivering it work**: `poll.sh` exits on the 200 to wake the agent (poll.sh:74–78), so `agentParked` flips false the instant a Send lands, and during the whole wake→re-arm gap no waiter is parked, the v9.2 sweep-sparing (`sessionHasWaiter`, ~1183) cannot fire, and once silence passes `STALL_MS`=120s the un-acked lease is reclaimed to a **false `stalled`** (`subStateFor` ~975) and re-delivered (a busy-loop, plus the "stepped away" banner). The board-Q unit test (`integration.test.mjs` ~523–564) passed only because it kept a **second, independent waiter parked** across the pause, a state the real single-poller never holds mid-turn, so the green test hid the bug. **The decision (Fowler's option B, sharpened):** keep Guaranteed Delivery (the durable message log + completion ack are untouched); for the LEAD, delete the timed lease and the stall, and instead: (a) receipt/working is an **automatic, clockless, session-scoped delivered-marker** set on delivery (held by session S, not yet handled), replacing the timed lease for the lead; (b) completion is the agent's `/instruction-complete` meaning **HANDLED** (responded or acted on the board), not merely received, and is the sole durable retire; (c) redelivery is **liveness-driven, never clock-driven**, so a received-but-un-handled Send re-queues for the next lead only once its holder is confirmed not-listening (dead), with **no timer on the message**; (d) **Idempotent Receiver** (dedupe by the threaded message id) makes any accidental duplicate harmless, and a rare double-handle on crash-after-work-before-ack is inherent to at-least-once and acceptable for a whiteboard; (e) **liveness = an armed listener exists** (a parked waiter, never a bare heartbeat), and the unavoidable wake→re-arm gap is bridged by a **~2 min HEALTH-CHECK grace window** (default `LEAD_GRACE_MS`) framed on the liveness concern, honest and separate, never a message state; on death-declaration the server runs `presence.unregister(deadSid)` and drops its markers so the next `/whiteboard open` registers a genuinely new sid (no stale rebind, `/session/register` ~713) and the re-queued Send drains cleanly to the new lead, while a same-process rebind that beats the grace keeps its session and in-flight work; the default (120s) sits above observed turn length because the grace does not only arbitrate genuine crashes — a live-but-slow turn that runs past it with no bridge call is itself declared dead, re-queuing and redrawing that lead's in-flight Send (idempotent, so safe, but visible), an effect the larger default reduces but does not eliminate (§9); (f) the lead's Send states **lose `stalled` entirely** (`queued → working → handled`), and the banner debounce is the grace window (stop reading transient `agentParked===false` as "session ended", the state that forced `recipientNotListening`/absent at App.tsx ~1053/~1077 and `lifecycleLabel` ~91); (g) **P1 (relaunch-first on wake) stays but is load-bearing for liveness + latency, not a lease clock** (a slow re-arm now costs latency, not correctness, since the grace window + idempotency cover it); (h) **WORKERS keep their own `STALL_MS` reclaim** (genuine competing consumers, being many, revivable, with no takeover event), so lead and worker **diverge on purpose**. **Two cautions recorded (accepted from Fowler):** do **not** over-correct into a rewrite, and refactor test-first off the existing P6 reproduction (`repro-p6.mjs`), writing "the lead is never stalled while its session is alive" as a failing test first and making the smallest change that passes it; and **prove the worker/revive path does not depend on the shared sweep** before removing the lead's timer, so a lead-only carve-out cannot break revival. **Supersedes the v9.2 clause of #48** (parked-waiter sparing in the sweep + the per-message timed lease) FOR THE LEAD; #48's always-listening background waiter otherwise stands. §8.5, §9, §7, §13 (supersedes #48 v9.2 clause) |
| 56 | **[v9.5] A malformed exec can never silently sever sync** | **The proven problem:** an `/exec` blob that produces a schema-invalid record (the classic: a geo shape with a top-level `w`/`h` instead of under `props`) makes tldraw's editor call `store.markAsPossiblyCorrupted()` **inside** the failing `store.put`, before the JS throw reaches the exec handler's try/catch. The flag is **sticky with no public reset** (`@tldraw/store` `Store.js:734-741`); while set, `@tldraw/sync-core` (`TLSyncClient.js:175`) silently suppresses **every** outbound push though the socket stays connected, so later well-formed execs return `ok:true`, render locally, and **never reach the room** (the board freezes at the poison point, every signal still healthy). **The decision (a three-level fork):** (1) **prevention**, a best-effort **validate-first store-guard** that rejects a schema-invalid record (`ok:false` + the validation message) before it reaches the crashing `store.put`; it reduces recovery frequency, is not exhaustive for arbitrary blob JS, and so is **not** the guarantee; (2) **honest contract**, where `ok:true` means **confirmed present in the room**: the server bounds-waits for the room `documentClock`/shape-set to reflect the write and reads the corruption boolean, **per exec** (this same check **is** the detector), returning a distinct `sync-severed` `ok:false` on a severed write; the existing launch/navigate `verifyCanvasSynced` (a different boot race) is unchanged; (3) **recovery**, a **server-owned** auto **harvest→reload→reapply** (reload rebuilds the store, the only way to clear the sticky flag; reapply is an idempotent create-or-update keyed by shape id), then **notify** (an `/agent-message` + panel line naming the recovered shape count), **loop-guarded at max 2 attempts per incident + a short cooldown**, then stop and surface loudly. Harvest carries only valid records (the poison was rejected at `put` and never landed), so reapply does not re-poison in the normal case; the guard covers the pathological edge. **Rejected alternatives:** **silent-only recovery** (recover but say nothing), rejected because a severed board must be **announced**, not quietly patched, so the operator knows a draw was re-applied; **catch-and-reset the flag** (let it corrupt, then clear the boolean), **impossible** because the flag has **no public reset** (`Store.js:734-741`), which is exactly why recovery must rebuild the store via reload; **periodic-only detection** (a background sweep polling store health on an interval), rejected because it reintroduces latency and lets a severed write return a false `ok:true` in the meantime, whereas the **per-exec** check makes the contract honest at the moment of the write. **The sync-integrity invariant:** an `/exec` that returns `ok` has reached the room; a corrupted store is auto-recovered and announced, never silently dropped. **Local to this skill**, nothing upstreamed to tldraw. §5, §1, §2, §11 |
| 57 | **[v9.6] Lockfile records the owning session** | **The proven problem (from the board-teardown incident):** the lock `{ port, pid, board, startedAt }` lets a second `/whiteboard` detect *a* live process but not *whose*, so a session that did not boot a board cannot tell it is a **guest** on a board another session drives — one input to the incident where a lead tore down a **shared, live** board. **The decision:** the process is handed its booting session's identity at boot via `WHITEBOARD_OWNER_SESSION` (the human-readable CC session name, the same value #54 uses for the tab title) and `WHITEBOARD_OWNER_SESSION_ID` (the **stable** `CLAUDE_CODE_SESSION_ID`), and writes both into the lock (`ownerSession?`, `ownerSessionId?`, both optional). `/canvas-status` echoes them. On boot/attach a second session compares the lock's `ownerSessionId` to its **own** session id: **match ⇒ owner**, **mismatch (or an owned board it did not boot) ⇒ guest**; a guest draws as a peer but performs **no destructive act** (`/done`, or stealing the lock) on a **live** board another session booted — **not even on an explicit operator close**, which is carried out from the **owning** session (#59). A guest reclaims a lock only when the board is **stale/dead** (the ordinary boot path). **Why the CC session id, not the whiteboard `sessionId`:** the comparison must be computable by the second session **before it registers**, and both sessions can read their own `$CLAUDE_JOB_DIR/state.json`; the whiteboard `sessionId` is assigned only at registration and would need a post-boot lock rewrite. **Backward-compatible:** every reader parses by field name (the lone in-process reader `readLock` still validates only `port`/`pid`), so the added fields break nothing; an ownerless lock is treated as foreign by any session that did not boot it. §8.3, §9, SKILL §1/§6 |
| 58 | **[v9.6] Client disconnection guard + teardown export-now broadcast — the root fix for silent loss** | **The proven problem:** `app/src/App.tsx` joins the room via `@tldraw/sync` `useSync({uri, assets})` with **no `persistenceKey` / no IndexedDB** (`localStorage` holds only UI prefs), so a tab whose server has died keeps accepting edits into an in-memory store that **syncs nowhere, with no warning** — the mechanism by which the incident's disconnected collaborator lost work. Fixes #57 and #59 prevent the *improper teardown*; this is the **defense-in-depth** that prevents *silent loss regardless of the disconnect's cause* (server crash, network, or a teardown). **The decision (both halves):** (a) a **client-side disconnection banner** — the human render (never the headless agent canvas) reads the `useSync` status wrapper (`store.status === 'synced-remote' && store.connectionStatus === 'online'`, the same expression the `sync-health` probe uses), and when the socket stays down past a short **debounce** (~2.5s, to ignore tldraw's normal brief auto-reconnects) shows an unmissable canvas-overlay "**disconnected — your changes are not being saved, export now**" alert; and (b) a **teardown broadcast** — `shutdown()` sends a new `server-closing` frame over the existing `broadcastToHumans` channel **before** the sockets close (with a ~150ms flush delay), which the client shows **immediately** (no debounce, it is definitive) as "**this board is closing — export now**." The banner is the load-bearing piece (it fires on any disconnect); the broadcast is the belt-and-suspenders for the graceful-teardown path. **Rejected:** relying on the SKILL.md prose fixes alone — the loss is **silent by design of the sync client**, not a server bug (`/done` correctly snapshots and closes; the loss is client-side), so the real protection must live in the client. **Requires an app rebuild** for both the browser and the headless render-canvas to pick it up. §8.1, §3, SKILL §6, §11 |
| 59 | **[v9.6] Teardown always requires an explicit operator close; copy-then-switch homing; pre-teardown gate** | **The proven problem:** the incident's `POST /done` was a **discretionary, unauthorized** teardown of a shared live board, reached by mis-reading a natural-language "switch us onto the moved file" (a *keep-working* instruction) as teardown authorization, and by using `git mv`+reboot to free the live file when the file could have been homed with the server untouched. **The decision (three clauses, all hardening #49/#50/#53):** (1) **absolute rule** — a lead performs `/done` **only** on an explicit operator instruction to close *this* board (the confirm-gated directive #53, or an unambiguous "we're done, you can disconnect"); it is **never** inferred from finished-looking work, a full board, a file/migration/"switch" request, or silence — when in doubt, **ASK and keep listening** (the symmetric twin of the #49 stay-connected invariant). (2) **Copy-then-switch homing** — a live board's `.tldr` is homed by `cp`-ing the ≤~2s-fresh snapshot to the tracked path **while the server stays live** and committing the copy; `git mv`+reboot is a teardown in disguise, reserved for an explicit operator teardown (§8.1). (3) **Pre-teardown safety gate** — before any `/done`, `GET /canvas-status`: **refuse** if the session is a **guest** (foreign `ownerSessionId`, #57), and **re-confirm on the board** if `humans` shows a peer it cannot account for (e.g. solo work but `humans > 1`), rather than closing silently; only an owner with accounted-for peers proceeds. The `/done` export-now broadcast (#58) then warns any remaining peer before the sockets drop. **Operator directive:** the human must **always** have explicitly instructed or approved the close — this is a hard invariant, not a heuristic. §6, §8.1, §8.3, §9, §11 (hardens #49/#50/#53) |
| 60 | **[v9.7] Lead delivery is acknowledged by consumer receipt, not by the server's write** | **DECIDED and BUILT** (test-first: `lost-wakeup.test.mjs` reproduces the strand on demand with a raw frozen socket and asserts the restored invariant; boards P/Q/R in `integration.test.mjs` and `poll.test.sh` were updated to the new ack contract and stay green). **The proven problem (2026-09-25 incident, reproduced on/off):** the lead's clockless delivered-marker (#55) is stamped in `markDelivered` on the server's **write** to a parked waiter (`serviceWaiters`/the `/next-instruction` drain), which is **not** proof the consumer received the bytes. The operator's laptop slept mid-poll, leaving the lead's parked socket **half-open** (peer gone, no FIN), so the server's `res.json` of the first Send `877c1f66` buffered into the kernel and was **lost** — but `deliveredAt`/`deliveredBy`+the lease were already committed. Because the lead lease is reclaimed **only on a confirmed-dead session** (`sweepDeadLead`) and the session **re-armed and stayed alive**, the Send was stranded `working` forever and skipped by `nextPendingFor` on every later poll, so the operator had to send a **second** Send to get a response, and the UI showed a stuck `working` badge. Neither weaker option holds: **commit-on-flush** cannot detect a kernel-buffered write to a frozen peer (`finish` fires regardless); **redeliver-on-re-arm without an ack** busy-loops, because a well-behaved lead re-arms **before** completing, so "held + fresh waiter" is indistinguishable from a lost delivery. **The decision (Fowler's lens: move the acknowledgment from the producer's transmission to the consumer's receipt — JMS client-ack, not auto-ack):** add `POST /instruction-received {id}`, which `poll.sh` sends on a `200` **before it exits**, stamping a **`receivedAt`** third state between `deliveredAt` (written) and `completedAt` (handled); and at the lead's arm, **before the drain**, `reclaimLostLeadDeliveries` reclaims and re-serves any held receipt that is **delivered-but-un-`receivedAt`-acked** and whose holder is **this re-arming session** (the single-poller re-arms only after its prior socket closed, so that socket is provably gone and never confirmed receipt). Still **liveness-driven, not clock-driven** (the re-arm is the liveness event); still **at-least-once**, never a strand; **lead-only** (workers keep the `STALL_MS` lease, which already reclaims a lost worker delivery on silence). A (re)delivery clears any prior `receivedAt` (`markDelivered`) so an earlier lead's ack cannot immunize a re-queued Send, and the ack carries a `deliveredAt` nonce so a stale ack for a superseded delivery is a no-op. **The ack is load-bearing, not best-effort:** it is the only guard against a re-arm re-serving a consumed Send, so a *persistent* ack failure would redeliver every Send (bounded to one per Send by completion), not a rare one — `poll.sh` therefore prefers a `node` parse, falls back to POSIX grep/sed when `node` is off its PATH, and WARNs loudly rather than degrade silently (the SPOF a review flagged). A *transient* miss stays a bounded, idempotent double. **Amends #55** (the marker is set on write, but receipt is now consumer-confirmed for lost-delivery detection); #55's clockless-by-session model otherwise stands. §8.5, §9 (amends #55) |
| 61 | **[v9.8] A failed render export never reads as a fresh frame** | **DECIDED and BUILT** (test-first: `render-stall.test.mjs` reproduces the stale-200 on demand against a fake render-canvas on an ephemeral port and asserts the invariant; the toggle was proven by reverting the handler to the buggy resolve, which re-fails the regression). **The proven problem (2026-09-25, proven from code):** the rendered PNG has one producer — the headless render-canvas answering `export-image`. On a failed export (`editor.toImage` throws or yields no blob; leading suspect **WebGL/canvas context loss after a laptop suspend** — a live-but-degraded Chromium, not a dead socket) the app does **no upload** and answers `{type:'image', id, ok:false}` with **no `path`**. The bridge's `image`/`image-result` handler ignored the `ok` flag and called `resolveImage(msg.id, msg.path)`; with `msg.path` undefined, `resolveImage` did `w.resolve(resultPath || latestImagePath)` and handed the `/image` waiter the **stale last-good path**, so `GET /image` returned **HTTP 200 + a path whose PNG mtime/size/dims were frozen** while the live board had moved on. An agent that "verifies visually" then read an old board and drew a false conclusion (it corrupted a legibility gate). A second, latent hazard in the same function: `if (idx === -1 && imageWaiters.length) idx = 0` resolved the **oldest** waiter for an unmatched id, a second way a caller got a path meant for another request. `canvas-status` was structurally blind to export health (`connected` = WS open, `browserUp` = Playwright handle exists), so the stall showed every signal healthy. **The decision (bridge-side; the app already signals `ok:false`):** the image frame is **ok/err signalling only, never a resolve-with-path** — the fresh path arrives solely from `POST /image-upload`, which the app **awaits before** it sends the frame (so on success the waiter is already resolved and the frame is a no-op), and on `ok:false` the bridge **rejects** the waiter (`rejectImage`) so `GET /image` returns **503 with the export error, never a stale 200**. `resolveImage`/`rejectImage` match by **exact id only** (the idx=0 fallback is removed); an unmatched id resolves nothing and the waiter times out honestly. `canvas-status` gains `lastExportOk` / `lastExportError` / `lastExportAt` / `lastImageMtime` / `lastImageBytes`, so `lastExportOk:false` or a non-advancing `lastImageMtime` **is** the stall. **Rejected / deferred:** making the ack best-effort or resolving with an "explicit staleness signal" the caller must remember to check — a 503 is unmissable, a stale-but-flagged 200 is not; **render-canvas self-recovery after suspend** (reload the page on a detected context loss) is a separate concern **left out of scope** here pending its own decision. **Independent of #60:** bug #60 was a half-open socket on the *message* path; this is a *live* socket returning `ok:false` on the *image* path — a shared environmental trigger (suspend), separate mechanisms and fixes. **Bridge-only, no app rebuild** (the app already sends `ok:false`). §6.1, §5, §11 |
| 62 | **[v9.9] The whole-board export is size- and time-bounded, and the render-canvas silently self-heals** | **DECIDED and BUILT** (test-first: `render-cap.test.mjs` proves region forwarding + the no-frame timeout health by toggle against a fake render-canvas on an ephemeral port; the app-side raster cap and the Playwright crash/disconnect restart run in a real browser, outside that harness). **The proven problem:** the whole-board PNG export rasterized every shape at the bitmap default `pixelRatio` 2 (4× the pixels) with no size or time cap, so on the ~244-shape board in the degraded headless Chromium (software swiftshader, post-suspend) it hung/OOM'd the renderer — `GET /image` and every `/canvas-status` `lastExport*` field went `null` and the render-canvas Chromium died while `browserUp` still reported `true`; this is #61's explicitly deferred piece (render-canvas self-recovery after suspend). **The decision (five parts):** (1) **export scope** — a whole-board export **downscales to a bird's-eye**: compute the content (or requested) bounds, set scale so the raster's longest side ≤ `EXPORT_MAX_PX` (2200px), and pin `pixelRatio` to 1 (undoing the bitmap default 2); **all shapes stay visible**, only resolution drops, and an optional page-coordinate region — `GET /image?bounds=x,y,w,h`, forwarded verbatim on the export-image frame — renders a **full-detail crop** so the driving agent can zoom in on a piece of the diagram (malformed/non-positive bounds degrade to whole-board, never a 400; the `/image` JSON echoes the applied region as `{ path, bounds }` — `null` for whole-board — so a dropped/typo'd region is detectable, not a silent wrong frame [review amendment 2026-09-28]); (2) **client timeout** — the app wraps `toImage` in a **12s timeout** (below the bridge's 15s `WS_REQUEST_TIMEOUT_MS`, env-overridable via `WHITEBOARD_WS_TIMEOUT_MS`) so a hung render becomes a reported `{ok:false, error}` frame the bridge records as `lastExportError`, not a silent stall; (3) **server timeout health** — `requestImage` records `lastExportOk:false` / `lastExportError='export timed out (no frame from render-canvas)'` / `lastExportAt` when an export times out with **no frame at all** (a hang, or a page that is gone), where it previously recorded nothing — the exact all-`lastExport*`-null signature of this stall; (4) **supervised self-recovery** — `launchRenderCanvas` registers **identity-guarded** browser `disconnected` and page `crash` handlers (a stale browser's late event, e.g. from the intentional close of the corpse, can't tear down a recovered canvas) that null the browser/canvasPage handles (so `browserUp` stops lying) and relaunch the same room with a **bounded retry** (up to 3 attempts, backoff, post-launch liveness re-check for a crash during the verify window; a parked `/image` waiter is failed fast rather than left to the WS timeout), guarded against re-entry and against the graceful teardown path (`shutdown()` sets `shuttingDown` before closing the browser, so that close is not mistaken for a crash). Recovery is **silent** (server-log only, no panel message — a deliberate contrast with #61's corruption-recovery, which announces via `postSystemMessage`; a missed export beat is self-healing and not worth a chat line), **but an exhausted, unrecoverable self-heal is surfaced on `/canvas-status`** (`lastExportOk:false` + `lastExportError`) so a permanently dead canvas is attestable rather than a silent null [**review amendment 2026-09-28**, operator-approved: the original "silent" covered a routine blip; a one-shot relaunch that gave up terminally, or a crash-at-launch loop, would have made a permanent death or resource churn invisible, so the retry is bounded and the give-up speaks — still no chat-panel line]; (5) **decouple** — the redundant spontaneous post-exec app-side export is removed; `runExec` already issues its own tracked `/image` request (the single verify-after-write source), so the second full-board render was pure duplicated OOM pressure whose failures were invisible to health. **Rejected:** **region-only** (breaks see-the-whole-board), a **shape-count ceiling** (silently drops shapes), and an **announced restart** (a missed export beat is not worth a chat line). **Extends/amends #61** — delivers its deferred render-canvas self-recovery and adds the OOM cap the stale-frame fix did not address. §6.1, §5, §11 |
