---
name: handoff
description: >-
  Compact the current session into a handoff document: the load-bearing references,
  decisions and resume coordinates, none of the transcript noise, so a fresh agent carries
  it on. Use whenever someone says hand this off, write a handoff, I am running out of
  context, note where to resume, or pick this up in a new session. Do NOT use to word one
  message well (use `conveying-clearly`), to open a plain scratch file (use `scratchpad`),
  or to record a settled decision (use `decision-record`).
license: MIT
argument-hint: '[what the next session will focus on]'
metadata:
  credits: "Adapted from Matt Pocock's handoff skill, https://github.com/mattpocock/skills (MIT)"
---

# Handoff

A session is about to end and the work is not done. What you were doing, the
three things you already ruled out, the exact file you stopped in, the gotcha
that cost you an hour: all of it lives only in this conversation. The next agent
boots cold. It gets the repository, its agent instructions, and whatever memory
the harness keeps, and none of your live thread.

The whole job is compaction: squeeze the session down to its resumable core, so
the next agent inherits the momentum and not the noise. There are two ways to
fail:

- **Too much.** You paste the transcript, or re-explain what an issue, a spec or
  a decision record already says. The next agent drowns and re-reads everything
  anyway.
- **Too little.** You write a tidy summary that quietly drops the load-bearing
  specifics: the exact next action, the dead end not to retry, the file you
  stopped in. The next agent looks confident and rebuilds the wrong thing.

Most durable context already lives in artifacts. Your handoff **points** at
those, never copies them. What it must carry itself is only the live thread that
is not written down anywhere yet, plus the mechanical coordinates to reconstitute
the workspace. Everything else is a link.

Write for a smart stranger who has your tools and your repository but zero
memory of this conversation. If a sentence would be obvious to them from the
artifacts, cut it and link the artifact. If it would not be recoverable without
you in the room, it belongs in the handoff.

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

## Step 1: recon the mechanical state

Before writing prose, capture the facts a summary loses. Run what is relevant.

```bash
git branch --show-current     # the branch to resume on
git status --short            # uncommitted work: the live edit surface
git log --oneline -8          # recent commits, for narrative anchor
git stash list                # anything parked
pwd                           # the working directory: matters in a worktree
git worktree list             # is this a worktree? the next session must enter the SAME one
```

Then take stock of what git will not show you:

- **Background processes** you started, and what each is watching: a dev
  server, a CI watch, a running test. The next agent needs to know they exist,
  or to restart them.
- **State outside the repository**: a document shared, a message sent, an
  external system touched, a database rebuilt, a key rotated. Anything that will
  not be obvious from the files.
- **Relevant memory.** If your harness keeps a persistent memory with an index
  (a `MEMORY.md`, for example), skim it for entries this work already has. Where
  one exists, the handoff references it instead of restating its contents. If
  this session materially changed the state a memory describes, updating that
  memory is often the more durable move than the handoff carrying it.
- **Parked items this work already touched.** Check the issue tracker, and any
  list of deferred work the repository keeps. If something belongs there rather
  than in a handoff, **put it there instead** (asking first if creating it needs
  the user's say-so). A tracked item survives; a handoff in scratch gets swept.

That last point is the most common mistake. A handoff is for the live thread, not
for anything that has a durable home.

## Step 2: write the document

Save into the git-ignored scratch folder, never into tracked files: a handoff
under version control becomes a permanent artifact that turns up in every search,
competing with the project's real documents.

Load the `scratchpad` skill (through your skill tool, `/scratchpad`, or by
reading its SKILL.md), then run its `new handoffs '<short-slug>'` verb, by the
absolute script path that skill describes and with the configured scratch folder
if it is not the default. Run it as one plain command, not wrapped in `$(…)`,
which some sandboxed sessions refuse. Write `HANDOFF.md` inside the directory it
printed, at that absolute path. Never at a hand-written `.scratchpad/...` path,
which resolves against your current directory and strands the file.

**If that write is refused**, you are probably in an isolated background session
and the entry lives at the main checkout, which your file-editing tools may not
reach. Draft `HANDOFF.md` outside the repository, then move it in with the same
script's `place` verb: `place '<the printed directory>' HANDOFF.md '<abs path to
your draft>'`. Do not answer that refusal by writing into a worktree-local
scratch folder: the handoff dies the moment the worktree is removed.
`scratchpad`'s `references/writing-into-a-locked-entry.md` has the reasoning and
the shapes `place` refuses.

The next session finds the latest handoff by running that same script with
`list handoffs`.

**If `scratchpad` is not installed**, create
`<scratch folder>/handoffs/<UTC-YYYYMMDD-HHMMSS>-<short-slug>/HANDOFF.md` at the
top of the main checkout (the first path `git worktree list` prints), and make
sure git ignores the scratch folder. Outside a git repository, save it to the
operating system's temp directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows)
instead.

The structure is in
[references/document-template.md](references/document-template.md). Load it now.
**Omit any section that is empty**: a padded handoff is noise wearing a template.

Two things that trip up the compaction:

- **A fact that fits two sections** belongs in one. The classic case is a dead
  end that is also the reasoning for where the work should go instead. Put it
  where the reader needs it most, usually Landmines, and let the other section
  point at it in a clause. One crisp pointer beats two near-duplicates.
- **An artifact that is also a live edit** gets linked, and you carry only the
  delta: what is done, what is in flight, where you stopped. Do not transcribe a
  list the artifact already holds.

## Step 3: redact before you save

The document may be pasted into a fresh session or shared. Strip API keys, secret
values, passwords, tokens, connection strings, and personal data on the way in.
Reference where a secret lives (the vault slot, the environment variable's name)
rather than its value.

If the conventions folder holds a confidentiality rule, apply it in full. A
handoff carrying a client's commercial terms is exactly the artifact that gets
pasted somewhere it should not be.

## Step 4: deliver it

Report back with:

1. The **absolute path** the script printed. Never a relative one: the reader,
   or the agent they paste it into, may sit in a different worktree, where a
   relative path points nowhere.
2. A copy-pasteable **seed instruction** for the next session, for example:
   `Read <absolute path> and continue the work; start with the first item under "Next steps".`

Then stop. Do not launch the next session yourself unless asked. The default
deliverable is the document plus the seed line, so the person chooses when and
where to resume.

## If the user passed an argument

Treat it as the focus of the next session and tailor the whole document to it. A
handoff aimed at "finish the proposal and send it" foregrounds the done-bar and
the open questions; one aimed at "work out why the numbers disagree" foregrounds
the landmines and what has already been ruled out. Same session, different lens.

## Gut-check

Read the draft once as the stranger who will receive it and ask: could I resume
from this alone, without the transcript? If the answer is "not without guessing
the branch", "not without knowing what you already tried", or "not without the
specific next action", fix that and only that.

The bar is resumability. Nothing more, nothing less.
