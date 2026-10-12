# The handoff document

Loaded on demand by the `handoff` skill. Omit any section that is empty.

Lead with what gets the reader moving; reference material sinks to the bottom.

```markdown
# Handoff: <one-line title of the work>

## TL;DR, resume here

<Two to four sentences. What this work is, and the single most concrete next
action, concrete enough that the next agent can start typing within a minute of
reading.>

## Objective and why

<The goal in the person's own terms, and the motivation behind it. This anchors
every judgment call the next agent has to make. Separate what is established and
agreed from what is still a goal or an open bet.>

## State of play

- **Done:** <what landed and was verified. Link commits and PRs by hash or
  number. If you only have a commit message and no hash, quote it and flag it as
  unlinked.>
- **In flight:** <what is half-built right now, and exactly where you stopped,
  ideally a file and a line.>
- **Blocked or waiting:** <on CI, on a person's decision, on something external.>

## Next steps

<Ordered. The first item concrete enough to act on immediately; later items can
be coarser. This is the spine of the handoff. Spend the most care here.>

## Resume coordinates

- **Branch:** <name>
- **Worktree:** <absolute path, or "main checkout">; the next session enters the
  same one
- **Uncommitted:** <what the parked edits are trying to do, not just a file list>
- **Known-broken:** <anything you left in a state you know is wrong, and whether
  it was yours or already there>
- **Background processes:** <command and what it watches, or "none">
- **State outside the repository:** <anything sent, shared, or changed
  elsewhere, or "clean">
- **Re-enter with:** <the literal first commands, if non-obvious>

## Decisions and rationale

<Decisions settled this session, and the reasoning, so nobody relitigates them.

If a decision met the recording threshold it has a decision record: link it and
stop. Do not re-argue it here. This section is only for the calls that are not
written down yet.>

## Landmines

<Dead ends you already tried, sharp edges, non-obvious constraints, things that
look right but are not.

This is the single most commonly lost and highest value part of a handoff: the
material that cost you time and would cost the next agent the same.>

## Open questions for the human

<Decisions genuinely waiting on a person. Frame each so it can be answered
without re-reading the whole thread.

Before writing one here, check whether it belongs in the issue tracker, or the
repository's list of deferred work, instead. A load-bearing unknown has a
durable home; a handoff is swept.>

## References, as paths not copies

- Issues and PRs: <numbers or URLs>
- Decision records: <path>
- Specs, plans and design docs: <path>
- Memory: <the relevant memory entries, if the harness keeps any>
- Agent instructions: <the relevant AGENTS.md or CLAUDE.md files>
- Key anchors: <the two or three files the next agent will actually touch,
  with lines where it helps>

## Suggested skills

<Which skills the next agent should reach for, and why, in one clause each. For
example: "`grill-me`, the plan still has an open fork";
"`first-principles-investigation`, the failure is still unexplained";
"`decision-record`, the pricing call is settled and needs writing down".>

## Done-bar

<How the next agent will know the work is actually complete: the checks that
must pass, a document sent, a decision recorded, a smoke step specific to this
work.>
```
