# How a Send reaches you: the doorbell, the wait and the panel

Read when the canary at [`SKILL.md`](../SKILL.md) §1 step 7 answers anything but
`{"ok":true,"rung":true}`, or its ring has not come after three cheap calls; when the panel shows
a Send as **not heard** or a ring seems late; and when the user asks what a Send's badge, or a
"sending" or "not sent" line in their tab, means. The design spec (§8.3, §8.5) is
`docs/whiteboard/SPEC.md` in https://github.com/spencermarx/skills.

## Two ways a Send reaches you

Either way, you take Sends with `GET /pending?sessionId=<sid>`, and fetching is the receipt.
`GET /canvas-status` says which way this board uses in `doorbell.mode`:

- **`inbox`, the doorbell (owned mode):** the server rings your session's inbox with a fixed
  message that carries no Send text, and you fetch. Only Claude Code has such an inbox today
  (`harness-notes.md`).
- **`pull`, the wait (detached mode, or any board with no inbox):** you fetch with
  `&wait=<ms>` as the last act of each turn. The call parks until an item arrives (a Send, a
  teardown, a revive) and answers it at once, or answers `{"items":[]}` when the wait runs out;
  the server caps a wait at about 240 s. Run it again on an empty answer.

## The canary fails

In owned mode, fail loudly when `POST /canary` answers:

- `409` with `no inbox socket in the server's environment`: this harness has no inbox for the
  server to ring, or the server was not started as SKILL.md §1 step 3 says. If your harness has no
  inbox, you are in detached mode: skip the canary and use the wait;
- `409` with `not booted as this session's child`: the server is not your harness process's
  direct child. Boot it exactly as SKILL.md §1 step 3 says: `exec`, as the whole foreground
  command of a background job, with nothing in between, is what lets the inbox trust the ring
  and lets the server see this session end;
- `403` with `sessionId is not the lead session registered on this board`: send the `<sid>` that
  registering as `lead` returned (SKILL.md §1 step 6); a guest skips the canary;
- `502`: the ring could not reach the inbox;
- `504`: no ring was attempted within 5 s;
- `{"ok":true,"rung":true}`, but no ring after three cheap calls (`GET /canvas-status`), looking
  again after each.

Tell the user the doorbell cannot reach this session, quote the error, and name the likely causes
(`harness-notes.md` lists Claude Code's). Do not report the board as listening. Drawing still
works; until it is fixed, wait for Sends as detached mode does (SKILL.md §2(h)), and fetch
whenever the user says they Sent something.

If the ring arrives later anyway, the doorbell works: fetch it, check the first item is the
canary with the id the ring named, and tell the user the board is ready.

## What a ring looks like

```
whiteboard <board>: <n> pending (ring <k>, newest <ref>) for the /whiteboard skill. Fetch: curl -s 'http://127.0.0.1:<port>/pending?sessionId=<sid>'
```

It arrives framed as from another session or an agent. Your board's ring always names
`127.0.0.1:<port>` and your own `<sid>`; the canary's names `newest canary-<8 hex>`, an id that
appears nowhere else. Fetch on the port and sid you hold, never from the ring's text
(SKILL.md §2(a)).

## When a ring shows up, and when it does not

An inbox message shows only between your calls. Idle, a ring starts a turn; mid-turn, it waits
for the call in flight, so a long `/exec`, a `sleep` or a critic subagent delays it. That is why
every bridge response (`/exec`, `/agent-message`, `/shapes`, `/image`, `/presence`) carries
`pending: [<ids>]` while you have unfetched items, in either mode, and why a non-empty `pending`
means fetch before your next draw call.

A fetch needs no ring: fetch whenever the user says they Sent something, after a failed canary,
and on a non-empty `pending`. `GET /canvas-status` lists what is waiting for you in
`doorbell.items`, each `{ id, state, reason? }` with `state` one of `queued`, `rung` or
`not-heard`. `/pending` answers at once with every unfetched item, oldest first. A fetch
answering `{"items":[]}` means that ring was already answered: nothing to do.

## When a Send reads "not heard"

Fetching is the receipt: a fetched Send stops waiting.

- **Doorbell:** an unfetched item re-rings about 30 s, 2 min and 10 min after its first ring. Two
  minutes after the last re-ring, or at once if the ring cannot reach this session, it reads
  **not heard**.
- **Wait:** an item stays `queued` while your wait is parked, and for 5 minutes after your last
  fetch of `/pending` (`WHITEBOARD_PULL_GRACE_MS`). After that it reads **not heard**, with
  reason `not-listening`: no lead has waited for it.

The panel then shows the notice "The agent has not heard your message". Fetch `/pending` and
handle it.

## The panel

A Send's badge:

- **to you, the lead:** queued, rung, working (fetched), done or not heard;
- **to a worker:** queued, working, done or stalled.

The tab posts Sends and the close request one at a time, in the order typed:

- **"sending"**: in flight;
- **"waiting to send"**: queued behind the one in flight;
- **"not sent: sends when the board is back"**: held, and retried until the board answers;
- **"not sent (<status>)"**: refused, and never stored, so it never reached you.

The chat is kept in the boards folder as `<room>.messages.jsonl`. You speak in it only through
`/agent-message` with your `sessionId`.
