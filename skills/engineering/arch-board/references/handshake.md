# arch-board: the hands-and-brain handshake

What the top-level agent, the **hands**, runs. The team-lead subagent, the
**brain**, does all the reasoning; only control messages and paths cross between
the two, so the hands never read a position, a debate reply or a draft verdict.

The protocol rides on two capabilities: a subagent's **final message** reaches
you when it completes, and you can **continue** that same subagent, with its
context intact, by sending it a follow-up message. So the brain ends each turn
with one request, and you answer by continuing it. If your harness cannot
continue a subagent, you are not the hands: run the board as its team-lead, as
SKILL.md § Which role you hold says.

**Waiting.** In an interactive session, end your response after each spawn or
continuation; the completions wake you. In a headless or unattended run, keep
the run open until every completion has arrived, because ending it kills every
member mid-flight. Either way, close nothing (a status change, a final summary,
a handoff) until the brain returns `VERDICT` or `NEEDS-INPUT`.

## Start the brain

Start one subagent with the full tool set (a general-purpose one, where your
harness offers types), with the prompt in [team-lead.md](team-lead.md), every
placeholder filled with an absolute path.

## The exchange

1. **Brain:** P0 and P1. Ends with `SPAWN`, one line per member.
2. **You:** spawn one member per line, all in one go so they run in parallel,
   each with the thin pointer prompt below aimed at that line's assignment path,
   and wait for every completion. Then check each output path with one plain
   `ls`, and continue the brain with one status per member:
   - `written <output path>`, when the file exists;
   - `persisted <output path>`, when the member's result began `PATH:` and you
     persisted it (below);
   - `failed <member>: <one line from its result>`, otherwise.
3. **Brain:** reads the positions, distills cruxes, and ends with `SPAWN` for a
   debate exchange, or moves to synthesis.
4. **You:** as step 2.
5. **Brain:** ends with `VERDICT` or `NEEDS-INPUT`.
6. **You:** return the verdict summary and the board directory to the caller,
   open questions included; or carry the `needs-input` file's question out, as
   [SKILL.md § Never ask](../SKILL.md#never-ask-return-needs-input) says.
7. **On an answer:** record it first, so the decision outlives any one brain.
   Draft it at `<draft-root>/round-N/00-answer-<q>.md` (the draft root
   [templates § Writing a board file](templates.md#writing-a-board-file)
   defines), then place it, one plain command:
   `<scratchpad> place '<round-dir>' '00-answer-<q>.md' '<draft path>'`.
   Without `scratchpad`, write it into the round directory directly. Then
   continue the brain with the answer if it is still live, or start a fresh
   brain with the `ANSWER` field filled.

## The thin pointer prompt

Kept this small so the frame and the persona brief never sit in your context;
the member loads its own assignment.

```
You are a member of an architecture board. Your full assignment (your persona,
the challenge, what to investigate, and exactly what to write and where) is in:
  <absolute assignment path>
Read it and carry it out fully. Read no other member's files. The FILE you write
is the deliverable, and the team-lead reads it as its input; your final message
can be a one-line pointer to it.
```

## Persisting a `PATH:` result

Some harnesses refuse a subagent's file write when it looks like a report
(Claude Code, for one, can answer "Subagents should return findings as text"),
and a `place` can fail (an existing file, a missing directory, a working
directory in another repository). That subagent then makes its final message
the whole file under a first line reading `PATH: <absolute path>`.

Where your harness keeps the subagent's transcript as a JSONL file (Claude Code
does: the task's output file), persist it with one command:

```bash
python3 '<skill-dir>/scripts/persist-final-message.py' '<the transcript file>'
```

It writes the body to that path and prints it. It refuses a path that is not
inside an existing `arch-board/<board>/` directory, and it never overwrites.
Where there is no such transcript, or `python3` is missing, write everything
after the `PATH:` line to that path yourself.

The result is already in your context by the time it arrives, so this route
costs you the very context the split exists to save; it is the last resort,
which is why every writer drafts and places its file first. A `PATH:` result
from the brain is persisted the same way, then the brain is continued with
`persisted <path>`.
