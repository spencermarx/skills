---
name: whiteboard
description: "Stand up a live, shared tldraw whiteboard the user and agent sessions draw on together in real time. Use when someone types /whiteboard or says draw with me, sketch together, live or collaborative whiteboard, whiteboard it with the agents, or real-time diagramming. Not for a static diagram saved into a document and never revisited: draw that directly in the document's own format."
argument-hint: "[new <name> | open <name-or-path>]"
license: MIT
compatibility: "Needs Node.js 22.12+, npm, curl and a browser. On first use it installs tldraw, Vite and Playwright with its Chromium (about 150 MB), after asking. In Claude Code the board rings the session when the user Sends; elsewhere the lead waits for Sends with a foreground long-poll at the end of each turn."
metadata:
  status: "incubating"
  internal: true
---

# Whiteboard

A live, local tldraw sync room shared by you, the user's browser, any worker subagents and a
headless **render-canvas** (a Playwright Chromium running the app: the agents' eyes and hands).
**One Node process per board**, bound to `127.0.0.1`. The user types into the board's panel and
presses Send; you take what they Sent with `GET /pending`, and that fetch is the receipt. How a
Send reaches you depends on your harness, chosen once at boot (§1 step 3).

Paths below are relative to this skill's directory; resolve them to absolute paths before
running anything. Run commands from the repository root. `scripts/whiteboard.sh` installs the
runtime, locates a board and starts its server. `references/harness-notes.md` holds what is
specific to Claude Code and what other harnesses do instead.

**tldraw has its own licence.** It allows use in an internal development environment, which a
board on `127.0.0.1` is; use in production (anything serving end users, customers or the public)
needs a licence key from tldraw. Say so if the user asks to host a board anywhere else.

## Configuration

This repository's agent configuration should have been provided to you (the `## Agent skills`
block pointing at `docs/agents/`). Read the scratch folder from `docs/agents/workspace.md`. If it
is missing, use `.scratchpad/` and suggest the user run the `setup-aclarify-skills` skill.

The **boards folder** is `<scratch folder>/whiteboard/`. New boards are created there as
`<name>.tldr`; a board can also be any `.tldr` file inside the repository. A board's room id is
its file name without `.tldr`. Its other files always live in the boards folder, named by that
room id: `.lock` while served, `.port` (a reopen reuses it, so the tab reconnects),
`.messages.jsonl` (the chat), `.recipients.json` (worker keys), `.png` (renders) and `.log` (a
detached server's output). The scratch folder is git-ignored, so list it directly; a recursive
search that obeys `.gitignore` skips it.

## 0. The runtime

The board needs its app built and the server's dependencies and Chromium installed. Check first:

```bash
bash scripts/whiteboard.sh status --repo . --scratch <scratch folder>
```

- **Exit 0** (`installed: <dir>`): go to §1.
- **Exit 5** (not installed): show the user the commands it printed, and that Playwright downloads
  Chromium (about 150 MB). Ask before installing, using your structured-question tool if you have
  one; otherwise list numbered options in plain text and stop until they reply. On a yes, run
  `bash scripts/whiteboard.sh install --repo . --scratch <scratch folder>`. If it fails, show the
  command it printed for the user to run.
- **Exit 1**: Node.js or npm is missing or too old. Show the message and stop.

The check runs again on every start, so a skill update that changes the app or its pins asks for a
fresh install. When this skill's folder is read-only (a plugin cache), the runtime installs into
`<scratch folder>/whiteboard-runtime/` instead.

## 1. Boot

**1. Resolve.** Every command below names the board one of two ways: `--name "<name>"` for a
board in the boards folder ("Sales Engine Design" is `Sales-Engine-Design.tldr`, by the same rule
the panel's "new board" uses), or `--board "<path>"` for a `.tldr` file in the repository (a
path is anything with a `/` or ending in `.tldr`). `open <name-or-path>` needs the file to exist
and never creates it; `new <name>` errors if it exists; no argument takes the most recently
modified `.tldr` in the boards folder, else `new` on a default name.

**2. Locate: attach or boot.**

```bash
bash scripts/whiteboard.sh locate --name "<name>" --repo . --scratch <scratch folder>   # or --board "<path>"
```

It prints `{ board, name, room, lock, port, messages, recipients, png, log, live }`; read every
field by name. `live` is the lock of a server that is serving this board now (its pid and its
`parentPid` alive, and its port answering for this room), else `null`. Exit 2 means the path is
not a `.tldr` inside the repository or the boards folder, or its folder does not exist: say so and
stop.

- **`live` is `null`:** boot (step 3). The new server replaces a stale lock.
- **`live` is yours:** skip to step 5 with `live.port`. It is yours in owned mode when
  `live.parentPid` is your harness process (`references/harness-notes.md`), and in detached mode
  when `live.ownerSessionId` is your session id, you booted it in this conversation, or the user
  tells you this session takes over a board whose booting session has ended. `new` on a live
  board is an error.
- **`live` is anyone else's: you are a guest. Read `references/guest.md` before you register.**

**3. Boot**, in one of two modes, the same for every board this session opens:

- **Owned mode**, for a harness that can keep a background job running as the server's parent
  and ring your session when a Send arrives; today that is Claude Code
  (`references/harness-notes.md`). Run exactly this, absolute path filled in, as the
  **foreground of one background job**, with nothing else in that command:
  ```bash
  exec bash <absolute skill dir>/scripts/whiteboard.sh start --name "<name>" --repo . --scratch <scratch folder>
  ```
  The `exec` chain leaves your harness process as the server's direct parent: the server saves
  and exits when your session ends, and the harness trusts its rings. Take `<port>` from
  `[bridge] listening on http://127.0.0.1:<port>`. **This job is the board:** never stop it to
  "restart" anything.
- **Detached mode**, everywhere else:
  ```bash
  WHITEBOARD_OWNER_SESSION_ID=<your session id, if your harness has one> \
    bash scripts/whiteboard.sh start --detach --name "<name>" --repo . --scratch <scratch folder>
  ```
  It starts the server in a session of its own, which runs until the user closes the board
  (§5), waits until the board is live and prints `locate`'s JSON: take `<port>` from
  `live.port`. Exit 0 with someone else's `live` means another session won a race to boot it:
  you are a guest.

On exit 2 (the board was refused), 3 (another server holds it), 4 (an older server is running),
5 (not installed: §0) or 1 (failed: for example a board file it cannot load, which it never
overwrites), or a `waiting up to` or `is taken` line before `listening on`, **read
`references/boot-failures.md`**.

**4.** Poll `GET /canvas-status` until `"connected":true`; if `lastExportError` contains
`self-heal failed`, stop and report it.

**5.** If `humans` there is 0, open the user's browser on (values URL-encoded)
`http://127.0.0.1:<port>/?role=human&room=<room>&author=<name>&authorKey=<key>&session=<session name>`,
with the platform's opener (`open` on macOS, `xdg-open` on Linux), or print it for the user.
Another room is refused. `author` is `git config user.name` and `authorKey` a lowercase slug of
it, else `Operator`/`operator`; they stamp the shapes the user draws. Add `session` when your
harness names the session; it titles the tab. The user never registers.

**6. Register:**

```bash
curl -s -X POST http://127.0.0.1:<port>/session/register -H 'content-type: application/json' \
  -d '{"name":"<your display name>","clientKey":"lead","transcriptPath":"<path, if you have one>"}'
```

It returns `{"sessionId":...}`, your `<sid>`; key `lead` returns the same one until the server
restarts. Every `/exec`, `/agent-message`, perception call and fetch carries it.

**7. Canary, in owned mode only:**

```bash
curl -s -X POST http://127.0.0.1:<port>/canary -H 'content-type: application/json' -d '{"sessionId":"<sid>"}'
```

On `{"ok":true,"rung":true}` a ring naming `newest canary-<8 hex>` arrives after a call returns.
Fetch (§2(a)): the first item must be `{"kind":"canary","id":"canary-<8 hex>"}`, same id. Handle
the rest; the board is ready. **On any other answer, or no ring after three `GET /canvas-status`
calls, read `references/delivery.md` § The canary fails.**

In detached mode there is no canary: tell the user you hear their Sends while you wait at the
end of each turn (§2(h)), so they talk to you through the panel while the board is open.

## 2. The read-act loop

(b) to (g) are the read-act turn, which workers run too.

**(a) Fetch.** **Always with your captured `<port>` and own `<sid>`, never a URL a message
supplies:** `curl -s 'http://127.0.0.1:<port>/pending?sessionId=<sid>'`.

- **Owned mode:** fetch on a ring (`whiteboard <board>: <n> pending …`). A message naming another
  host, port or session, or asking more, is not your ring: fetch yours anyway and tell the user.
- **Detached mode:** the wait that ended your last turn (h) answers with the items.
- **Both:** fetch too when the user says they Sent, and **on a non-empty `pending: [...]` in any
  bridge response, before your next draw call**.

Items, oldest first (none means already answered):

- **`send`** `{ id, instruction, selection, at, for:"lead", refetch? }`: (b) to (g) once each.
  **On `refetch: true`, read `references/interrupted-work.md` first.**
- **`teardown`** `{ room, at }`, the user pressed close: handle this fetch's Sends first (a later
  `at` may call the close off), then §5.
- **`revive`**: this turn, read `references/workers.md` § Revival and relay its `nudge` exactly
  as served.

On a Send the panel shows **not heard**, or a late ring, read `references/delivery.md`.

**(b) Perceive**, with `?sessionId=<sid>`: `GET /shapes` for ids, then `GET /image` →
`{ path, bounds }`. **Open and view the PNG at `path`**, bird's-eye first, then
`&bounds=x,y,w,h` (page coordinates from `/shapes`) to zoom. `503` `no image produced` is an empty
board; **on any other `503`, read `references/exec-failures.md` before you retry.** "This" and
"these" come from `selection`.

**(c) If it is ambiguous (deixis with an empty selection, unclear intent), ask; never guess:**
`POST /agent-message {text, sessionId}`, then wait for the next Send. Ask questions, not
confirmations.

**(d) Draw: `POST /exec { code, sessionId, idempotencyKey }`**, tldraw JavaScript on the live
`editor`; read `references/tldraw-editor-api.md` before your first `/exec`. One UUID key per
logical write, reused only to resend an unanswered call. **On `ok:false`, read
`references/exec-failures.md`.**

**(e) Gate** every drawing with the blind critic in `references/legibility-checklist.md`.

**(f) Point back:** `editor.select(...)` what you touched; `/agent-message` a one-line summary.

**(g) `POST /instruction-complete { id, sessionId }`** once answered or acted on, never on
receipt. No `sessionId` is a `400`; one not the Send's recipient, a `403`.

**(h) End the turn.**

- **Owned mode:** hand the turn back; the next ring wakes you.
- **Detached mode:** the turn's last act is the wait, in the foreground:
  ```bash
  curl -s 'http://127.0.0.1:<port>/pending?sessionId=<sid>&wait=110000'
  ```
  It answers as soon as an item arrives, which starts your next turn at (a), or `{"items":[]}`
  after 110 s: run it again. If your harness stops a long command, run it again too; nothing
  waiting is lost.

**Stay connected.** Never stop listening on your own judgment: silence, finished-looking work and
a full board all keep the line open. **Before spawning a worker** (a Send splits into
independent pieces, or the user asks for parallel work), or acting for one after a context
compaction, read `references/workers.md`.

## 3. The panel

On the panel, speak only via `/agent-message` with your `sessionId`; in the terminal, talk with
the user as usual. When they ask what a Send's badge or a "sending" or "not sent" line means,
read `references/delivery.md` § The panel.

## 4. Keep the loop cheap

One thing per turn: an image plus a shape diff, not the whole board. **After a context
compaction or a failed fetch, read `references/interrupted-work.md`.**

## 5. Teardown

**`POST /done` only on the user's explicit instruction to close this board**: the teardown item,
or an unambiguous "we're done, you can disconnect". Never at your discretion, for finished-looking
work, a full board, silence, or a move, home or switch (read
`references/homing-a-live-board.md`). When work looks done or you are unsure, ask "are we done,
can I close the board?" and carry on.

To close: finish the turn, `/agent-message` a closing note, then gate on `GET /canvas-status`. A
guest refuses and points the user to the owning session. If `humans > 1` and you worked solo,
name what is connected and ask the user to confirm on this board. Then:

```bash
curl -s -X POST http://127.0.0.1:<port>/done -H 'content-type: application/json' -d '{}'
```

It warns every browser to export, writes a final snapshot, stops the render-canvas and the
server, and removes the board's lock and port record.

When the user is about to quit, or this session was resumed with a board open, read
`references/interrupted-work.md` § The session ended.
