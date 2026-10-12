---
name: draft-argued-piece
description: >-
  Drafts a piece block by block from existing material: settles the thesis, then grows the
  argument in the order the reader needs it. Use when a pile exists and someone says write
  the blog post, draft the essay, turn these notes into an article, the newsletter issue,
  whitepaper, guide, case study or talk script. Do NOT use with nothing written (use
  `gather-argument-material`), for a cold email or landing page (use
  `draft-conversion-copy`), or to settle a decision (use `grill-me`).
license: MIT
argument-hint: '[path to the pile]'
metadata:
  credits: "Adapted from Matt Pocock's writing-shape and writing-beats skills, https://github.com/mattpocock/skills (MIT)"
---

# draft-argued-piece

The exploring is done and the pile is fixed. Commit to a structure, mine the pile
to fill it, and grow a separate piece one block at a time.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Scratch folder** (`docs/agents/workspace.md`): where the piece grows.
  Default: `.scratchpad/` at the repository root, git-ignored.
- **Conventions folder** (`docs/agents/workspace.md`): house rules. Default:
  none. See [House voice](#house-voice).

## The pile and the piece

**The pile** is any markdown of raw material, whatever produced it: fragments
from `gather-argument-material`, a meeting transcript, a research digest, an
existing scratch file, a wall of prose. **It is read-only here**, and every
write goes to the piece.

**The piece** is `piece.md` beside the pile, where the pile already sits in a
scratch entry. Otherwise open one: load the `scratchpad` skill (through your
skill tool, `/scratchpad`, or by reading its SKILL.md) and run its
`new writing '<topic>'` verb, by the absolute script path that skill describes
and with the configured scratch folder if it is not the default, then write
`piece.md` inside the directory it printed. One entry holds both, so the pair
stays together, and the name is fixed so a second run finds the first run's
work rather than starting beside it.

**If `scratchpad` is not installed**, create
`<scratch folder>/writing/<UTC-YYYYMMDD-HHMMSS>-<topic-slug>/` at the top of the
main checkout (the first path `git worktree list` prints), make sure git ignores
the scratch folder, and write `piece.md` there. Outside a git repository, or
where the user wants the piece elsewhere, ask once and keep the path.

A finished piece leaves scratch for wherever it is published (a blog's
repository, a newsletter tool, a social platform, an email). It is not
committed to this repository unless the user asks.

## The loop

1. **Read the pile end to end** before anything else.
2. **Establish the prerequisites**: what the reader knows walking in. See
   [Grounding](#grounding).
3. **Offer 2 or 3 openings**, each implying a different thesis, and say what
   each grounds. The user picks or composes a hybrid, and that opening defines
   what the rest must do. Show the candidates before writing anything to the
   piece.
4. **Grow block by block.** Ask "given what stands, what does the reader need to
   hear next?", pull from the pile to answer, and argue the form the block takes.
   Offer 2 or 3 reachable candidates every time, not just at the opening:
   different directions the piece could pivot to from where it stands, each
   with what it grounds and what it would unlock a little way down the path. The
   user picks, you write only the pick, then offer the next set.
5. **Append immediately.** One block per write, never batching and never writing
   ahead. Re-read the piece from disk first, because the user edits between
   turns, and preserve their edits absolutely. Where the user has substantially
   reworked an earlier block, let that change what comes next. Where a block
   wants rewriting, edit that block in place and leave the rest alone.
6. **Loop 4 to 5 until the user says it is done.**

**Appending from an isolated session.** Where your file-editing tools are
refused against the main checkout, append to the file this skill created in its
scratch entry, `piece.md`, with a plain shell redirect against its absolute path,
and write no other file that way. Such isolation fences the file-editing tools,
not the shell, and a move-once helper such as `scratchpad`'s `place` refuses to
overwrite, so it cannot serve a file that grows every turn.

## What a block is

A block is one move: it sets a scene, lands a point, asks a question, drops an
aside, or twists the angle, then stops where the next block can pivot. Size it by
what the move needs: one sentence ("And then nothing happened for three weeks."),
a short paragraph with setup, or several paragraphs for a self-contained
vignette, argument or example. A block that wants five paragraphs and three
subheadings is two blocks glued together. Split it.

## Grounding

Every **concept** has to be **grounded** before a block leans on it: the reader
either walked in knowing it or met it in an earlier block. A block reaching for
an ungrounded concept loses the reader, and wastes every block after it. The unit
is the concept, not the word for it, so a block can lean on an idea the reader
lacks with no jargon in sight. Where a concept has a name, grounding it lands the
idea and the name together.

A concept gets grounded one of two ways:

- **Prerequisite.** Grounded before the opening. The reader brings it, and it is
  fixed at the start.
- **Introduced.** A block establishes it, and it stays grounded for the rest of
  the piece.

**Grounding is a graph rather than a list.** Each block requires concepts already
grounded and grounds new ones. A block is offerable only when everything it
leans on is already grounded, and grounding a concept unlocks every block that
was waiting on it. Keep the grounded set running, update it as each block lands,
and say what each candidate grounds so the user sees which paths it opens.

An ungrounded concept the next move needs is itself the answer to what the reader
needs next. That is the lever, and it has two settings. Ground it in a block,
which is the loop's own move. Or promote it to a prerequisite, which changes what
the reader is assumed to bring and so re-enters step 2, taking step 3 with it; say
that out loud, because it revises blocks already written. Demand too much up
front and you shut readers out; ground too much inside and the opening drowns in
definitions.

## Pulling from the pile

The pile is a quarry, not a script. Pull a fragment, rework it to fit its
surroundings, and place it. A fragment may be split across blocks, merged with
another, or paraphrased: the pile's job is to be mined, the piece's is to read as
one voice.

Where the piece needs something the pile lacks, **name the gap out loud**: "this
needs an example and the pile has none. Give me one now or the section goes."
Mining for new material beyond that is `gather-argument-material`'s job.

The piece ends when the argument is complete, not when the pile is empty. Most
piles leave fragments unused; that is the point of gathering more than you need.

## Format arguments to have out loud

- **Prose against list.** Prose carries argument, lists carry parallel items. If
  the items are not truly parallel, prose is better; if they are, a list scans
  faster.
- **Inline against callout.** A tip or warning earns a callout (`> [!TIP]`,
  `> [!NOTE]`) only where it would genuinely derail the argument inline.
- **Table against repeated structure.** The same shape with the same fields three
  or more times is a table. Otherwise prose with bold leads.
- **Quote against paraphrase.** Quote where the original wording is the point.
- **Code block against inline code.** Multi-line, runnable or illustrative code
  is a block; a single token or identifier stays inline.

## Push back

A block that does not earn its place gets cut. Keep asking:

- "What does this block do for the reader that the last one did not?"
- "If I cut this, what breaks?"
- "This sentence is doing two jobs. Split it or pick one."
- "The opening promised X and we drifted to Y. Re-thread it or change the
  opening."

## House voice

A draft growing in the scratch folder sits outside anything that would apply the
repository's writing rules for you, so apply them yourself. At the opening,
check the conventions folder: if one is configured and holds a voice, tone or
writing-standards document, read it then and hold it for every block after;
where it is stricter or more specific than this skill, it wins. With no
conventions folder, or none of those documents in it, write plain, direct prose
and add no house style of your own.

## Composition

In order after this skill, where installed: `humanize` for voice,
`seven-copy-critics` for hostile readers, `brand-review` for any creative around
it. The pile comes from `gather-argument-material`. Sideways, a finished piece
worth a visual write-up goes to `create-report`. Load each by name (through your
skill tool, `/<name>`, or by reading its SKILL.md); where one is not installed,
say so and skip that step.

## Out of scope

- **A piece with no argument to sequence.** A cold email is an ask, a landing
  page is message hierarchy, and grounding has nothing to bite on either way.
  That is `draft-conversion-copy`, which drafts the ask directly and then hands
  to `seven-copy-critics`. The boundary is the argument, never the length: a
  600-word essay is in, a 600-word landing page out.
- **Editing the pile.** It is read-only here.
- **Publishing, platform formatting, or frontmatter nobody asked for.**
