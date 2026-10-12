# Harness notes

The loop in SKILL.md is written for any harness. Three things differ between
harnesses: how the lead is woken when a Send arrives, how a session names itself,
and how a dead worker is revived. This file says what to do in Claude Code, where
the skill was built and is verified, and what to fall back to elsewhere.

## The wake: which listening mode

SKILL.md runs the lead's listener, `server/poll.sh`, in one of two modes, and
gives the loop for each (boot step 7 and step (a′)). Which one you use depends on
whether the harness resumes a session when a background job exits, handing it the
job's output: that resumption is the wake.

- **Claude Code: background resume.** Launch the poller in one shell call with
  background execution turned on (the shell call's `run_in_background` option).
  Claude Code re-invokes the session with the poller's stdout when it exits. This
  is what makes listen-while-interact work: the operator can talk to the lead in
  the terminal while the poller holds the line.
- **A harness that cannot resume a session from a background job: foreground.**
  Run the poller as an ordinary blocking shell call at the end of each turn. It
  returns only on a delivery. If the harness caps how long a shell call may run
  and stops it, run it again: a Send that arrived in between waits in the queue
  and is its first delivery.

## Who is this session

Two values identify the session that booted a board (its owner) and label its tab
and messages. Resolve each simply; an empty value is always safe.

| Value | Used for | Claude Code | Elsewhere |
|---|---|---|---|
| owner session id | the owner/guest guard (boot step 2) | `$CLAUDE_CODE_SESSION_ID`, else the `id` field of `state.json` in `$CLAUDE_JOB_DIR` when that variable is set | empty |
| session name | the browser tab title, the lock's `ownerSession` | the `name` field of `state.json` in `$CLAUDE_JOB_DIR` | empty (the tab shows "Whiteboard") |
| transcript path | message attribution, the bridge's reconciler | the `linkScanPath` field of that `state.json`; else `~/.claude/projects/<launch cwd with every non-alphanumeric replaced by "-">/<session id>.jsonl` | omit it |

```bash
JOBSTATE=""; [ -n "$CLAUDE_JOB_DIR" ] && JOBSTATE="$CLAUDE_JOB_DIR/state.json"
field() { [ -f "$JOBSTATE" ] && python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$JOBSTATE" "$1" 2>/dev/null; }
OWNER_SESSION="$(field name)"
OWNER_SESSION_ID="$CLAUDE_CODE_SESSION_ID"; [ -n "$OWNER_SESSION_ID" ] || OWNER_SESSION_ID="$(field id)"
```

Use the **same** resolution when you boot and when you later check ownership, so
the two ids match.

## Reviving a worker

When the supervisor poll returns `{ revive, nudge }`, the lead relays the `nudge`
text verbatim to that worker.

- **Claude Code:** send the nudge to the worker's subagent as a message (the
  `SendMessage` tool, addressed to the subagent). If that fails, spawn a fresh
  subagent with the same `clientKey` and prime it with the same nudge.
- **Elsewhere:** if your harness cannot message a running subagent, always take the
  fresh-spawn route.

The concurrency cap in Claude Code is 20 live subagents. Resuming a completed
subagent takes a fresh slot without re-checking the cap, so count live subagents
before you revive one rather than assuming a completed worker freed its slot.

## Forced session ends

Claude Code compacts a long session automatically (around 76 to 84 percent of the
context window here), and a subagent can hit its turn limit. Either is a forced
end: tear nothing down (see `teardown.md`). After a compaction, re-read
`tldraw-editor-api.md` before the next `/exec`: the verified signatures are the
first thing a compaction drops.

## Why polling and not a push

Claude Code Channels (an MCP server that pushes events into a live session) was
evaluated and deferred. The delivery guarantee lives in the bridge's durable
per-recipient queue, which both designs ride, so the wake is a best-effort nudge
either way, and polling matches a push on reliability and latency. Channels'
research-preview cost (an experimental launch flag every session, plugin
packaging, an org gate) is not worth its one edge today.
