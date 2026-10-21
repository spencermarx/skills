# Moving, homing or switching a live board: keep working

Read by the lead when the user asks to move, home or migrate a board's `.tldr` while the board
is live, for example "home this into the repo" or "switch us onto the moved file", and when they
ask to switch to another board. Each request is an instruction to keep working, never a close:
it never authorizes `POST /done`, and it leaves the server, its port, its lock and every peer
untouched. Closing a board is [`SKILL.md`](../SKILL.md) §5; the reasoning is in the design spec
(§8.1, §8.3), `docs/whiteboard/SPEC.md` in https://github.com/spencermarx/skills.

## Homing a board's file: copy, then switch

The sync server writes a snapshot of the live room to the board's `.tldr` (the `board` path
`whiteboard.sh locate` prints) about every 2 s. So copy that snapshot to the tracked path while
the server stays up, and commit the copy:

```bash
cp <board path> <tracked/dest/path>.tldr   # the server stays up
```

Never `git mv` the live file and reboot onto the new path. That is a teardown in disguise: it
drops every connected peer, and the browser keeps no local copy, so their unsynced edits are
lost. A move followed by a reboot onto the new path is only for after an explicit close by the
user.

## Switching to another board

The panel's board switcher switches the running server to another board in place, so the
server, its process and the user's tab carry on; never stop the server or `POST /done` to
switch. The user makes the switch there: ask them to pick the board in the switcher. If the
switcher refuses, naming an older whiteboard server (pid, port and board), read
[`boot-failures.md`](boot-failures.md) § Exit 4.
