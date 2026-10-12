# arch-board templates

The brain's half of the protocol: how a board file is written, the
`BOARD-RESULT.md` schema, the `needs-input` shape and resuming on an answer.
The member assignments are in [member.md](member.md). Fill the bracketed parts
and keep the structure. The hands' half is [handshake.md](handshake.md), which
a serial team-lead also follows.

**Every path that crosses between agents is absolute.** `<board-dir>`,
`<round-dir>`, `<draft-root>`, `<skill-dir>`, `<scratchpad>` and `THE REPO`
stand for absolute paths. A subagent's working directory may be another
checkout, so a relative path resolves against the wrong tree, and a blind member
cannot notice: it writes somewhere plausible and the brain reads an empty
directory.

---

## Writing a board file

The board directory sits in the main checkout's scratch folder, which a
worktree-isolated or background session may not be able to write into directly
(the `scratchpad` skill's `references/writing-into-a-locked-entry.md` says why,
and why a plain shell command is the sanctioned route). So every board file,
written by the brain, a member or a serial team-lead, takes one route:

1. **Draft it outside the repository**, at the same relative path under
   `<draft-root>`: for `<round-dir>/01-positions/<member>.md`, the draft is
   `<draft-root>/round-N/01-positions/<member>.md`.
2. **Place it**, one plain command:
   `<scratchpad> place '<target directory>' '<file name>' '<draft path>'`

`place` refuses to overwrite and needs the target directory to exist, so the
brain creates each round's directories before writing into them, one plain
command per round:
`mkdir -p '<round-dir>/_assignments' '<round-dir>/01-positions'`, and
`mkdir -p '<round-dir>/02-debate/<k>'` before exchange `<k>`.

`<draft-root>` is `<temp>/arch-board/<the board directory's own name>/`, where
`<temp>` is the operating system's temp directory (`$TMPDIR`, else `/tmp`;
`%TEMP%` on Windows). The board's timestamp keeps it unique. The brain names it
in every assignment. `scratchpad` finds its root from the working directory, so
every writer reads THE REPO by absolute path and runs `place` from the checkout
it started in.

**Without `scratchpad`**, the board directory is a plain folder and every
writer writes its file there directly; the `mkdir -p` lines still apply.

The last resort differs by role, because it rides on a final message:

- **A member** whose write is refused as a report, or whose `place` fails,
  makes its final message the whole file under a first line reading exactly
  `PATH: <absolute target path>`. Whoever spawned it persists it, at the cost of
  that agent's context.
- **The brain** uses the `PATH:` request its prompt describes, then makes its
  real request on the next turn.
- **A serial team-lead**'s final message goes to its caller, not to hands, so
  it cannot carry a board file. If its write of `frame.md` or an assignment is
  refused, it returns to its caller that this board needs a top-level run; if
  only `BOARD-RESULT.md`'s is refused, it returns the verdict itself as its
  final message.

---

## `BOARD-RESULT.md` schema

The brain writes it in P4. It is the for-humans artifact, **governed by the
`conveying-clearly` skill**; load it first when it is installed. Decision first
in every section; each _why_ stated as a consequence, never as authority ("the
board agreed" justifies nothing to the reader); the shorthand the members coined
grounded or glossed, and no bare `#NNN` standing in for a thing; dissent
first-class. Omit a section only when it is genuinely empty.

```markdown
# Board verdict: <challenge>

## Charge

<The question the board was convened to answer, in one or two sentences.>

## Board

<Who was seated and why: one line of rationale per seat. Note a serial or
single-agent run and any member who failed.>

## Recommended design

<The verdict, concretely: what to build or change, argued from consequence.
The load-bearing section; spend the most care here.>

## Options considered

<The real alternatives and why each lost. Not a strawman list.>

## Contention → resolution

<Each crux debated and how it resolved: converged, and on what, or a principled
disagreement that stands, naming who held what and the crux between them.>

## Dissents

<Minority positions worth remembering, with the member and the reasoning.>

## Open questions for the user

<Every choice the board found but could not settle, each with the board's lean,
or "None". The summary returned to the caller repeats this section.>

## Risks & watch-items

<What could still go wrong; what to verify before and while building.>

## Sources

<Codebase references (path:line) and web precedents (URL and what it supported).>

## Handoff

<The next step and why: propose a decision record through `decision-record`
(the user's yes creates it), feel out an untested part through `prototype`,
chart work bigger than one session through `wayfinder`, settle a remaining fork
through `grill-with-docs`, or implement. The board directory, and how to
re-convene it with feedback.>
```

---

## `needs-input` result shape

A question a person reads cold, so compose it under `conveying-clearly` and its
option-picker mechanics (its `references/option-pickers.md`) when that skill is
installed: one plain ask before any reasoning, options stated as consequences,
the board's lean marked and justified by consequence. The brain numbers each
question in the round from 1, writes it to `round-N/NEEDS-INPUT-<q>.md`, and
ends with `NEEDS-INPUT`.

```markdown
# arch-board: needs input

## Board: <board directory> (round <N>, question <q>, stopped in <phase>)

## What must be decided

<The one decision blocking the board, answerable by someone who never watched
the deliberation: grounded vocabulary, no session shorthand.>

## Options

<Two to four options, each with the consequence of choosing it.>

## The board's lean

<Where the board leans and why, by consequence, or an honest "genuinely the
user's call" when the board is split.>

## To resume

Record the answer at round-<N>/00-answer-<q>.md, then continue the live brain
with it, or start a fresh brain with this board directory, round <N>, question
<q> as its ANSWER: it resumes at <phase>.
```

---

## Resuming on an answer

The hands record every answer at `round-N/00-answer-<q>.md` before resuming, so
the decision outlives any one brain. A live brain simply carries on with it. A
**fresh brain** given an `ANSWER` resumes the same round:

1. Read `frame.md`, every `NEEDS-INPUT-<q>.md` and `00-answer-<q>.md` in the
   round, the positions, and any debate replies.
2. Keep the roster; re-seat nothing.
3. Resume at the phase `NEEDS-INPUT-<q>.md` names, treating each answer as a
   settled constraint, and record in `BOARD-RESULT.md` that it was the user's
   decision.
