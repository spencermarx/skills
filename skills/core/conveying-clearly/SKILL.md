---
name: conveying-clearly
description: >-
  The contract for a working surface a colleague reads once and acts on: a statement, a
  question or option set, a verdict, a ticket or PR comment, a status update. Use BEFORE
  composing one; `wayfinder` loads it automatically. Also trigger the moment someone says
  please clarify, I don't understand the question, wait what, or I'm not following where
  you've got to. Do NOT use for prose published under a byline (an essay, post or
  newsletter), or to compact a session for a successor (use `handoff`).
license: MIT
metadata:
  credits: "The plain-language re-pitch is adapted from Matt Pocock's wait-what skill, https://github.com/mattpocock/skills (MIT)"
---

<!-- Rationale: the plain-language spine borrows from the "wait-what" skill in
     github.com/mattpocock/skills (skills/productivity/wait-what): give a little
     context, write ASD-STE100 Simplified Technical English, speak the project's
     ubiquitous language. Upstream is a one-line re-pitch prompt a human fires
     after a message lands badly; here that becomes one move inside a standing
     contract ("When it lands badly"). Two of STE's rules are deliberately not
     carried over: its ~900-word approved dictionary (the three vocabulary
     buckets are the equivalent, and they admit the project's own domain
     language) and its blanket ban on the passive. -->

# Conveying clearly

A statement, a question, an option set, a verdict, a resolution comment, a PR
description, a handoff, a map gist - one act: **surfacing something to a reader
who did not watch this session.** The shorthand you coined while reading code,
issues, and memory feels canonical to you and means nothing to them. That
asymmetry is invisible from the inside - a surface is always clear to its
author - so the fix is never to dumb the content down. Ground the vocabulary,
write plainly, lead with the point.

## The register this governs

Every surface named above is one a colleague reads **once and acts on**. The
reader is deciding, not settling in, and the sentence craft below serves that.

**Prose published under a person's name is a different register.** An essay, a
post, a newsletter issue is read by a stranger under no obligation to keep
reading, and there the uniform short-sentence profile this contract prescribes
reads as machine-written. Published prose wants varied rhythm and a voice; this
contract does not govern it. Neither register outranks the other; the surface
being written picks one.

## The reader test

Compose for a teammate who stepped away before this session started and reads
only what you are sending now. If acting on it - or trusting it - takes having
watched your exploration, the surface fails. Rewrite it before sending; do not
wait for "please clarify."

## Lead with the point

One shape serves every surface:

1. **A line or two of shared context** - what the reader needs, in their
   vocabulary. Not a replay of your reasoning; they are deciding, not auditing.
2. **The point** - the ask, the decision, the finding, the state - in one plain
   sentence, ahead of any elaboration. A point buried under recited findings has
   already failed the reader test.
3. **The why, as consequences** - what taking it gets them, what it trades away.
4. **What follows** - what it unblocks, invalidates, or commits to.

## Ground every term

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Glossary:** the file `docs/agents/domain.md` names. Default: `GLOSSARY.md`
  at the repository root, or, when a `GLOSSARY-MAP.md` exists there, the
  per-context glossary it points at. A repository with no glossary simply has an
  empty bucket 2.

Every load-bearing term belongs to one of three buckets:

1. **Everyday technical vocabulary** - read without a glossary by any working
   engineer (schema, migration, endpoint, rate limit).
2. **Ubiquitous language** - defined in the project's glossary. Use these freely
   and by preference, and never re-define them inline: **define the private,
   assume the shared.**
3. **Glossed right here** - at first use, in the surface the reader sees: "the
   claim short-circuit (the check that skips permission resolution while an org
   is unclaimed)".

Shorthand coined this session - by you, an inherited map gist, a ticket, a memory
file - is **never automatically bucket 1**, however settled it feels. Gloss it,
expand it, or drop it. A term that fits no bucket means you do not yet understand
the thing well enough to surface it; translate first.

**No bare issue numbers as nouns.** The citation rides in parentheses, never as a
subject or object: "the rule that agents can never provision organizations
(#69)" passes; "#93 tracks the resets" fails, because the number is doing a
noun's job.

## Write plainly

Sentence craft, in the spirit of **ASD-STE100 Simplified Technical English**:

- One idea per sentence; roughly 20 words for an instruction, 25 for a
  description.
- Active voice, simple present: "the migration drops the column". (The passive
  is fine where the actor is genuinely unknown or irrelevant.)
- One term per meaning. A synonym reads as a second, different thing.
- No orphan "it" / "this" / "that" - name the thing again.
- No noun stacks: "agent permission grant scope resolver" is not a phrase.

## Give reasons, not authority

"Board unanimous 4-0", "per the ratified ruling", "as decided" justify nothing to
a reader who was not there. Say what happens if the recommendation is taken, and
what is given up.

Reasons do not replace **marking** your lean. Where the surface has a mark, use
it: in a structured-question picker the recommended option goes first and its
label ends with `(Recommended)`. A lean argued only in prose renders as no
recommendation at all. Holding no real lean, say so out loud - an unmarked list
reads as either "no recommendation" or "the marker got dropped". Never
manufacture a lean you do not hold.

## When it lands badly

"I don't understand the question." "Wait, what?" "I'm not following where
you've got to." The answer is to **re-pitch, not repeat** - shortening the same
jargon is the classic wrong move, because vocabulary rather than length is
usually what broke. Name which terms were private, then rebuild: a little shared
context, the point in one plain sentence, grounded words. A human can invoke
this skill by name (`/conveying-clearly`, or "re-pitch that") to demand exactly
that of the last message.

## Load when composing

- **[Option pickers](references/option-pickers.md)** - structured-question
  headers, labels, descriptions, previews, the recommendation marker, and a
  worked rewrite.
- **[Text that outlives the session](references/persisted-artifacts.md)** -
  resolution comments, map gists, handoffs, ticket bodies, decision records,
  memory files: glossing, promote-or-drop, and the wayfinder map's Working
  vocabulary.

## Before you send

- Every noun understandable to a teammate who missed this session?
- Every load-bearing term plain, in the glossary, or glossed right here?
- The point in one plain sentence, behind at most a line or two of context?
- Short active sentences, one idea each, one term per meaning, no orphan "this"?
- Every _why_ a consequence rather than an authority - and a real lean actually
  marked, or its absence stated out loud?
- Any bare `#NNN` doing a noun's job?
