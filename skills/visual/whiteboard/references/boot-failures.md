# When the boot does not go straight to `listening on`

A server that exits after `listening on` is not a boot failure: the board is down, and its
snapshot and port are on disk. Read [`interrupted-work.md`](interrupted-work.md) § The session
ended instead.

Read at [`SKILL.md`](../SKILL.md) §1 step 3, when `whiteboard.sh start` exits non-zero, or the
server logs a line with `waiting up to` or `is taken` before `[bridge] listening on
http://127.0.0.1:<port>`; and when the panel's board switcher refuses a switch naming an older
whiteboard server, a board open from another file, or a name whose recorded file no longer
exists. At §1 step 2, a `locate` whose `otherFile` is `true` is § Exit 3's "is open from another
file", and an exit 2 saying `which no longer exists` is § The name's recorded file no longer
exists. Find the line below and do what it says. In owned mode the lines are the job's output; in
detached mode they are in the board's `.log`, and `start --detach` prints its end when the server
exits. The design spec (§8.3, decisions #64, #65, #71 and #72) is `docs/whiteboard/SPEC.md` in
https://github.com/spencermarx/skills.

The server takes the port recorded in `<room>.port`, or a fresh one for a new board, when the
record holds no port (after the board was closed), or when it names another file of the same
name, and writes `<room>.lock` and `<room>.port` itself. Before it claims the board it waits out
a board being released and refuses a board another server holds, which is what the lines below
report.

## A waiting line: keep reading

Either of these means the boot is still working. Keep reading the output for `listening on`
(`start --detach` does this for you, for up to 60 s):

- `[bridge] board '<room>' is being released by pid <pid>; waiting up to <n> s`
- `[bridge] board '<room>' is held by pid <pid>, which is not answering; waiting up to <n> s`

## The recorded port is taken

`port <n> is taken; falling back to an ephemeral port` still boots, on a new port, so the user's
old tab cannot reconnect and §1 step 5 opens a new one. Tell the user to close the old tab, and
to Send again from the new tab anything the old one shows as **not sent**: those lines never
reached this board.

## Exit 1: the server failed

The line says why. Most often the board's file is one it cannot load (not JSON, or not a board
this app saves, such as an export from tldraw.com). The server refuses it rather than start empty
and save over it, so the file is untouched: tell the user what the line says and stop. `npm
start` in the server folder also refuses, by design: boards start only through `whiteboard.sh`.

## Exit 2: the board was refused

A board is an absolute `.tldr` path inside the repository or the boards folder, in a folder that
exists. `whiteboard.sh` checks this before it starts anything, and the server again at boot; the
line names what failed. An unfilled `<…>` placeholder reaches it as literal text. Fix the name or
path and run SKILL.md §1 step 2 again. A line saying `which no longer exists` is a name whose
recorded file is gone: follow § The name's recorded file no longer exists.

## Exit 3: another server has the board's name

Its line (`[bridge] board …`, or `boards.mjs: board …` when `whiteboard.sh` refused first) says
why:

- **"already served"** or **"already live"**: return to SKILL.md §1 step 2 once, which re-reads
  the lock and attaches (not a retry of the boot). After a second exit 3, report and stop.
- **"is open from another file"**: the full line is `board '<name>' is open from another file:
  <owner's path> (pid <pid>, port <port>); not serving <your path>. Close it there, or open that
  file.` A live server holds a different `.tldr` with this board's name, often the same board's
  copy in another checkout, since every checkout shares one boards folder and so one lock per
  name. Neither retry nor attach: tell the user both paths, and that they can close the board
  where it is open, or open that file instead. The panel's switcher refuses a switch with the
  same text.
- **"still being released"** or **"which does not answer"**: the server already waited, so
  report the line and do not retry. For "which does not answer", add what
  `ps -p <pid> -o comm=` shows, so the user sees what that pid is.

## The name's recorded file no longer exists

The line reads `board '<name>' is recorded at <boardPath>, which no longer exists; see
boot-failures.md § "The name's recorded file no longer exists".` `whiteboard.sh locate` and
`start` exit 2 with it, before anything is created, and the panel's switcher refuses a new board
of that name with `409` and the same text. The record is left as it is.

`<name>.port` names the file the board was last saved to, and is the only pointer to it. That
file is gone, usually a tracked copy whose worktree was removed or whose branch the checkout has
left. The boards folder's `<name>.tldr` is the copy the board left when it moved: never open it
unless the user explicitly chooses it. Neither retry nor start by name. Instead:

1. Find where the board now lives: once its worktree is merged and removed, the same path
   relative to the main checkout; otherwise ask the user.
2. Open it there by its path (`--board "<absolute path>"`). It reopens with an empty
   conversation, because its chat and workers' keys stay stamped to the old path (decision
   #72(4)), so no open Send is rung again; tell the user. Its port record then names the new
   path, so the name opens it from then on.
3. To reuse the name for a fresh board instead, remove `<name>.port` only after the user
   confirms. The name then means the boards folder's `<name>.tldr` again, which `new <name>`
   creates only if no copy is left there.

## Exit 4: an older whiteboard server is running

The line names an older whiteboard server (no `parentPid` in its lock), with the pid, port and
board of every such server, on any board. Such a server never exits with its session and may
ignore SIGTERM, and no board boots while one runs.

Stopping it is the user's call:

1. Tell them each pid, port and board, and what `ps -p <pid> -o comm=` shows.
2. On their go-ahead, `kill <pid>`, then `kill -9 <pid>` if it is alive 5 s later, then run
   SKILL.md §1 step 3 again.
3. If they decline, neither boot nor attach, and tell them why: while it runs, it can save over a
   board a new server holds.

The panel's switcher refuses a board switch while such a server runs, naming the same pid, port
and board. If the user asks you to stop that server, follow the steps above.

## Exit 5: the runtime is not installed

Go back to SKILL.md §0.
