# When the boot does not go straight to `listening on`

A server that exits after `listening on` is not a boot failure: the board is down, and its
snapshot and port are on disk. Read [`interrupted-work.md`](interrupted-work.md) § The session
ended instead.

Read at [`SKILL.md`](../SKILL.md) §1 step 3, when `whiteboard.sh start` exits non-zero, or the
server logs a line with `waiting up to` or `is taken` before `[bridge] listening on
http://127.0.0.1:<port>`; and when the panel's board switcher refuses a switch naming an older
whiteboard server. Find the line below and do what it says. In owned mode the lines are the
job's output; in detached mode they are in the board's `.log`, and `start --detach` prints its
end when the server exits. The design spec (§8.3) is `docs/whiteboard/SPEC.md` in
https://github.com/spencermarx/skills.

The server takes the port recorded in `<room>.port` (a fresh one for a new board), and writes
`<room>.lock` and `<room>.port` itself. Before it claims the board it waits out a board being
released and refuses a board another server holds, which is what the lines below report.

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
path and run SKILL.md §1 step 2 again.

## Exit 3: another server has the board

Its `[bridge] board … not starting a second server` line says why:

- **"already served"**: return to SKILL.md §1 step 2 once, which re-reads the lock and attaches
  (not a retry of the boot). After a second exit 3, report and stop.
- **"still being released"** or **"which does not answer"**: the server already waited, so
  report the line and do not retry. For "which does not answer", add what
  `ps -p <pid> -o comm=` shows, so the user sees what that pid is.

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
