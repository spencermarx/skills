---
name: handoff
description: >-
  Compact the session into a handoff document (the next action, rulings, dead ends,
  resume coordinates) and, where the harness can launch a background session, launch the
  successor and stop this one. Use whenever someone says hand this off, write a handoff,
  the context is filling up, I am running out of context, note where to resume, or pick
  this up in a new session. Do NOT use to word one message well (use
  `conveying-clearly`), to open a plain scratch file (use `scratchpad`), or to record a
  settled decision (use `decision-record`).
license: MIT
argument-hint: '[what the next session will focus on]'
metadata:
  credits: "Adapted from Matt Pocock's handoff skill, https://github.com/mattpocock/skills (MIT)"
---

# Handoff

The successor boots cold: the repository, its agent instructions, whatever
memory the harness keeps, and none of this conversation. Carry the live thread
nothing else holds (the next action, what you ruled out, where you stopped) and
the coordinates to resume, and link every artifact that holds the rest. A pasted
transcript buries the thread; a tidy summary drops it, and the successor starts
confidently on the wrong thing.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Where things live

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Scratch folder** (`docs/agents/workspace.md`): where the handoff is saved.
  Default: `.scratchpad/` at the repository root.
- **Issue tracker** (`docs/agents/issue-tracker.md`): the durable home for work
  that is parked rather than live. Default: none configured; ask before creating
  issues anywhere.
- **Decision records** (`docs/agents/domain.md`): where settled choices are
  written down. Default: `docs/adr/`.
- **Conventions folder** (`docs/agents/workspace.md`): house rules, including
  any on confidentiality. Default: none.

## Step 1: recon, and settle what is running

```bash
git rev-parse --show-toplevel   # where the successor opens
git rev-parse --short HEAD      # the SHA this handoff describes
git status -sb                  # branch, upstream, uncommitted work
git log --oneline -8
git stash list                  # a shared stack: name only your entries
git worktree list               # in a worktree, the successor opens in the same one
gh pr view --json number,url,state,reviewDecision   # GitHub only; then gh pr checks, for CI
```

**Can this session launch its successor?** Only where the harness can start a
background session from the shell and report its id, as Claude Code's
`claude --bg` does. There, load
[references/what-carries-over.md](references/what-carries-over.md) now: inside a
background job it reads the job's state record (this session's name and id for
the document, the launch flags and any persona prefix for Step 4), and outside
one it says what the launch carries instead. Anywhere else, Step 4 delivers the
document and a seed line, and launches nothing.

Then take stock of what git does not show:

- **Background processes** you started: each dies with this session, so its
  command goes under Resume coordinates.
- **Held resources**: what the successor must own, such as a server this session
  started (a `whiteboard` board, a dev server holding a port). Step 4 releases
  them.
- **State outside the repository**: a document shared, a message sent, an
  external system touched, a database rebuilt, a key rotated.
- **Relevant memory.** If your harness keeps a persistent memory with an index
  (a `MEMORY.md`, for example), skim it for entries this work already has. The
  handoff references them rather than restating them; if this session changed
  the state one describes, updating that memory is the more durable move.
- **Parked items this work touched.** Anything with a durable home goes to the
  issue tracker, or the repository's list of deferred work, instead (asking
  first if creating it needs the user's say-so): a tracked item survives, and a
  handoff in scratch is swept.

Unless the request is **Keep this session** (Step 4), whatever this session
dispatched stops with it. Settle each subagent or background task still in
flight:

- **Well along**, with less left than a restart costs: wait for it. Say which
  you are waiting on, then end your turn if its completion resumes you;
  otherwise wait in place. Where ending the turn ends the run (a headless,
  one-shot invocation), treat each as Otherwise.
- **Otherwise:** stop it, and keep its brief, verbatim, with any partial
  findings. Step 2 saves them beside `HANDOFF.md`, and re-dispatching it becomes
  an item under Next steps.

## Step 2: write the document

If the user passed an argument, it is the next session's focus: tailor the
document to it, so "send the proposal" foregrounds the Done-bar and "find why
the numbers disagree" the Landmines.

Save into the git-ignored scratch folder, never into tracked files: a handoff
under version control turns up in every search, competing with the project's
real documents. Load the `scratchpad` skill (through your skill tool,
`/scratchpad`, or by reading its SKILL.md), then run its
`new handoffs '<short-slug>'` verb by the absolute script path that skill
describes, as one plain command, not wrapped in `$(…)`, which some sandboxed
sessions refuse. Write `HANDOFF.md` at the absolute directory it prints, never
at a hand-written `.scratchpad/...` path, which resolves against your current
directory and strands the file.

**If that write is refused**, the entry probably lives at the main checkout,
beyond an isolated session's reach. Draft `HANDOFF.md` outside the repository,
then move it in with the same script's `place` verb:
`place '<the printed directory>' HANDOFF.md '<abs path to your draft>'`.
Never answer the refusal by writing into a worktree-local scratch folder: the
handoff dies with the worktree. `scratchpad`'s
`references/writing-into-a-locked-entry.md` has the reasoning.

**If `scratchpad` is not installed**, create
`<scratch folder>/handoffs/<UTC-YYYYMMDD-HHMMSS>-<short-slug>/HANDOFF.md` at the
top of the main checkout (the first path `git worktree list` prints), and make
sure git ignores the scratch folder. Outside a git repository, use the operating
system's temp directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows).

Each brief kept in Step 1 goes beside `HANDOFF.md` as `brief-<label>.md`, and so
does any file the successor needs from this session's temp directory, which
dies with the session.

Load [references/document-template.md](references/document-template.md) now,
and omit any section that is empty.

**Every claim you pass on says how you know it.** A fact about a file, a tool, a
system or a person's position is either checked this session, and written with
what showed it (the command, the file and line, the message), or carried from
memory, a subagent's report or an inference, and marked **unverified** with
where to check it. A passing check names where it ran and at which SHA: a
worktree passes where CI fails. Before you mark a claim checked, check it now.

A fact that fits two sections goes in one, usually Landmines, and the other
points at it. An artifact that is also a live edit is linked, with only the
delta carried.

## Step 3: read it as the successor, then redact

Read the draft once, cold, as the successor will: the repository, this file,
nothing else. It is ready when:

- the first Next steps item can be acted on within a minute without the
  transcript;
- every dead end is under Landmines, and anything half-built names where it
  stopped;
- every claim names how it was checked, or is marked unverified;
- every ruling and correction the user gave this session is quoted;
- whatever the user is waiting on is Next steps item 1, and every item that
  waits on the user is marked `[gate: user]`.

Fix what fails, and only that. Then redact: strip API keys, secret values,
passwords, tokens, connection strings and personal data, referencing where a
secret lives (the vault slot, the environment variable's name) rather than its
value. If the conventions folder holds a confidentiality rule, apply it in full.

## Step 4: deliver, and launch the successor where you can

A subagent or fork never launches. It may see its parent's job record, so a
successor it started would stop the parent: it writes the document, returns its
absolute path, and stops there.

Where Step 1 found this session can launch its successor, the handoff launches
it, and the successor stops this session, so the user steps straight into the
new one. That is the default even when you fired the skill unasked. The request
opts out by what it means, not its exact words:

- **Not now** ("don't launch", or a later pickup: "tomorrow", "before I stop for
  the day"): report the document and the launch line, and stay open.
- **Keep this session**: launch, with the seed's stop sentence left out.

Where it cannot launch, and in a headless run with no one to step across: report
the document and the seed line, and stop.

The seed line:
`Read <absolute HANDOFF path> and continue the work. <stop sentence> Then start with the first item under "Next steps".`
The stop sentence, the launch command and the successor's name are in
[references/what-carries-over.md](references/what-carries-over.md). The seed has
no stop sentence without a launch, for **Keep this session**, or where this
session is not a background job the successor can stop.

### Report, release, then launch

Report first, in the same message as the launch, so the report survives
whatever follows:

1. The **absolute path** of `HANDOFF.md`, never a relative one: the reader may
   sit in a different worktree.
2. The full seed line, or the full launch line where there is one, for a
   relaunch by hand.
3. Where launching: the successor's name, and how to reopen this session with
   its conversation intact, or, where nothing will stop it, that this session
   can be closed.

Release each held resource the document records, so the successor starts its
own instead of joining one that dies with this session. A worktree stays: the
successor runs in it.

Launch from the top level Step 1 printed, with the command the reference gives.
Once it reports the new session's id, say `Launched <name> (<id>)` and end your
turn. With no id, restart what you released, say the launch failed, and stay
open.
