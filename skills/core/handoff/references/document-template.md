# The handoff document

Loaded on demand by the `handoff` skill. Omit any section that is empty.

Open with what the work is for and how the result looks now, then what gets the
reader moving; reference material sinks to the bottom.

Write it for a reader who was not in this session: anything the session coined,
or took from a report or an earlier draft, is said in plain words or defined
where it first appears (the `conveying-clearly` skill's Ground every term), so
the next session inherits the facts and not the shorthand.

Without a background job there is no job id, and `<session name>` is the name
the user knows the session by, or the work's subject when it has none.

```markdown
# Handoff: <one-line title of the work>

> Written <YYYY-MM-DD HH:MM> by `<session name>` <(job `own id`), or nothing without a background job>, describing `<branch>` at `<short HEAD sha>`.
> Rulings quoted under Decisions are settled: act on them as given. Everything else is this writer's account at that moment: before you build on it, recommend from it or state it to the user, read the record that owns it (the issue, the file, the system) now, and where they differ the record is the truth. Before your first edit, compare the SHA above and Resume coordinates with `git status -sb` and `git log -1`; where they differ, the repository is the truth, so re-read the In flight item against it. Re-check anything marked unverified at the source it names. Raise every `[gate: user]` item in your first message, written fresh in plain words for the user, who has not read this file, and act on one only after the user answers.

## What the work is for, and how the result looks now

<The goal in the person's own terms, and the motivation behind it. This anchors
every judgment call the next agent has to make. Separate what is established and
agreed from what is still a goal or an open bet.

Then how the result looks now against that goal, as the user would see it: what
you last looked at (the page, the pull request, the running app, the message),
how and when, and anything still short of the goal first. Done is the result as
the user will see it, not a passing check.

Where the successor runs as a persona, say in the second person what that
persona owns: "You are the CCO; the offer cards are yours to change.">

## TL;DR, resume here

<Two to four sentences: the single most concrete next action, concrete enough
that the next agent can start typing within a minute of reading.>

## State of play

- **User:** <their latest request this session, quoted, and whether it is
  answered. If they are waiting on something from you, it is Next steps item 1.>
- **Done:** <what landed, each with how it was verified: the command, where it
  ran (the worktree, a fresh checkout, or CI on a pushed SHA) and the SHA. A
  claim without its location is unverified. Link commits by hash and PRs by
  number; a commit message with no hash is quoted and flagged as unlinked.>
- **In flight:** <what is half-built right now, and exactly where you stopped,
  ideally a file and a line. A subagent stopped before it finished goes here,
  with the `brief-<label>.md` beside this file that re-dispatches it. A subagent
  still running in a session kept open goes here too: what it is doing, and that
  its result lands in that session.>
- **Blocked or waiting:** <on CI, on a person's decision, on something external.>
- **Not known:** <what this handoff does not know, said plainly: "this handoff
  does not know whether X happened; ask before assuming.">

## Next steps

<Ordered. The first item concrete enough to act on immediately; later items can
be coarser. This is the spine of the handoff. Spend the most care here.

Mark an item that waits on the user `[gate: user]`; the banner tells the
successor what that means.

An item that writes beside this file names the command that does it,
`bash '<scratchpad.sh path>' place '<this directory>' <file> '<draft path>'`,
because a session in a worktree may not be able to write here directly; a brief
for the successor's own subagents carries the same command.>

## Resume coordinates

- **Worktree:** <absolute path the successor opens in, or "main checkout">. A
  successor launched in it is already there and enters no other.
- **Branch:** <name>
- **PR:** <number, URL, review state and CI result at the SHA above, or "none">
- **Uncommitted:** <what the parked edits are trying to do, not just a file list>
- **Known-broken:** <anything you left in a state you know is wrong, and whether
  it was yours or already there>
- **Background processes:** <command and what it watches, or "none". Each one
  stops with this session, so the successor restarts it from this line.>
- **Held resources:** <each thing the successor must own, such as a server or a
  board: what it is, who held it, and the command the successor runs to take it
  over. Or "none".>
- **State outside the repository:** <anything sent, shared, or changed
  elsewhere, or "clean">
- **Re-enter with:** <the literal first commands, and exact coordinates: a free
  migration number, a worktree re-create command, the conflict to resolve>

## Decisions and rationale

<Decisions settled this session and the reasoning, each with who settled it and
what it rests on.

- **A person's ruling** is settled: quote it, name who gave it and when.
- **A correction** the user gave this session ("not X, do Y") is a ruling: quote
  it with when it was given.
- **An agent's reading** of a note, a rule or the evidence (a routing, a
  classification, an inferred scope) travels as a working assumption: name the
  source it rests on, so the next agent re-checks it there before building on it.

If a decision met the recording threshold it has a decision record: link it and
stop. This section is only for the calls that are not written down yet.>

## Landmines

<Dead ends you already tried, sharp edges, non-obvious constraints, things that
look right but are not. Each says how it is known; one not checked this session
is marked **unverified**, with where to check it.

This is the single most commonly lost and highest value part of a handoff: the
material that cost you time and would cost the next agent the same.>

## Open questions for the human

<Decisions genuinely waiting on a person. Write each as you would ask the user,
who has not read this file: the question in plain words for a one-line answer,
your recommendation, and the text or output it turns on, quoted with its file
and line.

Before writing one here, check whether it belongs in the issue tracker, or the
repository's list of deferred work, instead. A load-bearing unknown has a
durable home; a handoff is swept.>

## References, as paths not copies

- Issues and PRs: <numbers or URLs>
- Decision records: <path>
- Specs, plans and design docs: <path>
- Memory: <the relevant memory entries, if the harness keeps any>
- Agent instructions: <the relevant AGENTS.md or CLAUDE.md files>
- Key anchors: <the two or three files the next agent will actually touch, with
  lines where it helps>
- Other repositories: <path and the remote ref, such as `origin/main`; fetch
  before reading it>
- Copied beside this file: <briefs, and any files from the session's temp
  directory, which dies with the session>

## Suggested skills

<Which skills the next agent should reach for, and why, in one clause each. For
example: "`grill-me`, the plan still has an open fork";
"`first-principles-investigation`, the failure is still unexplained";
"`decision-record`, the pricing call is settled and needs writing down".>

## Done-bar

<How the next agent will know the work is actually complete: the checks that
must pass, a document sent, a decision recorded, a smoke step specific to this
work. List every artifact that mirrors what changed and must change with it:
diagrams, adapted copies, tickets, runbooks.>
```
