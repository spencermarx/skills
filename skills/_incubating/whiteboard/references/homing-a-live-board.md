# Moving, homing or switching a live board: keep working

Read by the lead when the operator asks to move, home or migrate a board's `.tldr` while the
board is live, for example "home this into the repo" or "switch us onto the moved file", and
when they ask to switch to another board. Each request is an instruction to keep working,
never a close: it never authorizes `POST /done`, and it leaves the server, its port, its lock
and every peer untouched. Closing a board is [`SKILL.md`](../SKILL.md) §5; the reasoning is
[`SPEC.md`](../SPEC.md) §8.1, §8.3 and decision #59.

## Homing a board's file: copy, then switch

The sync server writes a snapshot of the live room to `.scratchpad/whiteboard/<name>.tldr`
about every 2 s. So copy that snapshot to the tracked path while the server stays up, and
commit the copy:

```bash
cp .scratchpad/whiteboard/<name>.tldr <tracked/dest/path>.tldr   # the server stays up
```

Never `git mv` the live file and reboot onto the new path. That is a teardown in disguise:
it drops every connected peer, and the browser keeps no local copy, so their unsynced edits
are lost. A move followed by a reboot onto the new path is only for after an explicit
operator close.

## Switching to another board

The panel's board switcher switches the running server to another board in place, so the
server, the job and the operator's tab carry on; never stop the job or `POST /done` to switch.
The operator makes the switch there: ask them to pick the board in the switcher.
If the switcher refuses, naming a server from before decision #64 (pid, port and board), read
[`boot-failures.md`](boot-failures.md) § Exit 4.
