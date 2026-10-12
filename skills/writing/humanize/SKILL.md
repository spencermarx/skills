---
name: humanize
description: >-
  Rewrites existing text so it reads as a person wrote it: profiles cadence and AI tells,
  rewrites by tier, then checks it blind. Use whenever someone says humanize this, make it
  sound human, make it sound like me, match my voice, de-AI it, this reads like ChatGPT, or
  a detector flagged it. Do NOT use to draft a piece from nothing (use
  `gather-argument-material`), to review copy for conversion (use `seven-copy-critics`,
  after this), or for an internal working surface (use `conveying-clearly`).
license: MIT
compatibility: The profiler needs python3 (standard library only).
argument-hint: '[path to the draft]'
metadata:
  credits: "Tell catalogs adapted from Sergey Bulaev's linkedin-humanizer, https://github.com/sergebulaev/linkedin-skills (MIT)"
---

# humanize

Text reads as machine-written for reasons that can be named, and each reason has
its own remedy. This skill names them, fixes them, and then checks the fix with
readers who never saw the original.

It never claims a detection score. Nothing here was calibrated against a labelled
corpus, and a percentage nobody can defend is worse than no number, because it
gets believed. What it produces instead is a rewrite, the observed reasons for
every change, and the tells left standing.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`): house rules. Default:
  none. If one is configured, read any voice, tone, brand-voice or
  writing-standards document in it before step 3, and look for a
  `humanize-tells.json` overlay and for a voice sample or profile for the
  author. What it bars outright becomes the `house` tier; where it is stricter
  or more specific than this skill, it wins. With none, the `house` tier has no
  members and everything else runs unchanged.
- **Scratch folder** (`docs/agents/workspace.md`): where a pasted draft, its
  samples and the rewrite are written. Default: `.scratchpad/` at the repository
  root, git-ignored.

## The one rule that outranks the rest

**Invent nothing.** Not a number, a date, a name, an anecdote, an opinion, a
sensory detail, or a hesitation. Prose sounds human because it is specific and
because it is somebody's, never because noise was sprinkled into it. Where a pass
below calls for a specific that the source does not contain, ask the author for
it and leave a marked gap until they answer.

This is the line between rewriting and forgery, and it holds hardest where the
text carries a customer claim, a metric, or a person's name. What the source
asserts is the ceiling: humanizing may cut a claim, never add one.

## Tiers

A tell's tier says what happens to it, not how hard it fires. Full taxonomy and
the reasoning: [references/tiers.md](references/tiers.md).

| Tier | Handling |
|---|---|
| `house` | Barred outright by the conventions folder. Remove. Not a judgment call. Empty when no conventions folder bars anything. |
| `forensic` | Model leakage or template residue. No human writes it. Remove. |
| `strict` | Machine-associated and bad style anyway. Rewrite, and say what changed. |
| `aesthetic` | Machine-associated but normal in good writing. Report, decide in context, usually keep. |

Default run applies `house` + `forensic` + `strict`. Aesthetic tells are reported
and left alone unless the user asks for a full sweep, which is a decision they
make about this draft and not a flag on the script. Sweeping the aesthetic tier
is what flattens good prose into the same beige as the thing you were fixing.

## Procedure

### 1. Establish the author and the baseline

Ask who the text goes out as, and get 2 or 3 samples of their real writing.
Without a baseline this skill measures the draft against nothing.
[references/voice-baseline.md](references/voice-baseline.md) covers where samples
come from (what the user points to, the conventions folder, their sent mail,
their published writing), the optional voice profile, and what to do when there
are none.

Then read the conventions folder, if one is configured, and list its house
rules: each outright bar becomes a `house` tell for this run.

Ends when: you can name the author, either hold sample text or have recorded
that none exists, and know whether this run has house rules and an overlay.

### 2. Measure

The script takes files. When the draft arrived as a paste in the conversation,
write it to a working file first, with the author's samples beside it: load the
`scratchpad` skill (through your skill tool, `/scratchpad`, or by reading its
SKILL.md) and run its `new writing '<slug>'` verb, by the absolute script path
that skill describes and with the configured scratch folder if it is not the
default, then write inside the directory it printed. If `scratchpad` is not installed, create
`<scratch folder>/writing/<UTC-YYYYMMDD-HHMMSS>-<slug>/` at the top of the main
checkout and make sure git ignores the scratch folder.

```bash
python3 '<skill dir>/scripts/cadence.py' DRAFT --baseline SAMPLE [--baseline SAMPLE] \
  [--overlay '<conventions folder>/humanize-tells.json']
```

Pass `--overlay` only when that file exists. If `python3` is not available, tell
the user and offer to install it, showing the exact command for their system;
install only after they confirm. Until then, skip the numbers and work the tiers
by reading [scripts/tells.json](scripts/tells.json) against the draft, and say in
the report that nothing was counted.

What each half of the mask reads, how overlays and `preserve` work, and why a
document about tells reports tells are in [scripts/README.md](scripts/README.md).

Read the tier counts and the rhythm table. The comparison rows carry the signal:
a draft whose sentence-length variation is half the author's is uniform in a way
readers feel before they can say why.

Ends when: you have the profile and can name the three largest gaps against the
baseline.

### 3. Rewrite, in three passes

**CUT.** Remove every `house` and `forensic` hit, the house rules the script
cannot count included. Rewrite every `strict` hit, using the `Try` column as a
starting point rather than a substitution table. Delete whole sentences where
the tell was the sentence: a cutoff disclaimer, a closing restatement, an
engagement-bait question.

**BREAK.** Fix the rhythm toward the author's own numbers, not toward a target.
Where sentence lengths cluster, split some and join others. Vary how sentences
open. Let paragraph lengths differ. A fragment is allowed where the author uses
fragments.

**GROUND.** Replace vague quantity with the specific the source already contains.
"Significant growth" becomes the actual figure when the source has it, and
becomes a question to the author when it does not. Concreteness is what the
reader registers as human, and it is the one pass that cannot be faked.

Ends when: a re-run of step 2 shows zero `house` and `forensic` hits, a read
against the prose-only house rules finds none either, and the rhythm has moved
toward the baseline. Read a hit before obeying it: where the draft **quotes** a
tell rather than using it, or carries the character inside code the mask did not
catch, the gate is wrong and the document is right. Deleting it is the damage:
[scripts/README.md § A document about tells contains tells](scripts/README.md#a-document-about-tells-contains-tells).

### 4. Read it blind

Five lenses, each with its own reader built from
[references/reader.md](references/reader.md) and the brief in
[references/reader-panel.md](references/reader-panel.md). Paste every text into
the prompt: a reader is given no path and reads no file, because a reader who can
reach the draft it came from cannot judge the rewrite cold.

If you can dispatch subagents, send the five prompts to five fresh subagents in
parallel, ideally with no file or tool access. Otherwise read them yourself in
the order and isolation the panel file sets out (the rewrite alone first, the
original last), and say in the report which lenses were a self-read.

What each lens receives is not uniform, and the difference is the point:

| Lens | Gets |
|---|---|
| 1 forensic, 2 register, 3 cadence | the rewrite and its brief |
| 4 voice | the rewrite and the author's samples (and profile, if any). Skip it when there are none |
| 5 fact integrity | the rewrite and the original. The only lens that sees both |

Lens 5 is the one that catches this skill inventing things, which is why it is
the one exception worth the contamination.

Ends when: every lens has reported or been recorded as skipped, and every finding
is either fixed or recorded as accepted with a reason.

### 5. Report

Return, in this order: the rewritten text in a fenced block; a table of what
changed and which tell drove it; the tells deliberately left standing and why;
which house rules applied and where they came from; which reader lenses were
fresh and which a self-read; and any gap awaiting an answer from the author.

Never report a percentage, a confidence label, or a detector verdict.

## When the draft is already the author's

Say what you found and stop. A person's own writing is allowed to contain
`robust`, a rule of three, and a passive clause, and rewriting it toward a
statistical profile replaces their voice with nobody's. Report the `house` and
`forensic` hits, which are defects at any authorship, and leave the rest as
observations.

## Composition

Load each skill below by name (through your skill tool, `/<name>`, or by reading
its SKILL.md); where one is not installed, say so and skip that step.

- This skill rewrites text that already exists. Where there is no draft yet, the
  piece is built by `draft-argued-piece` from a pile of material (or by
  `draft-conversion-copy` for an ask), and comes here once it does exist.
- **Register decides which contract applies.** Prose published under a person's
  name, an essay, a post, a newsletter issue, is this skill's.
  `conveying-clearly` governs a working surface a colleague reads once and acts
  on, and prescribes there the uniform short-sentence profile this skill treats
  as a machine tell in published prose. Neither overrides the other; the surface
  being written picks one.
- Outward-facing copy takes its register from the brand voice, where the
  repository keeps one: the conventions folder's brand-voice document, or the
  `get-brand-kit` skill's voice-and-tone guidance when it is installed. Read it
  before rewriting anything a reader outside the organisation will see.
- Conversion, hooks and offer strength are not this skill's job. That review is
  `seven-copy-critics`, and it runs after this one, on the rewritten text.
