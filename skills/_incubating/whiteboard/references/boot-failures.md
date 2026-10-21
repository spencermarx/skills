# When the boot does not go straight to `listening on`

A job that exits after `listening on` is not a boot failure: the board is down, and its
snapshot and port are on disk. Read [`interrupted-work.md`](interrupted-work.md) § The session
ended instead.

Read at [`SKILL.md`](../SKILL.md) §1 step 3, when the server job exits, or logs a line with
`waiting up to` or `is taken` before `[bridge] listening on http://127.0.0.1:<port>`; and when
the panel's board switcher refuses a switch naming a server from before decision #64. Find the
line below and do what it says. The design is [`SPEC.md`](../SPEC.md) §8.3 and decisions #64
and #65.

The server takes the port recorded in `<name>.port` (a fresh one for a new board), and writes
`<name>.lock` and `<name>.port` itself. Before it claims the board it waits out a board being
released and refuses a board another server holds, which is what the lines below report.

## A waiting line: keep reading

Either of these means the boot is still working. Keep reading the job's output for
`listening on`:

- `[bridge] board '<room>' is being released by pid <pid>; waiting up to <n> s`
- `[bridge] board '<room>' is held by pid <pid>, which is not answering; waiting up to <n> s`

## The recorded port is taken

`port <n> is taken; falling back to an ephemeral port` still boots, on a new port, so the
operator's old tab cannot reconnect and §1 step 5 opens a new one. Tell the operator to close
the old tab, and to Send again from the new tab anything the old one shows as **not sent**:
those lines never reached this board.

## Exit 1: the boot line was wrong

The server exits 1 unless `WHITEBOARD_BOARD` is an absolute path ending in `.tldr` whose
directory exists, logging `[bridge] WHITEBOARD_BOARD must be the board's absolute .tldr path
(got <value>)`; an unfilled `<…>` placeholder reaches it as literal text. `npm start` also
exits 1, by design. Fix the path and run SKILL.md §1 step 3's command exactly as written.

## Exit 3: another server has the board

Its `[bridge] board … not starting a second server` line says why:

- **"already served"**: return to SKILL.md §1 step 2 once, which re-reads the lock and attaches
  (not a retry of the boot). After a second exit 3, report and stop.
- **"still being released"** or **"which does not answer"**: the server already waited, so
  report the line and do not retry. For "which does not answer", add what
  `ps -p <pid> -o comm=` shows, so the operator sees what that pid is.

## Exit 4: a server from before decision #64 is running

The line reads `[bridge] board server from before #64 running: pid <pid> on port <port>, board
'<board>'; …` and names every such server, on any board. Such a server never exits with its
session and may ignore SIGTERM, and no board boots while one runs.

Stopping it is the operator's call:

1. Tell them each pid, port and board, and what `ps -p <pid> -o comm=` shows.
2. On their go-ahead, `kill <pid>`, then `kill -9 <pid>` if it is alive 5 s later, then run
   SKILL.md §1 step 3 again.
3. If they decline, neither boot nor attach, and tell them why: while it runs, it can save
   over a board a new server holds.

The panel's switcher refuses a board switch while such a server runs, naming the same pid,
port and board. If the operator asks you to stop that server, follow the steps above.
