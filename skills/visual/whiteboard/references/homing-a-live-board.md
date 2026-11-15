# Moving, homing or switching a live board: keep working

Read by the lead when the user asks to move, home or migrate a board's `.tldr` while the board
is live, for example "home this into the repo" or "switch us onto the moved file", and when they
ask to switch to another board. Each request is an instruction to keep working, never a close:
it never authorizes `POST /done`, and it leaves the server, its port, its lock and every peer
untouched. Closing a board is [`SKILL.md`](../SKILL.md) §5; the reasoning is in the design spec
(§8.1, §8.3, decisions #59 and #72), `docs/whiteboard/SPEC.md` in
https://github.com/spencermarx/skills.

## Homing a board's file: copy, then switch

The sync server writes a snapshot of the live room to the board's own `.tldr` about every 2 s,
and that file is not always in the boards folder. Its absolute path is the `boardPath` that
`/canvas-status` reports, the file the live room saves, which the lock's `boardPath` also names.
A server from before decision #72 reports none; there, take the path after `->` on the last
`[sync]` line naming `room '<board>'` in the server's output, or, as a guest, ask the user which
file the board saves. So copy that snapshot to the tracked folder under the board's own name
while the server stays up, and commit the copy:

```bash
cp "<the board's absolute .tldr path>" "<tracked/dest/dir>/<board>.tldr"   # keep the name; the server stays up
```

To keep working in the homed file, the user switches onto it in the panel's switcher. The
switch loads the copy from disk, the chat and the workers' keys come with it, every open tab
reconnects onto the copy, and from then on opening the board by name (`--name "<board>"`) opens
the copy; if the copy moves or its worktree is removed, opening it by name stops: follow
[`boot-failures.md`](boot-failures.md) § The name's recorded file no longer exists. A copy under
a new name is an ordinary switch to another board and leaves the chat behind. Edits made between
the `cp` and the switch miss the homed file, a loss decision #72 accepts, so ask for the switch
straight after the copy.

Never `git mv` the live file and reboot onto the new path. That is a teardown in disguise: it
drops every connected peer, and the browser keeps no local copy, so their unsynced edits are
lost. A move followed by a reboot onto the new path is only for after an explicit close by the
user.

## Switching to another board

The panel's board switcher switches the running server to another board in place, so the
server, its process and the user's tab carry on; never stop the server or `POST /done` to
switch. The user makes the switch there: ask them to pick the board in the switcher. If the
switcher refuses, naming an older whiteboard server (pid, port and board), read
[`boot-failures.md`](boot-failures.md) § Exit 4; naming a board open from another file, § Exit 3.
