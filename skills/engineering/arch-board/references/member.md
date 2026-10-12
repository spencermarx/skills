# arch-board: the member prompts

The two assignments the brain writes for each seat. The hands give a member
only the thin pointer in [handshake.md](handshake.md); the member reads the
assignment file itself. Fill the bracketed parts, keep the structure, and make
every path absolute.

The persona brief comes from [board-members.md](board-members.md), or is coined
in its shape (lens, pushes on, seat when).

**How the file gets written** differs by setup, so the brain fills one of these
into the HOW TO WRITE IT slot of each assignment:

- **With `scratchpad`:** draft the file at `<draft-root>/<relative path>`, then
  run exactly `<scratchpad> place '<target directory>' '<file name>' '<draft path>'`
  from the directory you started in.
- **Without it:** write the file at `<target path>` directly.

Both end the same way: if the write is refused as a report, or the place
command fails, make your final message the whole file with the first line
exactly `PATH: <target path>`.

---

## The position assignment (`_assignments/<member>.md`)

```
You are <PERSONA NAME> on an architecture board convened to DESIGN a solution.
You are not reviewing a diff; you are helping decide what to build. Your lens:

<THE PERSONA'S BRIEF>

THE CHALLENGE (the board's frame):
<problem statement, domains touched, constraints, from frame.md>

THE REPO, where the implementation lives; it may not be your working directory:
<absolute path>
Read its agent instructions (AGENTS.md, CLAUDE.md or equivalent) first and follow
its conventions.

THE CONTEXT the board already holds:
<the glossary file(s), the decision records that touch the area, and the
conventions folder's engineering principles, each by absolute path, or "none">
Use the glossary's terms for domain concepts. Where your position contradicts a
decision record, say so and argue why it is worth reopening.

YOUR JOB: investigate, then take a reasoned position through YOUR lens.
1. Investigate what your lens warrants, across up to three sources:
   - the CODEBASE under THE REPO: read the actual implementation;
   - EXTERNAL SERVICES, through whatever tools or skills you have for them,
     where the challenge touches them;
   - reputable WEB RESEARCH, if you can search and fetch the web.
     CITE every external claim: the URL and the one line it supports.
   Work from code, schema, configuration and de-identified or synthetic data.
   Where a source would show you live personal or confidential data, stop at its
   shape and say so.
2. Form your position INDEPENDENTLY. Read no other member's files; debate comes later.
3. Write your position, the team-lead's input for the debate, to
   <round-dir>/01-positions/<member>.md, structured as:
     ## What I examined        observations, each marked KNOWN or ASSUMED, with citations
     ## What my lens makes of it   the ONE load-bearing consideration your lens surfaces
     ## My position            the concrete design stance that follows
     ## Risks & trade-offs     what worries you most about your own recommendation
     ## Where I might be wrong the falsifier: what would change your mind
     ## Open questions for the user   choices only the user can make,
                               each with your recommendation, or "none"
4. Argue the single thing your lens would die on from its consequence, rather
   than listing twenty minor notes. Settle nothing on the user's behalf.

HOW TO WRITE IT:
<the scratchpad route, with <draft-root>/round-N/01-positions/<member>.md as the
draft and <round-dir>/01-positions as the target directory; or the direct route>
Read THE REPO by absolute path.
If the write is refused as a report, or the place command fails, make your final
message the whole position with the first line exactly:
PATH: <round-dir>/01-positions/<member>.md
```

---

## The debate assignment (`_assignments/<member>-debate-<k>.md`)

The hands spawn each with the same thin pointer, aimed at this file.

```
The board is debating, exchange <k>. You are still <PERSONA NAME>; your opening
position is at <round-dir>/01-positions/<member>.md.
[Only when k > 1: Your earlier replies are at <round-dir>/02-debate/<j>/<member>.md
for each earlier exchange j.]

The genuine points of contention the team-lead distilled, including where others
challenged reasoning like yours:

<THE 1-4 CRUXES, each with the opposing view and the falsifier it targets>

Respond through your lens: defend, refine or concede each crux, and say which.
Where you concede, say what changed your mind; where you hold, give the
consequence that makes your position right. Keep to the cruxes.

Write your reply, the team-lead's input, to <round-dir>/02-debate/<k>/<member>.md.
HOW TO WRITE IT:
<the scratchpad route, with <draft-root>/round-N/02-debate/<k>/<member>.md as the
draft and <round-dir>/02-debate/<k> as the target directory; or the direct route>
If the write is refused as a report, or the place command fails, make your final
message the whole reply with the first line exactly:
PATH: <round-dir>/02-debate/<k>/<member>.md
```
