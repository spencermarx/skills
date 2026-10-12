# Scope

What belongs in this catalog, so a proposal can be judged against something
written down rather than taste.

## A skill belongs here when

1. **It answers an observed failure.** Someone watched an agent get a real task
   wrong, or take far too long, and the skill is what fixed it. Name the session
   or the task in the proposal.
2. **It is a method, not a product.** It teaches an agent how to do a kind of
   work (interview a plan, investigate a failure, record a decision), not how
   to drive one vendor's API. Vendor skills belong with the vendor.
3. **It works in any repository.** Where it needs to know a repository's
   layout, it reads `docs/agents/` and states defaults. A skill that only makes
   sense inside one organisation's folders is that organisation's skill.
4. **It works in any harness.** It follows the portability contract in
   `AGENTS.md`. A Claude Code feature may sharpen it, never carry it.
5. **It earns its context.** Its description is loaded in every session of
   everyone who installs the catalog. A skill that fires rarely and would be
   just as good as a paragraph in someone's own instructions file is a paragraph.

## Out of scope

- Wrappers around a single vendor's CLI or API.
- Integrations that need credentials to do anything.
- Skills whose value is a house style (voice, brand, folder conventions).
- Duplicates of a skill in a well-maintained public catalog. Credit and point
  to it instead.

Rejected proposals are recorded in [`.out-of-scope/`](.out-of-scope/), one note
each, so the same request can be answered with a link.
