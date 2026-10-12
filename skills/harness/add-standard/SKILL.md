---
name: add-standard
description: >-
  Turn one convention someone said out loud into a stated, routed standard in the
  repository's conventions folder: triages that it is a standard at all, drafts the
  section with the user, then hands the siting and routing to `standards`. Use whenever
  someone says we should always X, we should never Y, write this convention down, make this
  a rule, add this to our standards, or that belongs in the house rules. Do NOT use to
  change, move, retire or audit an existing standard (use `standards`), to author a skill
  (use `skill-builder`), or for the craft of agent-facing prose (use `writing-for-agents`).
license: MIT
argument-hint: '[the convention, e.g. "every migration is reversible"]'
---

# Add a standard

In: one sentence someone said out loud. Out: one `##` section in the document
that owns the subject, reached the way the repository reaches its conventions,
with nothing anywhere restating it.

This skill is the front door, and it covers the two steps before the mechanics:
deciding the sentence is a standard, and turning it into a section worth
stating. Everything from there (siting, routing, and the validator that proves
the change landed whole) belongs to the `standards` skill. Follow that skill
rather than any account of it, here or elsewhere.

Paths below are relative to this skill's directory; resolve them to absolute
paths before reading anything.

`standards` is required. If it is not installed, say so and stop: a section
written without its routing is the silent drift that skill exists to prevent.

## Step 1: is it a standard at all?

The most common failure is not a badly written standard. It is a fact, a
preference, or a procedure written into the conventions folder because someone
reached for the nearest formal-looking home.

| What you actually have | Where it belongs |
|---|---|
| "when touching Y, always X", and you can name the file an agent has open when it applies | a standard: continue below |
| something true only inside one folder | that folder's instructions file (`AGENTS.md` there, or the harness's equivalent) |
| a multi-step procedure somebody repeats | a skill: load `skill-builder` |
| a settled choice whose reasoning must outlive it | a decision record: the `decision-record` skill when installed, else the decision folder (`docs/agents/domain.md`, default `docs/adr/`) |
| a preference nobody has agreed to yet | back to the user, unwritten |

A standard also needs a file an agent will have open at the moment the
obligation fires. Name that file now, before drafting. If the repository has a
routing layer, that file decides whether the section ends up routed by a rule or
declared unrouted with a named consumer, and it changes what you write;
`standards` explains the choice.

## Step 2: draft the section

Work from the user's sentence to a heading and a body before touching any file.
What to interrogate, and how to name a heading nobody will want to rename:
[references/drafting-a-section.md](references/drafting-a-section.md). Read it
now.

Show the user the draft. A standard binds every future session, so it is theirs
to approve, not yours to land. Ask the user, using your structured-question tool
if you have one; otherwise show the draft, list the choices numbered in plain
text (approve, change, drop), and stop until they reply.

## Step 3: hand the draft to `standards`

Load the `standards` skill (through your skill tool, `/standards`, or by reading
its SKILL.md) and work its "Stating a new convention" section start to finish
with your draft in hand. It owns the conventions folder (including proposing one
when the repository has none), the search for an existing statement, the choice
of document, the choice between a rule pointer and an unrouted declaration, and
the validator.

If the search finds the convention already stated, you are changing a standard
rather than adding one. Stop here and follow that skill's "Changing one"
section, which carries the obligations an edit incurs and this skill does not.

## Done

- The user has seen the draft and said yes.
- The sentence exists as exactly one `##` section, and you can say which
  document owns it and why that one.
- The `standards` skill's "Done" list is satisfied. That skill owns the
  completion criteria for the routing half, including the judgment that a clean
  validator run is evidence rather than authority.
- Nothing you wrote outside the conventions folder states the rule. A skill, an
  instructions file, or a guide may link to the section; the moment one
  paraphrases it, there are two statements and they will diverge.
