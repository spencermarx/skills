---
name: writing-for-agents
description: >-
  The craft of the prose agents read: skill descriptions and bodies, instructions files
  (AGENTS.md, CLAUDE.md), rule files and reference docs; context pointers, progressive
  disclosure, leading words and pruning. Use whenever wording or rewording any of those,
  deciding what belongs in always-loaded context versus behind a pointer, pruning an
  instructions file that has grown, or asking whether a line is a no-op. Do NOT use to
  build, split, port or test a skill end to end (use `skill-builder`, which loads this), to
  measure whether one fires (`harness-eval`), to state or route a convention (`add-standard`,
  `standards`), or for prose a person reads: a working surface (`conveying-clearly`), a
  byline piece (`draft-argued-piece`), or marketing copy (`seven-copy-critics`).
license: MIT
metadata:
  credits: "Adapted from Matt Pocock's writing-for-agents skill, https://github.com/mattpocock/skills (MIT)"
---

# Writing for agents

A skill description, a line in `AGENTS.md`, and a rule file's glob are the same
object: a **context pointer**. Each names material that is out of context and
states the condition for reaching it. The pointer's wording, not its target,
decides whether it is reached.

That single idea is why descriptions deserve so much care and routers so little.

Paths below are relative to this skill's directory; resolve them to absolute
paths before reading anything.

## Read this before

- Writing or editing any `SKILL.md`, especially its `description`.
- Writing or editing an instructions file at any level: `AGENTS.md` at the
  root or in a folder, or the harness's own equivalent (`CLAUDE.md`, a Copilot or
  Cursor instructions file).
- Adding a convention, or a rule file that points at one.
- Deciding whether something belongs inline or behind a link.

## The material

- **[references/theory.md](references/theory.md)** is the full treatment:
  context pointers, the two loads, the information hierarchy, completion
  criteria, leading words, negation, and pruning. Read it in full the first time.
- **[references/skill-mechanics.md](references/skill-mechanics.md)** covers the
  skill-specific branch: model-invoked versus user-invoked, splitting by
  invocation, and router skills.

## How it maps onto a repository

The theory is harness-neutral. In a repository it lands on these layers:

| Concept | Where it lives |
|---|---|
| Context pointer | a skill's `description`; a line in an instructions file naming a document and when to read it; a rule file's glob (Claude Code's `paths:`, Cursor's `globs:`) |
| Context load | everything always resident: every installed skill's description, plus each instructions file on the path to the file being worked on |
| Cognitive load | what a person must remember exists: the conventions folder's index, every user-invoked skill |
| Progressive disclosure | a skill's `references/`; an instructions file in a subfolder, read only when work happens there; rule files that load when a matching file is read; the conventions folder, reached by one line in `AGENTS.md` |
| Co-location | a script lives in the skill that runs it |
| Sediment | an instructions-file section nobody has pruned, read into every session regardless |
| No-ops | instructions the model already follows by default. Delete the sentence |

House rules about agent-facing prose, including any budgets (a line cap on
`AGENTS.md`, a description cap tighter than the spec's), live in the conventions
folder. This repository's agent configuration should have been provided to you
(the `## Agent skills` block pointing at `docs/agents/`). If it is missing, use
the defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`): read its rules on
  writing for agents before these defaults, and follow them where they differ.
  Default: none.
- **Default budgets:** a description of at most 1024 characters, the Agent
  Skills maximum, where some harnesses truncate; a `SKILL.md` body of at most
  500 lines, with depth in `references/` one level deep.

## The one rule to carry away

**Prompt the positive, never the prohibition.** "Write the owner and the date on
every action item" works. "Don't forget the owner" does not, and reliably
produces the thing it names. Negation is the most common failure in hand-written
agent instructions.
