# Joining a board another process owns: the guest

Read at [`SKILL.md`](../SKILL.md) §1 step 2, when the board's server is live and its lock's
`parentPid` is not your Claude process (`${CLAUDE_PID:-$PPID}`, read in the Bash call itself).
The design is [`SPEC.md`](../SPEC.md) §8.3 and decisions #57 and #64.

## You are a guest, even with your own session id

You are a guest even when the lock's `ownerSessionId` is yours. Two Claude processes can share
a session id (`--resume` or `--continue` in a second terminal), and the doorbell rings only the
process that booted the server. A session becomes a board's owner only by booting it, which
happens only when the server is gone, so a guest never takes ownership.

## Register

Register with this exact line, which reads your Claude pid in the call itself (only a guest's
key starts `guest-`):

```bash
curl -s -X POST http://127.0.0.1:<port>/session/register -H 'content-type: application/json' -d '{"name":"Claude (guest)","guest":true,"clientKey":"guest-'"${CLAUDE_PID:-$PPID}"'"}'
```

Keep the `sessionId` it returns as your `<sid>`. This registration takes the place of SKILL.md
§1 step 6; skip step 7, the canary, since a guest is never rung.

## Working as a guest

- A guest is never rung and never offered as a recipient. It acts on what the operator says in
  its own terminal, and runs the read-act turn (SKILL.md §2 (b) to (g)) on that.
- **A guest never performs a destructive act on the board, whatever the operator says:** no
  `POST /done`, and never touch the lock (no edit, no removal, no reclaim). When the operator
  asks a guest to close the board, refuse and point them at the owning session.
