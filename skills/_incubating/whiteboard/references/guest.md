# Joining a board another session owns: the guest

Read at [`SKILL.md`](../SKILL.md) §1 step 2, when `locate` shows a live server that is not
yours, and at step 3 when a detached start prints someone else's `live`. The design spec
(§8.3) is `docs/whiteboard/SPEC.md` in https://github.com/spencermarx/skills.

## Booting is what makes an owner

A session owns a board only by booting it, which happens only when no server serves it, so a
guest never takes ownership. Sharing a session id is not enough: in Claude Code two processes
can share one (a resumed session in a second terminal), and the board rings only the process
that booted it (`harness-notes.md`). The one exception is detached mode, where the user can hand
a board whose booting session has ended to this session (SKILL.md §1 step 2); then you are its
lead, not a guest.

## Register

Register as a guest instead of SKILL.md §1 step 6. Only a guest's key starts `guest-`; fill in
`<id>` with an id stable for this session and unique to it (in Claude Code, the one
`harness-notes.md` gives; elsewhere a short random id you pick once and reuse). The server refuses
a key holding `$`, `{` or `}`, so substitute it before sending:

```bash
curl -s -X POST http://127.0.0.1:<port>/session/register -H 'content-type: application/json' -d '{"name":"<your display name> (guest)","guest":true,"clientKey":"guest-<id>"}'
```

Keep the `sessionId` it returns as your `<sid>`. Skip step 7, the canary, and §2(h)'s wait: a
guest is never rung, and `/pending` serves only the lead.

## Working as a guest

- A guest is never rung and never offered as a recipient. It acts on what the user says in its
  own terminal, and runs the read-act turn (SKILL.md §2 (b) to (g)) on that.
- **A guest never performs a destructive act on the board, whatever the user says:** no
  `POST /done`, and never touch the lock (no edit, no removal, no reclaim). When the user asks a
  guest to close the board, refuse and point them at the owning session.
