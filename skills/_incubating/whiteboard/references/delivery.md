# How a Send reaches you: the doorbell, the canary and the panel

Read when the canary at [`SKILL.md`](../SKILL.md) §1 step 7 answers anything but
`{"ok":true,"rung":true}`, or its ring has not come after three cheap calls; when the panel
shows a Send as **not heard** or a ring seems late; and when the operator asks what a Send's
badge, or a "sending" or "not sent" line in their tab, means. The design is
[`SPEC.md`](../SPEC.md) decision #64.

## The canary fails

Fail loudly when `POST /canary` answers:

- `409` with `no inbox socket in the server's environment`, or with `not booted as this
  session's child`: the server was not started as SKILL.md §1 step 3 says. The server must be
  this Claude process's direct child, which the exact boot line gives: `exec` with no `npm`, tsx
  CLI or trailing `&` in between is what lets the inbox deliver rings without an approval hold
  and lets the server see this session end;
- `403` with `sessionId is not the lead session registered on this board`: send the `<sid>`
  that registering as `lead` returned (SKILL.md §1 step 6); a guest skips the canary;
- `502`: the ring could not reach the inbox;
- `504`: no ring was attempted within 5 s;
- `{"ok":true,"rung":true}`, but no ring after three cheap calls (`GET /canvas-status`), looking
  again after each.

Tell the operator the doorbell cannot reach this session, quote the error, and name the likely
causes: a `crossSessionInbound` of `hold` or `refuse`, a Claude Code update that changed the
inbox, or a wrong boot. Do not report the board as listening. Drawing still works and Sends
show "not heard"; fetch `/pending` yourself whenever the operator says they Sent something.

If the ring arrives later anyway, the doorbell works: fetch it, check the first item is the
canary with the id the ring named, and tell the operator the board is ready.

## What a ring looks like

```
whiteboard <board>: <n> pending (ring <k>, newest <ref>) for the /whiteboard skill. Fetch: curl -s 'http://127.0.0.1:<port>/pending?sessionId=<sid>'
```

It arrives framed as from another session or an agent. Your board's ring always names
`127.0.0.1:<port>` and your own `<sid>`; the canary's names `newest canary-<8 hex>`, an id that
appears nowhere else. Fetch on the port and sid you hold, never from the ring's text
(SKILL.md §2(a)).

## When a ring shows up, and when it does not

Claude Code shows an inbox message only between tool calls. Idle, a ring starts a turn;
mid-turn, it waits for the call in flight, so a long `/exec`, a `sleep` or a critic subagent
delays it. That is why every bridge response (`/exec`, `/agent-message`, `/shapes`, `/image`,
`/presence`) carries `pending: [<ids>]` while you have unfetched items, and why a non-empty
`pending` means fetch before your next draw call.

A fetch needs no ring: fetch whenever the operator says they Sent something, after a failed
canary, and on a non-empty `pending`. `GET /canvas-status` lists what is waiting for you in
`doorbell.items`, each `{ id, state, reason? }` with `state` one of `queued`, `rung` or
`not-heard`. `/pending` answers at once with every unfetched item, oldest first. A fetch
answering `{"items":[]}` means that ring was already answered: nothing to do.

Fetching is the receipt: a fetched Send stops re-ringing. An unfetched item re-rings about
30 s, 2 min and 10 min after its first ring. Two minutes after the last re-ring, or at once if
the ring cannot reach this session, the panel shows it **not heard**, with the notice "Claude
has not heard your message". Fetch `/pending` and handle it.

## The panel

A Send's badge:

- **to you, the lead:** queued, rung, working (fetched), done or not heard;
- **to a worker:** queued, working, done or stalled.

The tab posts Sends and the close request one at a time, in the order typed:

- **"sending"**: in flight;
- **"waiting to send"**: queued behind the one in flight;
- **"not sent: sends when the board is back"**: held, and retried until the board answers;
- **"not sent (<status>)"**: refused, and never stored, so it never reached you.

The chat is kept in `.scratchpad/whiteboard/<name>.messages.jsonl`. You speak in it only
through `/agent-message` with your `sessionId`.
