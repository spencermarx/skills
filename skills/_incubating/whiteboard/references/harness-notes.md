# Harness notes

[`SKILL.md`](../SKILL.md) is written for any harness, in one of two modes chosen at boot (§1
step 3). **Owned mode** needs two things from the harness: a background job that keeps running
as the server's parent, and an inbox the server can ring when a Send arrives. Claude Code has
both, and owned mode was built and verified there. **Detached mode** needs neither. A harness that
runs background jobs but has no inbox uses detached mode. This file says what is specific to
Claude Code, then what other harnesses do instead.

## Claude Code

### Booting as the session's child

Run SKILL.md §1 step 3's owned command in one shell call with background execution turned on
(the shell call's `run_in_background` option). Claude Code runs that command in a shell that is
the Claude process's direct child; `exec` replaces the shell with `whiteboard.sh`, which `exec`s
`node`, so the server's parent is the Claude process, with nothing between. Nothing else may be in
that command: an `npm`, the tsx CLI, a trailing `&` or a pipeline puts a process between them, and
then the canary answers `409` `not booted as this session's child`.

Two things follow from being the direct child:

- **The board lives as long as the session.** The server records its parent pid (the lock's
  `parentPid`) and checks it every 2 s. When the Claude process ends, the server saves its
  snapshot, removes its lock and exits, keeping `<room>.port`. Every one of these is such an end:
  `/exit`, a kill, a crash, `--resume`, `--continue` or an update respawn (each starts a new
  Claude process), and a `/tasks` stop of the board's job.
- **The inbox trusts the ring.** A ring from the session's own child is delivered without an
  approval hold.

### The inbox and the canary

Claude Code gives each session an inbox socket. The server inherits it from the environment as
`$CLAUDE_CODE_MESSAGING_SOCKET`, with the token `$CLAUDE_CODE_MESSAGING_TOKEN`; it reads both and
removes them from its environment, so the render-canvas Chromium never inherits them. The server
also reads `$CLAUDE_PID` and reports `ownerIsClaude` (its parent is that pid) on the lock and
`/canvas-status`.

An inbox message shows only between tool calls, so a ring waits for the call in flight. When the
canary fails (`delivery.md` § The canary fails), the likely causes are a `crossSessionInbound`
setting of `hold` or `refuse`, a Claude Code update that changed the inbox, or a boot not run as
above.

### Who is this session

| Value | Used for | Where it comes from |
|---|---|---|
| your harness process | owner or guest (SKILL.md §1 step 2) | `$CLAUDE_PID`, else `$PPID` read in the shell call itself (in a script or a subshell, `$PPID` names the wrapper). The board is yours when the lock's `parentPid` equals it. |
| owner session id | the lock's `ownerSessionId` | the server resolves it itself: `$CLAUDE_CODE_SESSION_ID`, else `id` or `sessionId` in `$CLAUDE_JOB_DIR/state.json`. A `WHITEBOARD_OWNER_SESSION_ID` passed at boot overrides it. |
| session name | the tab title (`session=`), the lock's `ownerSession` | `name` in `$CLAUDE_JOB_DIR/state.json` |
| transcript path | the lead's `transcriptPath` | `linkScanPath` in that `state.json`; else `~/.claude/projects/<launch cwd with every non-alphanumeric replaced by "-">/<session id>.jsonl`; else omit it |

A shared session id never makes you the owner. Two Claude processes can share one (`--resume`
or `--continue` in a second terminal), and the doorbell rings only the process that booted the
server, so only the `parentPid` check decides. A guest's key (`guest.md`) is `guest-` followed by
your Claude pid, expanded in the shell call itself:

```bash
P="$CLAUDE_PID"; [ -n "$P" ] || P="$PPID"
curl -s -X POST http://127.0.0.1:<port>/session/register -H 'content-type: application/json' -d '{"name":"Claude (guest)","guest":true,"clientKey":"guest-'"$P"'"}'
```

### Workers

Spawn each worker as a tracked subagent, never a background or detached one: a detached one dies
at run end and orphans its work. Revive one (`workers.md` § Revival) by sending the nudge to the
subagent with `SendMessage`, addressed by the agent id or name the spawn returned. If that fails,
spawn a fresh subagent under the same `clientKey` and name, ending its prompt with the same nudge.
The cap is 20 live subagents (`$CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). Resuming a completed
subagent takes a fresh slot without re-checking the cap, so count live subagents before you revive
one.

### Compaction and resuming

Claude Code compacts a long session automatically (around 76 to 84 percent of the context
window), and a subagent can hit its `maxTurns`. The board stays up through a compaction: read
`interrupted-work.md` § After a context compaction before the next `/exec`. A resumed session is a
new Claude process, so its board went down with the old one: `/whiteboard open <board>` boots it
again on its recorded port.

## Other harnesses

- **No inbox, no owned mode.** Start the board with `whiteboard.sh start --detach`, which turns
  off the parent watch (`WHITEBOARD_OWNER_WATCH=off`): the server runs in a session of its own
  until the user closes the board, and survives the session that started it. `/canvas-status`
  reports `detached: true`, and `doorbell.mode` reads `pull`.
- **The wait.** End every turn with SKILL.md §2(h)'s foreground wait. 110 s fits under a
  two-minute cap on a single shell command; if your harness stops commands sooner, lower `wait`
  below its cap. A stopped or timed-out wait loses nothing: run it again, and if its answer may
  have been lost, recover with `?all=1` (`interrupted-work.md`). While you wait, the user talks to
  you through the panel.
- **Who is this session.** If your harness exposes a session id, pass it at boot as
  `WHITEBOARD_OWNER_SESSION_ID`, and a session name as `WHITEBOARD_OWNER_SESSION`; a later session
  with the same id is then the owner. Without one, the board is yours when you booted it in this
  conversation, or when the user hands it to this session. A guest's key is `guest-` followed by a
  short random id you pick once and reuse. Omit `transcriptPath` unless your harness keeps a
  transcript file.
- **Workers.** If your harness has subagents, spawn workers as `workers.md` says; each one parks
  on its own queue in the foreground. If it cannot message a running subagent, every revive takes
  the fresh-spawn route. Without subagents, never spawn workers: do the pieces one after another.
- **Images.** The loop views each render (SKILL.md §2(b)). If your harness cannot open images,
  work from `/shapes` alone, and tell the user you cannot see the board, so the legibility gate is
  theirs.

## Why a doorbell, and a wait as the fallback

The poller that came before kept a background listener per lead, which had to be re-armed after
every wake and checked for being parked; a missed re-arm left Sends unheard. The doorbell keeps no
listener: the server rings, and the fetch is the receipt. Where no inbox exists, the wait does the
same job as a plain foreground call at the end of each turn, so there is nothing to re-arm. The
design spec (§8.3, §8.5) is `docs/whiteboard/SPEC.md` in https://github.com/spencermarx/skills.
