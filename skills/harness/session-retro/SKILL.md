---
name: session-retro
description: >-
  Retrospective on one agent session: reads the session back (a bundled digest for Claude
  Code's JSONL transcripts, any other harness's log, or the agent's own context), finds
  what the repository made hard, and proposes fixes by severity, each for the layer that
  owns it. Use whenever someone says run a retro, retro this session, what slowed that run
  down, why did that take so many turns, or make this repo easier for the next agent. Do
  NOT use to measure whether a skill fires (use `harness-eval`), to write the fix itself
  (use `skill-builder` for a skill, `add-standard` or `standards` for a convention, or
  `writing-for-agents` to reword an instructions file), or for a retrospective on a
  project or a team's week rather than one session.
license: MIT
compatibility: >-
  The digest script needs python3 and reads Claude Code's JSONL transcripts only. In any
  other harness the skill works from a session log the user points at, or from the agent's
  own context.
argument-hint: '[session id or path to a session log]'
metadata:
  credits: "Adapted from Matt Pocock's retro skill, https://github.com/mattpocock/skills (MIT)"
---

# session-retro

One session, read back as evidence about the environment rather than about the
agent. The subject is what the repository made hard: which file was hard to find,
which mistake nothing caught, which tool call was paid for twice.

**It proposes and hands off. It writes no file**, and neither does its script.
Every accepted finding is carried out by the skill that owns its layer, in a
separate pass, so a retro never leaves a half-applied change behind.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Where things live

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Instructions file:** `AGENTS.md` at the repository root and in any folder
  that has one (some harnesses read `CLAUDE.md` or their own equivalent). Loaded
  in every session.
- **Conventions folder** (`docs/agents/workspace.md`): the house rules. Default:
  none.
- **Code review** (`docs/agents/workspace.md`): how changes are reviewed, and
  where the reviewer's instructions live. Default: none.
- **Eval cases** (`docs/agents/workspace.md`): routing cases for the skills.
  Default: `.evals/cases/`.
- **Issue tracker** (`docs/agents/issue-tracker.md`): where parked work goes.
  Default: none; parked items go back to the user as a list instead.

## Context pressure decides which layer gets a finding

Work runs in two stages carrying unequal loads. The implementer explores, writes
and debugs failures, and its window is full by the time the work is done. The
reviewer receives a diff: no exploration, rarely any debugging.

So **a convention belongs to the reviewer, not the implementer.** Stated once in
the conventions folder, and routed by a rule file where the harness has a rule
layer, it costs nothing until a matching file is read, and the reviewer reads it
against the diff. The same sentence pasted into `AGENTS.md` is charged to every
session in the repository, including the many that never touch the file it
governs.

Before either, ask whether the violation is **mechanical**: a fixed syntactic
pattern, a banned API, an import shape, a file location. A mechanical rule gets a
deterministic check (a rule in the repository's own linter, a pre-commit hook, a
CI job), whichever the repository's language and existing checks make cheapest.
Written rules are for **judgment calls** no check could make.

## Where a finding lands

| Layer | Loads | Send a finding here when | Hand to |
|---|---|---|---|
| An automated check: linter rule, hook, CI job | on every run | the mistake is mechanical | the repository's own check command |
| A conventions-folder section, plus its rule pointer if the harness has a rule layer | when a matching file is read, and at review | it is a judgment call governing a kind of file | `add-standard` for a new one, `standards` for an existing one |
| The reviewer's instructions | on a diff | the reviewer read the change and missed it | `standards`, then the reviewer's own file |
| A skill's `SKILL.md` | on trigger | it is a repeatable multi-step procedure | `skill-builder` |
| A skill's `references/` | on demand | it is depth only some branches reach | `skill-builder` |
| A skill description, or a pointer's wording | always | it fired late, or the wrong thing fired | measure with `harness-eval`, word with `writing-for-agents` |
| Eval cases | on a run | the claim is "that description is wrong" | `harness-eval` |
| Tooling: a script, a CLI, a log the agent can read | when run | the cheap route did not exist, or a fact was out of reach | the repository's own tooling; `skill-builder` when it belongs inside a skill |
| `AGENTS.md` | always, every session | nothing above reaches it, and the fact is navigation | `writing-for-agents` for the wording, `skill-builder` for the choice of primitive |
| The issue tracker, or the parked list | never | it is not yet work, or nobody has judged whether it is | propose the item; never file it |

Two rows do the disproportionate work. `harness-eval` turns "is this description
any good" into a number, so a wording finding arrives measured rather than
asserted. The parked list takes the suspicions, which is what keeps the presented
list short.

## Severity

| Level | Test | Evidence it needs |
|---|---|---|
| **P1** | the session finished wrong, or did not finish, and the environment is why | the failed calls, or the wrong file, quoted from the session |
| **P2** | it finished and paid for it | a count: one file read 3+ times, a repeated search, one shell command shape dominating |
| **P3** | it worked this time on judgment the next session may not repeat | one occurrence, named |
| **P4** | an annoyance with no measured cost | goes on the parked list, not the presented list |

**A candidate with no count and no quoted line is not a finding.** That bar is
what stops a retro becoming a list of things that felt slow.

## Procedure

### 1. Get the session's record

The session is the one the user named; otherwise the current one. If
`writing-for-agents` is installed, load it now (through your skill tool,
`/writing-for-agents`, or by reading its SKILL.md): every fix you propose is
wording an agent will read.

Take the first route that applies.

**Claude Code: run the digest.** Claude Code writes each session to
`~/.claude/projects/<slug>/<session id>.jsonl` (under `$CLAUDE_CONFIG_DIR` when
that is set), where the slug is the working directory with every
non-alphanumeric character replaced by `-`. The digest reads that format and no
other.

```bash
python3 scripts/session-digest.py                  # newest session for this working directory
python3 scripts/session-digest.py --list           # pick another
python3 scripts/session-digest.py <id> --json
python3 scripts/session-digest.py path/to/session.jsonl
```

It finds the transcript folder from the working directory and falls back up the
tree, so a worktree with no transcripts of its own reads the checkout's. A
dispatched subagent writes its own `agent-*.jsonl` stamped with the parent's
session id; the digest folds those in and reports how many it merged. `--last N`
means the N most recent sessions, each with its own subagents; it is not how you
reach one session's fan-out. Given a path, it folds in the subagents stored
beside that file.

**Another harness, with a log.** Ask the user where the harness keeps the
session's log, or to export it, using your structured-question tool if you have
one; otherwise ask in plain text and stop until they reply. Read it and build the
same counts by hand: tool calls by kind, failed calls, files read two or more
times, searches issued more than once, the dominant shell command. Count calls,
not lines: a log line is not always one call.

**No log reachable.** Review the current session from your own context. Say in
the report that the counts are recalled rather than measured, and hold each
finding to a quoted line, since a recalled count is weaker evidence than a
measured one.

Done when you have the counts above and know where in the record each one
happened.

### 2. Read the record at the hotspots

The counts name where to look; they do not say what happened there. The digest
prints the transcript folder and every failed call with its `tool_use` id: search
the transcript for that id rather than reading a multi-megabyte file end to end.
For a churned file or a repeated search, search for the path or the term.

**Read the counts off the script, never off the raw file.** A transcript writes
one line per content block, so counting lines counts a single API call two to
four times. The digest prints both numbers and the ratio between them.

### 3. Turn each hotspot into a candidate

| Signal | What it usually means | Category |
|---|---|---|
| one file read 3+ times, or a long search run before an edit | the file was hard to find, or its dependency on another file is unwritten | navigation |
| a mistake nothing caught until a person said so | no check exists at the cheap layer; read the repository's own check command and CI first, since a check that exists but is unwired or broken is the finding, and a repository with no check at all is one too | automated checks |
| the reviewer approved something a convention forbids | the convention is unstated, unrouted, or its rule's glob reaches nothing | conventions |
| an instruction in `AGENTS.md` that belongs in the conventions folder or a check | it is charged to every session instead of loading when it applies | instructions file |
| an always-loaded instruction that never changed a decision | it pays context every session and buys nothing | no-ops |
| one shell command shape dominating, or a call reissued for the same fact | the cheap route exists and was not taken, or does not exist yet | tool economy |
| a fact the session guessed at and got wrong | it was never reachable from inside the session | information access |

Every category above is a claim about the environment. A candidate that is a
claim about the agent's judgment is out of scope.

### 4. Present, ordered by severity

For each: the evidence, the layer from the table, the skill that owns the fix,
and the change that removes the cause, sized by what the evidence proves. **At
most five**, because a retro whose output nobody works through is
indistinguishable from one nobody ran. Past five, and every P4, goes on the
parked list: name each item and the issue tracker it would go to, if one is
configured, and file nothing.

Then stop and wait. Nothing is applied in this invocation. When the user accepts
a finding, load the skill that owns it (through your skill tool, `/<name>`, or by
reading its SKILL.md) in a separate pass. If that skill is not installed, make
the change by hand at the layer the table names.

## The digest itself

`scripts/session-digest.py` is Python 3, standard library only, and read-only: it
prints and writes nothing. Its test suite and a synthetic transcript fixture ship
with this catalog's source, not with the installed skill. When you change the
script, run that suite and break the code on purpose to watch each new check
fail before you trust it: a check nobody has watched fail is indistinguishable
from one that never ran.
