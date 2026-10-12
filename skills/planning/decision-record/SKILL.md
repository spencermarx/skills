---
name: decision-record
description: >-
  Record a settled choice and its reasoning as a decision record (ADR) so nobody
  relitigates it. PROPOSE one for a precedent-setting, hard-to-reverse or surprising
  decision, then stop: only the user's yes creates one. Trigger on "write an ADR",
  "add an ADR", "record this decision", "write this down", "document this decision",
  "supersede that decision", "amend that record", "that ADR is wrong", "why did we
  choose", or an "X vs Y" choice that just settled. Do NOT use for a choice you could
  undo in an afternoon, to park work for later, or for work not yet decided (use
  `wayfinder` or `grill-me`).
metadata:
  credits: "Significance examples partly adapted from Matt Pocock's domain-modeling skill, https://github.com/mattpocock/skills (MIT)"
---

# Decision record

A decision record (often called an ADR, architecture decision record) holds a
settled choice **and its reasoning**, so the same debate is not reopened in six
months by someone who only has the conclusion.

The reasoning is the point. A record that states what was decided without saying
what was rejected and why is a note, not a record, and it will not survive
contact with the first person who disagrees.

## Stop: you need a yes first

**You may propose a record. You may not create one without an explicit yes from
the user in this session.**

Proposing is one line. State the claim the record would make, and stop:

> That's a decision: "vendored skills are plain files, not plugins". Record it?

Then wait. Do not draft the file, do not reserve a number, do not write it and
offer to remove it afterwards. The user moving on to something else is not a
yes, and neither is silence.

The reverse holds too: a user who says "write that up" or "add an ADR for this"
has confirmed, and you should not ask twice.

A register is only worth keeping while it stays short enough to read end to
end. A record written because a heuristic fired is a record nobody chose to
keep, and forty of those bury the four decisions that mattered.

Everything below this section is what to do **after** you have a yes.

## Does it qualify?

Write one when the choice is:

- **Precedent-setting.** It sets a pattern, standard, boundary or structure
  that future work is expected to follow. State the rule plainly in
  **Decision**.
- **Hard to reverse.** Undoing it means unwinding work, a data migration, a
  published contract, lock-in, or a conversation with someone outside the
  team. Spell out that cost in **Consequences**.
- **Surprising given its trade-off.** A reader who knows the constraints would
  guess differently and might "fix" it, and there were genuine alternatives.
  Name the rejected alternative in **Alternatives considered**.

Two of three is a clear yes. One is a judgment call, and a judgment call is a
thing to raise with the user rather than resolve alone. None is not a record:
a one-off, the obvious path with no real alternative, a preference nobody will
relitigate.

The kinds that typically qualify:

- **Architectural shape.** "The write model is event-sourced; the read model is
  projected into Postgres."
- **Code-level pattern or convention.** Discriminated unions over inheritance,
  validation at every boundary, an error-handling rule.
- **File or directory organization.** Where a kind of file lives, what a folder
  is for.
- **Integration patterns between parts of the system.** "Ordering and Billing
  communicate via domain events, not synchronous HTTP."
- **A chosen library, tool or runtime that carries lock-in**, and the
  alternative you rejected. Not every library: the ones that would take a
  quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer
  context; others reference it by id only." The explicit no's are as valuable
  as the yes's.
- **Deliberate deviations from the obvious path.** "Manual SQL instead of an
  ORM because X." These stop the next engineer from "fixing" something
  deliberate.
- **Constraints not visible in the code.** "No AWS, for compliance reasons."
- **A way of working.** A workflow or authoring rule with no runtime footprint
  is a first-class decision too.

A change to the repository's written conventions is a strong signal and a good
reason to **propose** a record. It is not a trigger that writes one.

**One decision per record.** If you are tempted to write "and also…", that is
a second record. Splitting keeps each one citable on its own and keeps the
supersession history clean.

## Where it goes

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

`docs/agents/domain.md` names the decision-record folder. Default: `docs/adr/`
at the repository root, plus `docs/adr/` inside a context's folder for a
decision that concerns only that context, where the repository has several.
Create the folder when the first record needs it.

**Naming.** If the folder already holds records, follow their naming scheme.
For a new folder, name records by date and claim:

`YYYY-MM-DD-<kebab-slug>.md`

- **Dated, not numbered.** Take the date from the clock, never by hand.
- **The slug reads as a claim**, not a topic:
  `2026-08-19-price-by-outcome-not-hours.md`, never `2026-08-19-pricing.md`.
  A topic name forces a future reader to open the file to learn whether it is
  relevant.

Build the path from the system date, in the shell:

```bash
dir="docs/adr"   # or the folder docs/agents/domain.md names
mkdir -p "$dir"
echo "$dir/$(date +%F)-<slug>.md"
```

Why dated rather than numbered: a sequence needs allocation, and allocation
needs a single writer. Two people each counting the folder both take `0006`;
because their slugs differ, the two files merge cleanly and silently, leaving
two 0006 records and no warning. A date needs no allocation. Two records on the
same day differ by slug; if they do not, the filenames collide, version control
reports it, and the conflict is correct, because the same decision was recorded
twice. Dates also sort chronologically and answer "was this still current when
X happened" from the filename.

## Writing it

If the folder's existing records have an established shape, match it. Otherwise
use this one:

```markdown
---
status: accepted
date: YYYY-MM-DD
---

# <The decision, stated as a claim>

## Context

Why now? What deadline, constraint, or trade-off forced this decision?

## Decision

One sentence, then the specifics.

## Alternatives considered

### <Option A>
- **Approach:**
- **Rejected because:**

### <Option B>
- **Approach:**
- **Rejected because:**

## Consequences

**Makes easier:**
-

**Makes harder:**
-

**Explicitly deferred:**
-
```

Four sections, in order.

**Context.** Why now? What deadline, constraint, or trade-off forced this? A
reader should understand the pressure before they see the answer. Do not state
the decision here.

**Decision.** One sentence, then the specifics. Name the actual thing and where
it lives. What does this mean concretely, what is the definition of done, and
how would you verify it held?

**Alternatives considered.** The section that earns the document. Each option
gets what it was and why it lost. If you cannot name a real alternative, you
probably have not made a decision, you have described the only available path.

**Consequences.** Three ways: what this makes easier, what it makes harder, and
what it explicitly defers. The middle one is the one people skip and the one
that is read most often later. A decision recorded with only its upside has not
found its cost yet: everything is a trade-off, and anything that looks like an
exception is one you have not found.

Keep it terse. Most records need fifteen to forty-five lines of body; resist
padding. If the folder has an index (a README table or similar), add the row.

## When one stops holding

Two routes, and **the user picks which**. Ask the user, using your
structured-question tool if you have one; otherwise list the two options
numbered in plain text and stop until they reply. Say which you would take and
why. Do not pick for them, and do not touch a record you were not asked to
change.

**Superseding**, when the decision itself changed. The new record carries the
argument that beat the old one, and the old reasoning stays true of the moment
it was made:

1. Set the old record's `status` to `superseded`, with a one-line pointer
   forward to its replacement.
2. Write the new record, with `supersedes` in its frontmatter naming the old
   one, and say in its Consequences what it replaces and why.
3. Update the folder's index, if it has one.

**Amending**, when the reasoning still stands and a line in the record is wrong
(a consequence that did not hold, a path that moved, a claim that was never
right). Superseding one of those files a second record whose only content is a
correction.

1. Edit the record so it reads as though it always said that. No "previously",
   no strikethrough, no note about the correction.
2. Update the index row if what changed reaches it.
3. Say in the commit message what was wrong and why the record was amended
   rather than superseded. That message is where the history now lives.

Neither route loses history: version control returns the former wording. What
a supersession buys over an amendment is legibility, the old record staying
visible without anyone digging through the log. That is worth a file when the
argument changed and worth nothing when a line was wrong.

## Citing one

Link a record wherever its conclusion is being relied on, so a reader who
disagrees finds the reasoning rather than arguing with the result:

```markdown
Rationale: [Orders are event-sourced](docs/adr/2026-08-27-orders-are-event-sourced.md).
```

Cross-reference related records inline. They are a web, not a list.

## Anti-patterns

- **Writing one without being asked.** The failure this skill guards hardest
  against. Creating the file and offering to delete it is the same defect with
  an extra step, and so is drafting it "so it's ready if you want it".
- **Letting a significant decision go unasked.** The inverse failure: a choice
  that clears the test passes without your proposing a record.
- **Recording the outcome without the alternatives.** The most common failure,
  and it makes the record worthless for its one purpose.
- **An all-upside Consequences section.** If nothing got harder, you have not
  found the real trade yet.
- **Writing a record for a reversible choice.** It dilutes the register until
  nobody reads it.
- **Two decisions in one record.** Split them so each stays citable.
- **Amending a record on your own judgment.** Whether a record is amended or
  superseded is the user's call, and a record edited without one asked for is a
  record nobody can trust to say what was agreed.
- **Editing a superseded record** so it agrees with current practice. It was
  kept to hold the reasoning of its own moment; rewriting it empties the file of
  the only thing it is still there for.
- **A slug that names a topic rather than a claim.** `2026-08-19-pricing.md`
  tells a future reader nothing.
- **Deferring the record until the work is done.** Raise it when the decision is
  made, while the alternatives are still in someone's head. Waiting for the yes
  is the rule; waiting a fortnight to ask is not.
