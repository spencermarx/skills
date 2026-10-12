---
name: write-comments
description: >-
  Write code comments the Ousterhout way AS you author or change code: comment only the
  non-obvious, write interface and header comments first, and let clear names carry the
  rest. Use while implementing a function, class or module, adding or editing a comment,
  writing a doc comment, JSDoc block or docstring, or deciding "should this have a
  comment, and what should it say". Triggers: "add a comment", "document this function",
  "write the header/docstring/JSDoc", "should I comment this", "comment this code". Do NOT
  use to audit comments that already exist (use `clean-comments`).
license: MIT
argument-hint: '[optional: the function, file or module being authored]'
metadata:
  credits: "Principles from John Ousterhout's A Philosophy of Software Design"
---

# Write Comments

Write the comment the code can't write itself, and let everything else be carried
by clear names and structure. The standard is John Ousterhout's, from _A
Philosophy of Software Design_. This is the write-time half of the contract; the
audit-time half is `clean-comments`.

## House conventions, if the repository has them

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`). Default: none. If one is
  configured and holds a comment or code-style convention, read it before you
  write: where it is stricter or more specific than this skill, it wins.

## The one test before you type a comment

> Does this say something a fluent reader cannot already get from the code?

If no, don't write it: fix the name or the structure instead. If yes, write it,
at the right altitude. A comment exists to carry what the code can't: the _why_,
the constraint, the unit, the invariant, the gotcha.

## Write comments first

For any class, method, or exported function, write the **header/interface comment
before the body**. State what it does for the caller, the params, the return, side
effects, thrown errors, and preconditions, in terms _simpler_ than the
implementation, so the reader gets a model without reading the code.

Doing this first is not ceremony: it defines the contract, surfaces design
problems early (if you can't describe it simply, it's doing too much), and
prevents the rushed, redundant comments that "I'll add them later" produces. If
the header can't stay above the algorithm, fix the design rather than narrating
it.

## Comment at the right altitude, by kind

- **Interface** (before a method or class): a simple, intuitive model for the
  caller. Never describe the implementation here; callers want the contract, not
  the mechanism. On exported and public surfaces the contract is required, not
  optional; clear naming does not waive it, and it is the highest-value comment
  for human callers and AI agents alike.
- **Variable / data structure**: be very specific. Exact meaning, **units**,
  ranges, whether a bound is inclusive, whether null is allowed and what it means,
  who owns or frees it. These are the facts a type alone can't carry.
- **Implementation** (inside longer bodies): one line per block saying what it
  accomplishes and **why**, not line-by-line mechanics the code already shows.
- **Cross-module**: the design decision or invariant that spans files; leave it
  where it's most discoverable, and reference it from the other side rather than
  copying.

## Reach for a better name before a comment

If the only reason to comment is to explain an unclear name, rename instead
(`let t` + `// ms` → `let elapsedMs`). Encode units and meaning into names and
types so the code stops needing the footnote. A comment that compensates for a
vague name is a smell.

## Cross-cutting context goes where agents and people load it

Architecture, conventions, gotchas, and rationale that span files don't belong in
an inline comment. They belong in the repository's agent instructions (its
`AGENTS.md` or equivalent), its conventions folder, or, for a settled decision, a
decision record. Inline comments carry _local_ intent; those layers carry the
cross-cutting kind.

## Document each fact once

State it in the one most obvious place closest to the code. Everywhere else,
reference it ("see X"); never copy. Duplicated documentation drifts, and then the
copies disagree.

## Style

Plain and direct; say the why in as few words as carry it. No false precision:
use real ranges, not "roughly" unless it's true. No commented-out code; version
control remembers it. Match the file's existing comment style.

## Before you move on

- Every exported symbol has an interface comment a caller could rely on without
  reading the body.
- Every non-obvious unit, bound, null-meaning, and ownership fact is stated.
- No comment restates its code; no fact is documented twice.
- Anything you were tempted to explain in a comment is instead a clearer name,
  type, or extracted helper where that was the better fix.
