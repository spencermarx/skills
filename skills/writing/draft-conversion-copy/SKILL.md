---
name: draft-conversion-copy
description: >-
  Drafts conversion copy, where the piece is an ask not an argument: cold outbound email
  and sequences, landing or services page copy, ads, a short promotional social post. Use
  when someone says write the cold email, the outreach, the landing page, the ad, or the
  launch post. Do NOT use for a piece that argues in order (use `draft-argued-piece`, or
  `gather-argument-material` when nothing is written yet), or to review drafted copy (use
  `seven-copy-critics`).
license: MIT
argument-hint: '[the form: cold email, sequence, landing page, ad, post]'
---

# draft-conversion-copy

Conversion copy is an ask, not an argument. A cold email lives or dies on the
hook and the one specific reason this reader should care; a landing page is
message hierarchy. Neither is a sequence the reader follows block by block, so
`draft-argued-piece`'s machinery (grounding, candidate openings, the format
arguments) has nothing to bite on here. This skill drafts the ask directly.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`): house rules. Default:
  none. If one is configured and holds a voice, tone, brand-voice or
  writing-standards document, read it before you draft and obey it; where it is
  stricter or more specific than this skill, it wins. With none, write plain,
  direct copy and add no house style of your own.
- **Scratch folder** (`docs/agents/workspace.md`): where a longer draft lives.
  Default: `.scratchpad/` at the repository root, git-ignored.

## Fix the frame before writing a word

Conversion copy with a vague frame converts nothing. Settle all four, and where
any is missing ask the user rather than guessing, using your structured-question
tool if you have one; otherwise list the open points numbered in plain text and
stop until they reply.

1. **Who, exactly.** A specific person, role and situation: the head of
   operations at a forty-person logistics firm whose dispatch still runs on a
   shared spreadsheet, not "operations leaders". Copy to everyone reaches no one.
2. **The one action.** Reply, book twenty minutes, click, sign up. One ask, and
   the lowest-friction version of it.
3. **The channel and format.** Cold email, a sequence, a services page, an ad,
   a launch post. The shape follows from this.
4. **The one specific reason this reader acts now.** Not the feature list: the
   single thing that makes *this* reader, today, care. If you cannot name it,
   the copy is not ready and no rewrite fixes that.

## Draft to the form

Every form leads with the reader's dream outcome and explains the mechanism
only after. Hold the house voice from the conventions folder throughout, where
one is configured; conversion copy is outward-facing, so any rule there about
how the organisation speaks to outsiders applies in full.

- **Cold email.** A hook that earns the second line, the one specific reason
  this reader should care, and one small ask. No recap of the recipient's own
  business. Signed by a person; the sender is not the author.
- **Cold sequence.** Each send carries one new angle on the same ask, never a
  restated version of the last. The final send makes leaving easy.
- **Landing or services page.** Message hierarchy: a headline that names the
  dream outcome, a subhead that says the mechanism in one line, then sections
  where each earns its place, and one primary call to action repeated where the
  reader is ready to act.
- **Ad or short social post.** One idea, a hook on the first line, one call to
  action. If it argues, it is the wrong form (see [Out of scope](#out-of-scope)).

## Cut to the ask

Read the draft back as the reader on a bad day. Every line either moves them
toward the one action or gets cut. Tighter, not bigger. Then hand it on in the
order [Composition](#composition) sets.

## Where the draft lives

Short copy stays in the conversation. For a page, a sequence, or copy revised
across sessions, open a scratch entry so revisions survive: load the
`scratchpad` skill (through your skill tool, `/scratchpad`, or by reading its
SKILL.md) and run its `new writing '<slug>'` verb, by the absolute script path
that skill describes and with the configured scratch folder if it is not the
default, then write the draft inside the directory it printed. If `scratchpad`
is not installed, create `<scratch folder>/writing/<UTC-YYYYMMDD-HHMMSS>-<slug>/`
at the top of the main checkout and make sure git ignores the scratch folder.

A finished piece leaves scratch for wherever it is sent or published (the mail
client, the site's repository, the ad platform). It is not committed to this
repository unless the user asks.

## Composition

In order after this skill, where installed: `humanize` to strip AI tells, then
`seven-copy-critics` for the seven hostile readers. A visual asset around the
copy goes to `brand-review`. Load each by name (through your skill tool,
`/<name>`, or by reading its SKILL.md); where one is not installed, say so and
skip that step.

## Out of scope

- **A piece that argues something the reader follows in order**: an essay,
  newsletter, guide, case study or a long social post that makes a case. That is
  `draft-argued-piece` when a pile of material exists, and
  `gather-argument-material` when nothing is written yet. The boundary is
  whether there is an argument to sequence, never length: a 600-word landing
  page is in, a 600-word essay is out.
- **Reviewing copy that already exists.** A hostile read of a draft is
  `seven-copy-critics`; this skill writes the draft it reviews.
- **Grounding, candidate openings, block-by-block sequencing, or a
  format-argument menu.** Those serve an argument, and an ask has none.
