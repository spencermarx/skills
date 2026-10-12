# Text that outlives the session

The contract in `SKILL.md` applies hardest to anything a future session
inherits: resolution comments, wayfinder map gists and Decisions-so-far, handoff
documents, issue bodies and triage notes, decision records, change proposals, PR
descriptions, memory files.

Two things make these the highest-risk surface. They are written at the most
jargon-saturated moment of a session - right after the work - and they become the
canonical text later sessions read as shared language. A cryptic answer does not
just confuse one reader; it teaches the next session to re-offend in the same
dialect.

So: lead with the decision, give the why as consequences, name what follows -
and ground every term as if the reader has no access to this session at all,
because they don't.

## Glossing: promote or drop

- **Gloss inline at first use** - "the claim short-circuit (the check that skips
  permission resolution while an org is unclaimed)". One plain parenthetical;
  after that the term is defined-right-here for the rest of the surface.
- **Drop by default.** Most coinages are session compression. In anything a human
  or a persisted artifact will read, expand them back to plain words.
- **Promote rarely.** A coinage that names a durable domain concept the humans
  themselves speak graduates into the project's glossary - only through the
  `domain-modeling` skill's significance bar, with the user's assent. Never add
  shorthand to the glossary to dodge glossing; that corrupts the ubiquitous
  language instead of speaking it.

## Wayfinder artifacts

Gloss at first use in tickets and resolution comments. A coined term that
**recurs across tickets** earns one plain line in the map's **Working
vocabulary** section (see the `wayfinder` skill), so its translation travels with
the term into inheriting sessions; one-shot coinages never land there. Entries
retire with their term, and a term promoted into the glossary leaves the map.
