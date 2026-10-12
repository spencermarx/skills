---
name: whiteboard
description: "Stand up a live, shared tldraw whiteboard the user and one or more agent sessions draw on together in real time, as peers in one sync room. Use when someone types /whiteboard or says live or collaborative whiteboard, draw with me, sketch this together, whiteboard it with the agents, or real-time diagramming. Not for a static diagram saved into a document and never revisited: draw that directly in the document's own format."
argument-hint: "[new <name> | open <name-or-path>]"
license: MIT
compatibility: "Needs Node.js 22.12+, npm, curl and a browser. On first use it installs tldraw, Vite and Playwright with its Chromium (about 150 MB), after asking. Listening while the user chats needs a harness that resumes a session when a background job exits (Claude Code); elsewhere the lead listens in the foreground."
metadata:
  status: "incubating"
  internal: true
---

# Whiteboard

A live, local tldraw board the user draws on while you read the board and edit
it alongside them. When the work splits, you spawn worker subagents that draw on
the same board as their own visible cursors. The target feeling is standing at a
whiteboard with coworkers: the user sketches, points and says what they want; you
ask when unsure, draw while they watch, and point back at what you did.

The board is a **tldraw sync room**. A board is its `.tldr` file, and its room id
derives from that file's path, so two files with the same name are two boards.
Everyone joins the room as a peer: the user's browser, one shared headless
**render-canvas** (the agents' eyes and hands, a Playwright Chromium running the
app), and the lead and any workers as named cursors. The user watches everything
in their own browser.

**One process per board.** Each open board is its own Node process hosting the
bridge and the sync server, bound to `127.0.0.1` on a port the OS assigns. There
is no fixed port: read it from the board's lock and use it for the browser and
every request. The lock records that port, so a second session on the same board
**attaches** instead of starting a rival server, and the server refuses to start
on a board another live server holds. The server answers only its own clients:
requests must address `127.0.0.1:<port>` or `localhost:<port>`, and a browser
page from any other origin is refused.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything. Run commands from the repository root.

- `scripts/whiteboard.sh`: install the runtime, locate a board, start its server.
- `server/poll.sh`: the lead's listener.
- `references/tldraw-editor-api.md`: the verified write API for `/exec`.
- `references/legibility-checklist.md`: the legibility gate and the blind critic.
- `references/workers.md`: spawning, addressing and reviving workers.
- `references/teardown.md`: the close rules, in full.
- `references/harness-notes.md`: which listening mode each harness uses, session
  identity, and reviving a worker, in Claude Code and elsewhere.

**tldraw has its own licence.** It allows use in an internal development
environment, which a board on `127.0.0.1` is; use in production (anything serving
end users, customers or the public) needs a licence key from tldraw. Say so if
the user asks to host a board anywhere else.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). Read the scratch folder from
`docs/agents/workspace.md`. If it is missing, use `.scratchpad/` and suggest the
user run the `setup-aclarify-skills` skill.

The **boards folder** is `<scratch folder>/whiteboard/`. New boards are created
there as `<name>.tldr`; a board can also be any `.tldr` file inside the
repository. Every board's own files live in the boards folder, wherever its
`.tldr` is, named by its room id: the lock `<room>.lock`, the chat log
`<room>.messages.jsonl`, the last render `<room>.png` and the server's output
`<room>.log`. `scripts/whiteboard.sh locate` prints a board's room id and these
paths. The scratch folder is git-ignored, so list it directly; a recursive
search that obeys `.gitignore` skips it.

## 0. The runtime

The board needs its app built and the server's dependencies and Chromium
installed. Check first:

```bash
bash scripts/whiteboard.sh status --repo . --scratch <scratch folder>
```

- **Exit 0** (`installed: <dir>`): go to boot.
- **Exit 3** (not installed): show the user the commands it printed, and that
  Playwright downloads Chromium (about 150 MB). Ask before installing, using your
  structured-question tool if you have one; otherwise list numbered options in
  plain text and stop until they reply. On a yes, run
  `bash scripts/whiteboard.sh install --repo . --scratch <scratch folder>`. If it
  fails, show the command it printed for the user to run.
- **Exit 1**: a precondition failed (usually Node.js missing or too old). Show the
  message and stop.

The check runs again on every boot, so a skill update that changes the app or its
pins asks for a fresh install. When this skill's folder is read-only (a plugin
cache), the runtime installs into `<scratch folder>/whiteboard-runtime/` instead.

## 1. Boot

**1. Resolve the board file.**

- `open <name>`: `<boards folder>/<name>.tldr`.
- `open <path>`: that `.tldr` file, which must be inside the repository. A path
  is anything with a `/` or ending in `.tldr`.
- Either way the file must already exist; error if it does not. `open` never
  creates.
- `new <name>`: `<boards folder>/<slug>.tldr`, the slug made from the name. Error
  if it already exists. Never reuse or overwrite; `open` is for an existing board.
- No argument: the most recently modified `.tldr` in the boards folder, else `new`
  with a default name.

Name boards in spaced Title Case for people ("Sales Engine Design") and slug the
file name from it.

**2. Locate it: attach or boot.**

```bash
bash scripts/whiteboard.sh locate --board "<board file>" --repo . --scratch <scratch folder>
```

It prints one JSON object: `{ board, name, room, lock, messages, png, log, live }`.
`board` is the file's canonical path, `room` its room id, and `lock` and `log`
its files in the boards folder. `live` is the lock's contents,
`{ port, pid, board, path, name, startedAt, ownerSession?, ownerSessionId? }`,
when a server holding it is running (its pid is alive and its port answers for
this room), else `null`. Read every field by name; the shapes grow.

- **Attach** when `live` is set: never start a second process. Skip to step 5
  with `live.port`. `new` on a live board is an error.
- **Owner or guest.** Compare `live.ownerSessionId` with your own session id
  (resolved as in `references/harness-notes.md`). If they match, you booted this
  board and are its **owner**. Otherwise, or when the lock names no owner and you
  did not boot it, you are a **guest** on a board another session drives: draw on
  it freely, but never do anything destructive to it, whatever the user says. No
  `POST /done`, never take its lock. A guest handed a close says so and points the
  user at the owning session. `/canvas-status` echoes the owner too.
- Otherwise (`live` is `null`, the lock stale or absent): boot. The new server
  replaces a stale lock.

**3. Start the server.** Resolve your session's identity first
(`references/harness-notes.md`, "Who is this session"); an empty value is safe and
just records no owner. Start the server detached from your session, so it outlives
a forced session end, appending its output to the board's log (the `log` path
from step 2):

```bash
WHITEBOARD_OWNER_SESSION="$OWNER_SESSION" WHITEBOARD_OWNER_SESSION_ID="$OWNER_SESSION_ID" \
  nohup bash scripts/whiteboard.sh start --board "<board file>" \
  --repo . --scratch <scratch folder> >> "<log>" 2>&1 &
```

Then run `locate` again until `live` is set, and take the port from `live.port`.
The server writes the lock itself once it is listening; you never write it. If
`live` is still `null` after about 30 seconds, read the end of `<log>`: the server
refuses to start, saying why, on a board outside the repository, a file it cannot
load as a board (it never overwrites one), and a board another live server holds
(attach to that one instead).

**4. Wait for the render-canvas.** It is the agents' shared editor and the only
thing that makes pixels. Poll until it is connected:

```bash
curl -s http://127.0.0.1:<port>/canvas-status    # until "connected":true
```

**5. Open the user's browser** on the room, with their identity in the URL:

```
http://127.0.0.1:<port>/?role=human&room=<room>&author=<display name>&authorKey=<stable key>&session=<session name>
```

`<room>` is the room id from step 2 (`/canvas-status` reports it as
`activeRoom`). The identity stamps the shapes they draw (`meta.createdBy`,
`meta.lastEditedBy`). The user is a native sync peer and does **not** register a
session. Take
`author` from `git config user.name`, and `authorKey` as a lowercase slug of it;
if nothing resolves, use `author=Operator&authorKey=operator`. Add
`session=<session name>` when you have one; it titles the tab. URL-encode every
value. Open the URL with the platform's opener (`open` on macOS, `xdg-open` on
Linux), or print it for the user to open.

**6. Register the lead's session**, which gives you your own cursor:

```bash
curl -s -X POST http://127.0.0.1:<port>/session/register -H 'content-type: application/json' \
  -d '{"name":"<your display name>","clientKey":"lead","transcriptPath":"<path, if you have one>"}'
# → { "sessionId": "..." }
```

The `clientKey` is stable: re-registering with the same key after a reconnect
returns the same `sessionId` and one cursor, never a duplicate. Keep the
`sessionId`; every `/exec`, `/agent-message` and poll you send carries it.

**7. Arm the listener.** The lead listens by running the supervisor long-poll
inside `server/poll.sh`:

```bash
bash server/poll.sh "http://127.0.0.1:<port>" "supervise=1&sessionId=<sid>"
```

The poller re-arms silently on every `204` or timeout. Only on a real delivery
(`200`) does it confirm receipt to the bridge, print the body to stdout and exit;
that exit is the wake. How you run it depends on one thing your harness can or
cannot do: resume your session when a background job exits, handing it the job's
output (`references/harness-notes.md` says which harnesses can, and how).

- **With background resume:** launch the poller **once as a background job**,
  then hand the turn back. The user can keep talking to you while it listens.
  Before handing the turn back, confirm a waiter is parked: `GET /canvas-status`
  must show `agentParked:true`. If it does not, launch a poller. On attach, if the
  instance has no parked lead, you become it.
- **Without it:** run the poller **in the foreground as the last act of the
  turn**. It blocks until a Send arrives, and its output starts your next turn.
  You cannot converse while it listens, so tell the user at boot that they talk
  to you through the panel. The parked check does not apply: the blocking poller
  is the waiter.

**A backlog drains oldest-first with no special handling.** Sends the user queued
while no lead was on the board wait in the bridge's durable queue; the first poll
returns the oldest, and each wake takes the next.

With background resume, three things keep the listener alive without relying on
memory: relaunching it as the first act of every wake (step (a′) below), the
parked check at boot and attach, and the durable queue, which means a missed
relaunch loses nothing: the Send waits, visibly, and drains on the next poll.

## 2. The read-act loop

A turn begins when you are woken with the poller's output. With background
resume, the user and you keep talking between turns while the waiter stays
parked. Every request uses the captured port. Steps (b) to (g) are the read-act
turn; a worker runs them the same way on its own queue (`references/workers.md`).

**(a) Read the wake.** The supervisor poll resolves to one of four things; the
poller absorbs the timeout, so a wake always carries one of the other three, as
JSON on its stdout:

- **The lead's own Send:** `{ reArmFirst, instruction, selection, id, at, for:"lead", broadcast? }`.
  `selection` is the shape ids the user had selected; `id` is the message id.
  `reArmFirst` is a fixed reminder of step (a′): obey it, never relay it.
  Run steps (b) to (g). The lead's own work takes priority over a revive.
- **A revive directive:** `{ revive:"<id>", name?, nudge:"<text>" }`. A worker has
  a pending Send and no live poll. Relay the `nudge` verbatim
  (`references/workers.md`), relaunching the poller as (a′) says. There is no
  read-act turn and no ack.
- **A teardown directive:** the user pressed the panel's confirm-gated
  close-session control; `GET /canvas-status` corroborates with
  `teardownRequested:true`. Go straight to section 6, and never relaunch the
  poller after it, in either mode.

You can revive a worker only in the woken turn that delivered the revive
directive; nothing can nudge a worker while you are parked.

**(a′) Relaunch the poller.** The wake exited it, so you are not listening until
it runs again. Where depends on the mode you armed in boot step 7; the one
exception in both is a teardown directive.

- **With background resume: first, before anything else.** Relaunch
  `server/poll.sh` exactly as in boot step 7, then do the turn. There is no
  relaunch at the end of the turn; the ack (g) is the turn's last bridge call.
  Relaunching first keeps you listening for the whole turn: a Send that arrives
  while you draw goes to the fresh waiter and wakes the next turn. It is safe,
  because redelivery is driven by liveness, not a clock: a Send you are working
  stays held for your session and returns to the queue only if your session is
  confirmed dead.
- **Without it: last.** Do the turn and its ack (g), then run the poller in the
  foreground as the turn's last act. A Send that arrives while you draw waits in
  the queue and is the poller's first delivery. The payload's `reArmFirst`
  reminder says this too.

**(b) Perceive both: ids and pixels.** Pass `sessionId` on both, which also
heartbeats your session on the Send you are working:

- `GET /shapes?sessionId=<sid>`: JSON, for the ids you write against.
- `GET /image?sessionId=<sid>`: returns `{ path, bounds }`, where `path` is a
  freshly rendered PNG. **Open and view that image**, so you see the board:
  overlaps, crossing arrows and label overflow, none of which the JSON shows.
  - The default is a downscaled whole-board view: every shape stays visible, but
    the longest side is capped near 2200px so a large board cannot hang the
    renderer. It reduces resolution; it never crops.
  - Zoom in with `&bounds=x,y,w,h` (page coordinates, read from `/shapes`) for a
    full-detail crop of one region. Take the overview first, then zoom where you
    need to look closely. Bad bounds fall back to the whole board; a returned
    `bounds` of `null` tells you that happened.
  - A `200` is always a frame rendered for this request. A failed export returns
    `503`; retry, since the render-canvas restarts itself after a crash or a
    laptop sleep. `lastExportOk` and `lastExportError` on `/canvas-status` say
    whether exports are healthy, and say so when the restarts have given up.
- Resolve "these" and "this" from the `selection` ids.

Every call that carries your `sessionId` is a heartbeat telling the bridge you are
still working, so a long draw never shows the user a false "nobody's home".

**(c) If it is ambiguous, ask; never guess.** When the instruction leans on "this"
or "these" and the selection is empty, or the intent is unclear, ask in words with
`POST /agent-message {text, sessionId}` and go back to waiting. Ask questions, not
confirmations.

**(d) Draw with `/exec`.**

```bash
POST /exec  { code, sessionId, idempotencyKey }
```

Pass a fresh `idempotencyKey` (a UUID) per logical write, and **reuse it when you
retry** after a timeout: a repeated key returns the cached result without running
the code again, so a retry never duplicates shapes. `code` is tldraw JavaScript
against the live `editor`; read `references/tldraw-editor-api.md` for the
verified calls. Prefer bindings and relative placement over absolute coordinates,
so a box the user nudges keeps its arrow. Size shapes to their text up front: a
`geo` box clips its label top and bottom when it is too short. Your edits and
cursor appear live in the user's browser as you make them.

**(e) Legibility gate: a blind critic.** Your own eyes are optimistic about your
own drawing, so clipped titles and mid-word breaks get waved through as polish.
Run the check with fresh eyes, blind to intent, as
`references/legibility-checklist.md` describes: render with `GET /image`, and if
you can dispatch subagents, hand one only the PNG path and the checklist's "Must
pass" items, never the instruction or your code; otherwise check it yourself, the
image before the instruction. On any fail, correct with `/exec` and re-check, up
to **3 rounds**; if it still fails, say in an `/agent-message` that the board may
be hard to read and where. Once it passes, take at most one aesthetic pass, then
stop.

**(f) Point back.** Select the shapes you touched (`editor.select(...)` through
`/exec`) and `POST /agent-message {text, sessionId}` a one-line summary naming
them ("connected the two you selected; added a Store below the middle box").

**(g) Ack the turn.** `POST /instruction-complete { id, for }` with the Send's
`id`. `for` defaults to `lead`, so the lead may send `{ id }`; a worker always
passes its own id. Ack only once you have actually **handled** the message
(answered it or acted on the board), never just to clear it. The ack is the only
thing that retires a Send: skip it and the Send drains again. That is deliberate:
if you die mid-draw, the un-acked Send comes back and you redraw safely, because
`/exec` is idempotent and shape ids are deterministic. Then, with background
resume, hand the turn back: the waiter is already parked. Without it, run the
poller now (a′).

**(h) Repeat.** Each wake runs one turn, acks it (g) and relaunches the poller
where (a′) says. When one Send splits into independent pieces, spawn workers
(`references/workers.md`) and keep supervising.

**Stay connected; never hang up on your own judgment.** Delivery is pull-only, so
ceasing to listen and hanging up are the same act. The lead never stops the
poller and never tears down on its own. With background resume, staying
connected does not block the conversation: you can ask the user something and
keep the line open at once. Without it, ask through `/agent-message` so the
question reaches the panel while you listen. When the work looks done, ask "are
we done, can I disconnect?" and keep listening. Silence keeps the line open. The
only closes are the user's explicit teardown (section 6) or a forced session end.

When a lead is confirmed dead (no armed listener across the grace window, not
just the short gap between a wake and its relaunch), the panel shows the queued
Send as "no agent is listening" and `/canvas-status` reports `leadAlive:false`.
The durable queue carries the Send to the next lead that opens the board. Worker
revival pauses until then, since only the lead revives workers.

## 3. Workers

When a Send splits into independent pieces, or the user asks, spawn worker
subagents, each registered with a stable `clientKey` that is also its recipient
id, each given a disjoint region of the board. Workers self-park on their own
queue in the foreground rather than using the background poller, and the lead
revives a dead one by relaying the bridge's nudge verbatim. The protocol is in
`references/workers.md`; read it before you spawn the first worker.

## 4. The chat log persists

The bridge stores every user Send (`POST /message`) and every agent message
(`POST /agent-message`) as it passes, appending each to the board's
`<room>.messages.jsonl` and serving it from `GET /messages?room=<room>&since=<ts>`.
Reopening a board or reloading the panel brings the whole log back, each line
attributed to the user or the named agent that wrote it. Each Send shows its addressee and its delivery
state (queued, working, done or stalled), and the panel shows one status row per
agent. None of this changes how you speak: keep posting deliberate messages with
`/agent-message` and your `sessionId`.

## 5. Keep the loop cheap

A long run approaches the context limit. So:

- keep each turn small: the image plus a shape diff, not the whole board;
- do one thing per turn and let the user's next Send drive the next;
- after any context compaction, re-read `references/tldraw-editor-api.md` before
  the next `/exec`. The verified signatures are the first thing a compaction drops.

## 6. Teardown

Read `references/teardown.md` before you close anything. In short:

- **Only the user closes a board.** Call `POST /done` (with a JSON content-type;
  the exact call is in `references/teardown.md`) only on their explicit
  instruction to close this board: the confirm-gated teardown directive, or an
  unambiguous "we're done, you can disconnect". Nothing else authorizes it.
- **A request to move, home or switch the board's file is not a close.** Copy the
  live `.tldr` to its new place and keep the server running; to keep working on
  the copy, the user picks it in the panel's board switcher.
- **Before `/done`, run the gate:** a guest refuses and points at the owning
  session; a connected human you cannot account for means asking first.
- **On a forced session end, tear down nothing.** The server is a separate process;
  report the board name and `http://127.0.0.1:<port>` so the user can re-attach.
