---
name: arch-board
description: Convenes a board of whatever personas a design challenge needs (for example Martin Fowler, Rich Hickey, a security lens) that investigates it independently, debates the cruxes and returns a cited verdict with dissents kept. Use whenever a design fork is hard or cross-cutting, or on convene a board, get a panel to weigh in, deliberate the trade-offs, or what would <expert> think about this. Do NOT use to review an existing diff (`ocr-review-loop`), to root-cause a failure (`first-principles-investigation`), to interview the user about a plan (`grill-with-docs`), or for a change with one obvious approach.
license: MIT
compatibility: Best where the agent can dispatch subagents in parallel and continue one it started; degrades to serial members, then to one agent playing each seat. The transcript helper needs python3.
argument-hint: '<the bug, enhancement or design challenge to deliberate>'
---

# arch-board

Run a **board of expert minds** that investigates a challenge from independent
angles, debates the cruxes, and converges on a designed solution, or on a
well-characterized disagreement worth the user's call. Its value is
_diversity under discipline_: several strong lenses, each reasoning alone first,
then tested against one another. A challenge with one obvious approach does not
need a board.

"Board" here means this deliberation only, not a task or issue board.

There is always exactly one **team-lead** who owns the reasoning: framing,
seating the roster, distilling cruxes, moderating, and writing the verdict.
Members never talk to each other; everything routes through the team-lead.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Where things live

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Scratch folder** (`docs/agents/workspace.md`): where the board directory
  lives. Default: `.scratchpad/` at the repository root, git-ignored.
- **Conventions folder** (`docs/agents/workspace.md`): the house engineering
  principles and coding standards every member weighs a design against.
  Default: none; the repository's agent instructions and code are the
  conventions.
- **Glossary and decision records** (`docs/agents/domain.md`): the domain's
  vocabulary and the choices already settled. Defaults: `GLOSSARY.md` at the
  root (a multi-context repository adds `GLOSSARY-MAP.md`), decision records in
  `docs/adr/`. A file that does not exist is skipped silently.
- **Issue tracker** (`docs/agents/issue-tracker.md`): where to read the issue a
  challenge came from. Default: none configured.

## Which role you hold

Members are subagents, and the board runs best when they run in parallel. The
top level is the one place a parallel fan-out is guaranteed; a subagent's own
spawns often are not. So the role that spawns members sits at the top level, and
the reasoning sits in a subagent that keeps the deliberation out of the caller's
context. Pick the first case that fits:

- **You are top-level, and you can dispatch subagents in parallel and continue
  one you started with its context intact** (the user's `/arch-board`, a
  top-level skill, an unattended run): you are the **hands**. Follow
  [references/handshake.md](references/handshake.md): start one team-lead
  subagent, the **brain**, from [references/team-lead.md](references/team-lead.md),
  spawn members when it asks, relay paths, and leave the deliberation unread.
- **Your prompt names you this board's brain**: reason and request; the hands
  spawn. Your prompt carries the request forms; this file and
  [references/templates.md](references/templates.md) carry the rest.
- **You can dispatch subagents but have no hands partner** (another caller
  invoked you as a subagent, or you cannot continue a subagent you started): you
  are both team-lead and hands. Spawn members yourself, in parallel where you
  can and one at a time where you cannot, and follow
  [references/handshake.md](references/handshake.md) for the thin pointer, the
  per-member check and persisting a member's `PATH:` result, and
  [templates § Writing a board file](references/templates.md#writing-a-board-file)
  for when your own file is refused. Record a serial run in `frame.md`.
- **You cannot dispatch subagents**: you are the team-lead and you play each
  seat yourself, one at a time. Write each member's position from its
  assignment alone and place it before you start the next; never revise an
  earlier position after reading a later one, because the debate is where the
  seats meet. Record a single-agent run in `frame.md`, and say in the verdict's
  Board section that the positions were not independent.

Two placeholders recur, and every agent passes both on literally as absolute
paths, because a relative path resolves against the wrong checkout in a
subagent:

- `<skill-dir>`: this skill's absolute directory. The hands resolve it when they
  load the skill; the brain has it as `SKILL DIR` in its prompt.
- `<scratchpad>`: the command prefix for the `scratchpad` skill's script,
  `bash '<absolute path to its scripts/scratchpad.sh>'`, with
  `--dir '<folder>'` appended when the scratch folder is not `.scratchpad/`.
  Whoever opens the board resolves it once and writes it into every assignment.

## Never ask; return `needs-input`

A subagent cannot reach the user: it has no way to put a question to them and
wait. When the board meets a choice that is genuinely the user's, the brain ends
the pass with a **`needs-input`** result, and the hands carry it out. Where the
user is in the conversation, the hands ask them directly, with the board's lean:
using your structured-question tool if you have one; otherwise list numbered
options in plain text and stop until they reply. In an unattended run, the hands
take it out by whatever route their runner gives questions for a person. Either
way the question travels out rather than being settled by whichever member met
it: delegating the work never delegates a decision that was the user's.

## Invocation

**Inputs**, parsed from how you were called rather than demanded as flags:

- **Challenge** (required): the bug, enhancement, question or design problem.
- **Roster** (optional): seats the caller named, any personas or roles at all,
  used verbatim; otherwise the team-lead seats by judgement.
- **Repository** (optional): the checkout the design is for. Default: the
  repository you were invoked from.
- **Continuation** (optional), one of two kinds: **feedback** on a prior board
  directory's `BOARD-RESULT.md`, which opens the next round; or an **answer** to
  that board's `NEEDS-INPUT-<q>.md`, which resumes the same round.

**Outputs**: the board directory and the verdict summary, which repeats every
open question for the user; or a `needs-input` result.

## The phases

The brain reasons through every phase; the hands perform the spawns it asks
for. Every board file is written by the route in
[templates § Writing a board file](references/templates.md#writing-a-board-file).

- **P0 · Frame** _(brain)_. Read the challenge and gather context: the target
  repository's agent instructions (`AGENTS.md`, `CLAUDE.md` or its equivalent)
  and its code, the issue it came from if there is one, the decision records and
  glossary that touch the area, and the conventions folder's engineering
  principles. Open the session directory: load the `scratchpad` skill (through
  your skill tool, `/scratchpad`, or by reading its SKILL.md), resolve
  `<scratchpad>`, and run `<scratchpad> new arch-board '<slug>'` as one plain
  command, never wrapped in `$(…)`, keeping the absolute path it prints.
  `scratchpad` finds its root from your working directory, so read THE REPO by
  absolute path and stay in the checkout you started in. If `scratchpad` is not
  installed, create `<scratch folder>/arch-board/<UTC-YYYYMMDD-HHMMSS>-<slug>/`
  at the top of the main checkout (the first path `git worktree list` prints),
  make sure git ignores the scratch folder, and write board files there directly.
  Write `frame.md`: problem, domains touched, roster and why, sizing, and how
  the run is staffed (parallel, serial or single-agent).
- **P1 · Roster** _(brain)_. Seat the caller's roster as given, or seat by
  judgement. [references/board-members.md](references/board-members.md) holds
  example personas and the sizing heuristic, not a closed list: draw from it, or
  coin any persona the challenge needs in the same brief shape. When seating by
  judgement, keep its two staples and at least three seats. Write each member's
  assignment, from [references/member.md](references/member.md), to
  `round-N/_assignments/<member>.md`.
- **P2 · Independent positions** _(hands spawn)_. Each member gets a thin
  pointer to its assignment, blind to its peers, and writes
  `round-N/01-positions/<member>.md`. The file is the deliverable.
- **P3 · Debate** _(brain moderates, hands spawn)_. The brain reads every
  position, distills the genuine cruxes and the falsifiers members exposed, and
  writes exchange `<k>`'s assignments; members answer in
  `round-N/02-debate/<k>/<member>.md`. Each exchange gets its own `<k>`, from 1.
  Loop until the board converges or reaches a stable, well-characterized
  disagreement, never a forced consensus. Often one exchange is enough.
- **P4 · Synthesis** _(brain)_. Load the `conveying-clearly` skill (through your
  skill tool, `/conveying-clearly`, or by reading its SKILL.md) first and hold
  the verdict to it hardest: it is written at the board's most
  jargon-saturated moment for a reader who never watched the debate. Without it,
  hold to the rules the schema states. Write `round-N/BOARD-RESULT.md` to the
  schema in [references/templates.md](references/templates.md#board-resultmd-schema).
  _Done when a teammate who missed the session could act on it unaided._
- **P5 · Handoff** _(brain, then hands to the caller)_. Return the verdict, the
  board directory, the next step and the continuation hint, held to the same
  standard as the verdict, with every open question for the user repeated in the
  summary.

## Persistence and continuity

The session directory is the board's memory, and the brain owns the round
structure inside it. `scratchpad` roots it in the main checkout's scratch
folder, so a board convened from a worktree survives that worktree. Below,
`.scratchpad/` stands for whichever folder is configured:

```
.scratchpad/arch-board/<ts>-<slug>/
  frame.md
  round-1/
    _assignments/<member>.md, <member>-debate-<k>.md
    01-positions/<member>.md
    02-debate/<k>/<member>.md
    NEEDS-INPUT-<q>.md, 00-answer-<q>.md   one pair per question for the user
    BOARD-RESULT.md
  round-2/
    00-feedback.md
```

**Feedback** opens `round-N+1/`, re-seats as the feedback warrants, and runs
another pass. **An answer** resumes the same round where its question stopped
the board, through the live brain or a fresh one:
[templates § Resuming on an answer](references/templates.md#resuming-on-an-answer).

The board directory is scratch: local to this machine and never committed. What
the board settles that must last becomes a decision record, which the verdict's
Handoff proposes and the user approves.

## References

- [references/handshake.md](references/handshake.md): the hands' protocol, the
  thin pointer prompt, and persisting a `PATH:` result.
- [references/team-lead.md](references/team-lead.md): the prompt that starts the
  brain.
- [references/member.md](references/member.md): the member's position and debate
  assignments.
- [references/board-members.md](references/board-members.md): the persona bench
  and the sizing heuristic.
- [references/templates.md](references/templates.md): writing a board file, the
  `BOARD-RESULT.md` schema, the `needs-input` shape, resuming on an answer.
- `scripts/persist-final-message.py`: writes a member's `PATH:` final message to
  the board file it names.
