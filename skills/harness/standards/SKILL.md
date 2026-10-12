---
name: standards
description: >-
  Route, change, move or retire a convention in a repository's conventions folder (its
  written house rules), keeping every pointer at it in step: the instructions file, the
  folder's index, and any harness rule files that load it when a matching file is touched.
  Use whenever you edit a convention, add or change a rule file that points at one, rename
  a heading something links to, or someone asks where does this belong, is this routed, or
  what enforces this. Always use before deleting a script or check that enforces a
  convention in code. A brand new convention starts at `add-standard`, which hands back
  here. Do NOT use to author a skill (use `skill-builder`) or to measure whether a skill
  fires (use `harness-eval`).
license: MIT
compatibility: The validator needs python3 and git, and runs in any harness.
---

# Standards

Every convention a repository writes down is stated once and reached one way.
This skill is how that stays true through a change.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Where things live

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`, the `Conventions folder`
  line): where the house rules are stated. Default: none.
- **Decision records** (`docs/agents/domain.md`): where settled choices are
  written down. Default: `docs/adr/`.
- **Instructions file:** `AGENTS.md` at the repository root, the file every
  harness loads in every session (some read `CLAUDE.md`, often a link to it).

### When no conventions folder is set

Look for one that already exists (`docs/standards/`,
`docs/engineering/standards/`, a root `CONVENTIONS.md`) and propose it;
otherwise propose `docs/standards/`. Ask the user, using your
structured-question tool if you have one; otherwise list numbered options in
plain text and stop until they reply. Create nothing before a yes. On yes:

1. Create the folder with a `README.md` index: a title, one line saying what
   the folder is, and a `## The documents` list.
2. Add one line to `AGENTS.md` naming the folder and its index.
3. Set the `Conventions folder` line in `docs/agents/workspace.md`. If that file
   does not exist, suggest running `setup-aclarify-skills`, and pass the folder
   to the validator with `--conventions` until then.

## The shape

Two layers always, a third optional.

1. **The statement.** One `##` section in one document in the conventions
   folder. This is the single source of truth. The folder's `README.md` is its
   index: it lists every document and what subject each owns. A single file
   (`CONVENTIONS.md`) works too, and is then both index and document.
2. **The always-loaded router.** `AGENTS.md` names the conventions folder, so
   every session in every harness knows the rules exist and where. It points;
   it never restates a convention.
3. **The routing layer, optional.** Rule files a harness loads on its own when
   a matching file is read: Claude Code's `.claude/rules/*.md` with a `paths:`
   glob, Cursor's `.cursor/rules/*.mdc` with `globs:`, and equivalents in other
   harnesses. Each rule is a pointer: a glob, a description, and a link to each
   section it routes, so the right section arrives at the moment the file it
   governs is open, instead of waiting for an agent to go and read the index.
   How to write one: [references/routing-rules.md](references/routing-rules.md).

Once a routing layer exists, every `##` section is reached one of two ways: a
rule routes it, or the index declares it under `## Intentionally unrouted`,
naming the consumer that reaches it instead (a skill, a template), and that
consumer **links** the section. A consumer that paraphrases it is a second
statement.

Adding a routing layer to a repository that has none is the user's call.
Propose it when the conventions have grown past what an agent reads from the
index unprompted. Route in each harness the repository's people use.

## Why this needs a procedure at all

Drift here is **silent**. Nothing reports at read time that a rule failed to
load, so a renamed heading, a mislabelled link, or a glob naming a folder that
was renamed simply stops routing, and the repository reads as healthy. There is
no failing test to notice and no error to search for. The only defence is doing
all of a change, and then running the validator.

## The validator

```bash
python3 scripts/validate-routing.py
python3 scripts/validate-routing.py --conventions docs/standards/ --rules path/to/more/rules
```

Run it from anywhere inside the repository; it finds the root with git and the
conventions folder from `docs/agents/workspace.md`, unless `--conventions` says
otherwise. It checks that every markdown link into the conventions resolves to
a real document and heading (from anywhere, the conventions' own documents
included), that a `doc § Section` label names the section it points at, that
`AGENTS.md` names the conventions and the index lists every document. With a
routing layer, it also checks that each pointer rule carries a glob and nothing
that loads it in every session, and that every section is routed or declared,
never both, with each declared section linked by a real consumer. `--rules DIR`
adds a folder of rules in Claude Code's or Cursor's format (`.mdc` files are read
as Cursor's); `--decisions DIR` adds a decision folder. Decision records are
history, so their links are never checked.

It reads the file list from git, so a git-ignored copy (a worktree, a scratch
note, a review session) can never vouch for a link the real tree lost. Exit 0
clean, 1 with findings printed one per line; exit 1 with nothing on stdout is a
precondition that could not be met, explained on stderr. Read both streams
before reading an empty result as a pass.

It does not check whether a glob reaches any file. If `harness-eval` is
installed, its glob check reports a Claude Code rule glob that matches nothing.

Run it on demand. It checks correctness, never taste, and it is not the
authority on whether the conventions are good. Whether to wire it into a hook
or CI is the user's decision, and only once it has been watched both catching a
real defect and staying quiet on a legitimate shape in this repository.

## Stating a new convention

1. **Check it is not already stated.** Search the conventions folder, then the
   instructions files and skills, for the term the convention is about. A
   second statement of an existing rule is the defect this whole layer exists
   to prevent, and it will not look like one while you are writing it.
2. **Write one `##` section** in the document that owns the subject, as the
   index lists them. If none owns it, raise that with the user, with both
   readings on the table (it belongs inside an existing document, or the
   repository has grown a concern nobody has named). Adding a document is
   theirs to decide; a new document goes in the index in the same change.
3. **Route it**, when a routing layer exists, by exactly one of:
   - **A rule pointer**, when a glob can name the file an agent has open when
     the obligation fires. Prefer adding a pointer line to an existing rule
     whose glob is already identical; create a rule only when the glob differs.
   - **A declaration** in the index's `## Intentionally unrouted`, when no glob
     can usefully fire. Name the consumer that reaches the section instead, and
     make that consumer link it.

   The choice is governed by
   [routing-rules.md § Glob the trigger, not the target](references/routing-rules.md#glob-the-trigger-not-the-target).
   Read it before writing a glob. It is the rule most often got backwards, and
   getting it backwards produces a routing layer that looks like it works.
4. **Run the validator.**

## Changing one

Two obligations, and only the first is the one people remember.

**A renamed heading** breaks every anchor aimed at it, and rewriting them is
part of the same change. Search for the slug across the whole repository, not
only the rules and the index: skills, instructions files, glossaries and
templates cite sections directly. The validator is a backstop, not the sweep. It
resolves markdown links, so a citation written any other way is invisible to it:
a backticked path, a wikilink, a link inside a code block. The search covers
those.

**Changed wording** obligates a sweep for consumers that restate the section
instead of linking it. Nothing gates this half, and nothing can: a restatement
is prose that agreed with the convention on the day it was written, and what
distinguishes it from prose that still agrees is meaning. Two searches find
them.

1. Search for the anchor, `<doc>.md#<slug>`, for the files that cite the
   section. Open each and check it points rather than paraphrases.
2. Search for the term the section is about. A restatement that never linked
   the section is invisible to the first search, and is the one that bites: it
   reads as settled local knowledge, so whoever meets it never learns that a
   convention exists to disagree with.

Both searches are line-oriented and prose is wrapped, so a phrase that falls
across a line break returns nothing. Flatten the whitespace before matching (in
Python, `re.sub(r'\s+', ' ', text)`), or the sweep reports clean on the file
that drifted furthest.

Routing is not coverage. A rule firing on a file does not stop that file from
carrying its own copy of what the rule points at, and the copy is the one read
first.

## Retiring one

Delete the section, then delete every pointer at it: rule lines, declarations,
consumer links. A rule left pointing at a deleted heading is worse than no rule,
because it reads as coverage.

If the convention is being retired rather than merely moved, that is usually a
decision worth recording. Propose it to the user; never create the record
without a yes. When the `decision-record` skill is installed, load it (through
your skill tool, `/decision-record`, or by reading its SKILL.md) to write it;
otherwise write a short file in the decision folder: a title stating the
decision, then the context, the decision, why, and the alternative rejected.

## Retiring a check that lived in code

The case this skill was built for. Deleting a linter rule, a generator or a
validation script usually deletes **the only statement of a convention**,
because nobody wrote down what the code was quietly enforcing.

Before the deletion lands: read what the code actually does, write each
convention it enforces as a `##` section, and route it. The deletion is a
separate commit that comes after. Reversing that order loses the convention with
no way to notice.

## Done

- The convention is stated in exactly one `##` section, in the document that
  owns its subject.
- `AGENTS.md` names the conventions folder, and the index lists the document.
- With a routing layer: it is routed by a rule, or declared unrouted with a
  consumer that links it.
- You have run `scripts/validate-routing.py` and resolved or explained every
  finding.
- No file restates the section, whether or not it links it.

The fourth is deliberately not "the script exits 0". A clean exit is evidence,
not authority: the user decides whether a change is right, and a finding you can
explain is a finding you may leave. Making the script the completion criterion
reads as harmless right up until someone contorts a convention to satisfy a
checker.
