---
name: tdd
description: Test-driven development, the red-green loop that produces tests worth keeping. Use whenever the user wants to build a feature or fix a bug test-first, mentions TDD or red-green-refactor, asks for integration or behaviour tests, or asks where a test should go or why a test is brittle. Do NOT use to root-cause a failure whose cause is unknown (`first-principles-investigation`), to review a finished diff (`ocr-review-loop`), or for a throwaway demo (`prototype`).
license: MIT
metadata:
  credits: "Adapted from Matt Pocock's tdd skill, with interface vocabulary from his codebase-design skill, https://github.com/mattpocock/skills (MIT)"
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop
produce tests worth keeping: what a good test is, where tests go, the
anti-patterns, and the rules of the loop. Every section applies on every cycle:
consult them before and during the loop, not after.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Read the domain first

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Glossary** (`docs/agents/domain.md`): name tests and interfaces in the
  project's domain language. Default: `GLOSSARY.md` at the root, or the
  per-context glossaries a root `GLOSSARY-MAP.md` points at.
- **Decision records** (`docs/agents/domain.md`): respect the ones in the area
  you are touching. Default: `docs/adr/`.
- **Conventions folder** (`docs/agents/workspace.md`): any testing charter the
  house keeps (test tiers, naming, where test files live) overrides the
  defaults here. Default: none; follow the tests already in the repository.

Skip any of these that does not exist, silently.

## What a good test is

Tests verify behavior through public interfaces, not implementation details.
Code can change entirely; tests shouldn't. A good test reads like a
specification: "user can checkout with valid cart" tells you exactly what
capability exists, and it survives refactors because it doesn't care about
internal structure.

See [references/tests.md](references/tests.md) for examples and
[references/mocking.md](references/mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe
behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams
under test and confirm them with the user. No test is written at an unconfirmed
seam. You can't test everything, so agreeing the seams up front is how testing
effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?" Give each
proposed seam a one-line note on what it catches and what it misses. Ask the
user, using your structured-question tool if you have one; otherwise list the
seams numbered in plain text and stop until they reply.

When the shape of that interface is itself in question (how deep the module is,
where the seam belongs, what the interface should expose), read
[references/interface-design.md](references/interface-design.md) for the
vocabulary: module, interface, depth, seam, adapter, leverage and locality. It
is a reference to consult, not a session to run. When the question is a hard
design fork rather than vocabulary, the `arch-board` skill deliberates it.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private
  methods, or verifies through a side channel (querying the database instead of
  using the interface). The tell: the test breaks when you refactor but behavior
  hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code
  does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way,
  a constant asserted equal to itself), so it passes by construction and can
  never disagree with the code. Expected values must come from an independent
  source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk
  tests verify _imagined_ behavior: you test the _shape_ of things rather than
  user-facing behavior, the tests go insensitive to real changes, and you commit
  to test structure before understanding the implementation. Work in **vertical
  slices** instead: one test → one implementation → repeat, each test a
  **tracer bullet** that responds to what the last cycle taught you.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
```

## Rules of the loop

- **Red before green.** Write the failing test first, run it, and watch it fail
  for the reason you expect, then write only enough code to pass it. A test you
  never saw fail proves nothing. Don't anticipate future tests or add
  speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per
  cycle.
- **Run the real suite.** Use the test command the repository's agent
  instructions name, or the checks before commit `docs/agents/workspace.md`
  sets; with neither, the one CI runs.
- **Refactoring is not part of the loop.** It belongs to the review stage (the
  repository's code review; `ocr-review-loop` where it is installed), not the
  red → green implementation cycle.

## Checklist per cycle

```
[ ] Test sits at a seam the user confirmed
[ ] Test describes behavior, not implementation
[ ] Expected value comes from an independent source, not the code's own logic
[ ] Test failed first, for the expected reason
[ ] Code is minimal for this test; no speculative features
```
